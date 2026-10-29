use std::collections::HashSet;

use super::dbus::{self, KwinConnection, Properties, RunnerMatch};
use crate::desktop::{
	error::{CoreResult, DesktopError},
	types::{DesktopDisplay, DesktopWindow},
};

pub(super) fn uuid(id: &str) -> CoreResult<&str> {
	let value = id
		.strip_prefix("kwin:")
		.ok_or_else(|| DesktopError::invalid_target("expected a kwin:{uuid} window id"))?;
	let bare = value
		.strip_prefix('{')
		.and_then(|s| s.strip_suffix('}'))
		.unwrap_or(value);
	if bare.len() != 36
		|| !bare.bytes().enumerate().all(|(i, c)| {
			if [8, 13, 18, 23].contains(&i) {
				c == b'-'
			} else {
				c.is_ascii_hexdigit()
			}
		}) {
		return Err(DesktopError::invalid_target("invalid KWin window UUID"));
	}
	Ok(value)
}

pub(super) fn runner_ids(matches: Vec<RunnerMatch>) -> Vec<String> {
	let mut seen = HashSet::new();
	matches
		.into_iter()
		.filter_map(|(id, ..)| {
			let value = id.strip_prefix("0_")?;
			let id = format!("kwin:{value}");
			if uuid(&id).is_ok() && seen.insert(id.clone()) {
				Some(id)
			} else {
				None
			}
		})
		.collect()
}

impl KwinConnection {
	pub fn window(&self, id: &str, active: Option<&str>) -> CoreResult<DesktopWindow> {
		let uuid = uuid(id)?;
		let properties: Properties = self
			.proxy("/KWin", "org.kde.KWin")?
			.call("getWindowInfo", &(uuid,))
			.map_err(dbus::failed)?;
		if properties.is_empty() {
			return Err(DesktopError::window_not_found(format!("KWin window {id} not found")));
		}
		if dbus::boolean(&properties, "excludeFromCapture") {
			return Err(DesktopError::capture_failed(format!(
				"KWin window {id} is excluded from capture"
			)));
		}
		Ok(DesktopWindow {
			id:        id.to_owned(),
			title:     dbus::string(&properties, "caption"),
			app:       dbus::string(&properties, "resourceClass"),
			pid:       dbus::number(&properties, "pid")
				.ok()
				.filter(|pid| *pid > 0.0 && *pid <= f64::from(u32::MAX))
				.map(|pid| pid as u32),
			x:         dbus::number(&properties, "x")?.round() as i32,
			y:         dbus::number(&properties, "y")?.round() as i32,
			width:     dbus::number(&properties, "width")?.round().max(0.0) as u32,
			height:    dbus::number(&properties, "height")?.round().max(0.0) as u32,
			focused:   active == Some(uuid),
			minimized: Some(dbus::boolean(&properties, "minimized")),
		})
	}

	pub fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
		let matches: Vec<RunnerMatch> = self
			.proxy("/WindowsRunner", "org.kde.krunner1")?
			.call("Match", &("",))
			.map_err(dbus::failed)?;
		let active = self.active_window()?;
		let mut windows = Vec::new();
		for id in runner_ids(matches) {
			// A window can close between Match and getWindowInfo. Protected
			// windows are deliberately not exposed as capturable targets.
			if let Ok(window) = self.window(&id, active.as_deref()) {
				windows.push(window);
				if windows.len() == 48 {
					break;
				}
			}
		}
		Ok(windows)
	}

	pub fn displays(&self) -> CoreResult<Vec<DesktopDisplay>> {
		let value = self.script(
			"return workspace.screens.map(function(s) { var g=s.geometry; return \
			 {name:s.name,x:g.x,y:g.y,width:g.width,height:g.height,scale:s.devicePixelRatio}; });",
		)?;
		let screens = value
			.as_array()
			.ok_or_else(|| dbus::failed("invalid output list"))?;
		let min_x = screens
			.iter()
			.filter_map(|s| s["x"].as_f64())
			.fold(f64::INFINITY, f64::min);
		let min_y = screens
			.iter()
			.filter_map(|s| s["y"].as_f64())
			.fold(f64::INFINITY, f64::min);
		let mut displays = Vec::new();
		// Composite output pixels use the largest output scale, like X11's
		// root frame, preserving monitor placement across mixed-DPI layouts.
		let composite_scale = screens
			.iter()
			.filter_map(|s| s["scale"].as_f64())
			.fold(1.0_f64, f64::max);
		for (index, screen) in screens.iter().enumerate() {
			let n = |name: &str| {
				screen[name]
					.as_f64()
					.filter(|n| n.is_finite())
					.ok_or_else(|| dbus::failed(format!("invalid output {name}")))
			};
			let name = screen["name"]
				.as_str()
				.ok_or_else(|| dbus::failed("output missing name"))?
				.to_owned();
			let (x, y, width, height, scale) =
				(n("x")?, n("y")?, n("width")?, n("height")?, n("scale")?);
			if width <= 0.0 || height <= 0.0 || scale <= 0.0 {
				return Err(dbus::failed("invalid KWin output geometry"));
			}
			let (pixel_width, pixel_height) = self
				.pixel_sizes
				.borrow()
				.get(&name)
				.filter(|(pw, ph, ps)| {
					(*ps - scale).abs() < 0.001
						&& (f64::from(*pw) / scale).round() == width.round()
						&& (f64::from(*ph) / scale).round() == height.round()
				})
				.map_or_else(
					|| ((width * scale).round() as u32, (height * scale).round() as u32),
					|(pw, ph, _)| (*pw, *ph),
				);
			displays.push(DesktopDisplay {
				id: name.clone(),
				name,
				x: x.round() as i32,
				y: y.round() as i32,
				width: width.round() as u32,
				height: height.round() as u32,
				scale,
				pixel_x: ((x - min_x) * composite_scale).round() as u32,
				pixel_y: ((y - min_y) * composite_scale).round() as u32,
				pixel_width,
				pixel_height,
				is_primary: index == 0,
			});
		}
		if displays.is_empty() {
			return Err(dbus::failed("KWin has no outputs"));
		}
		Ok(displays)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	const UUID: &str = "{01234567-89ab-cdef-0123-456789abcdef}";
	#[test]
	fn parses_window_ids() {
		assert_eq!(uuid(&format!("kwin:{UUID}")).unwrap(), UUID);
		for invalid in
			["12", "kwin:", "kwin:{../../tmp}", "kwin:01234567-89ab-cdef-0123-456789abcdeg"]
		{
			assert!(uuid(invalid).is_err());
		}
	}
	#[test]
	fn deduplicates_runner_results() {
		let entry = |id: String| (id, String::new(), String::new(), 100, 0.8, Properties::new());
		assert_eq!(
			runner_ids(vec![
				entry(format!("0_{UUID}")),
				entry(format!("0_{UUID}")),
				entry("1_close".into()),
				entry("0_bad".into())
			]),
			vec![format!("kwin:{UUID}")]
		);
	}
}
