mod capture;
mod clipboard;
mod dbus;
mod text;
mod windows;

use std::time::Duration;

use dbus::KwinConnection;
use image::{Rgba, RgbaImage};
use zbus::zvariant::OwnedFd;

use super::{ax::AtSpiAx, wayland::libei::Libei};
use crate::desktop::{
	ax::AxHandle,
	backend::{AxBackend, Backend, DeliveryMode, ElementDelivery, ElementInput, PointerEvent},
	control::{self, OperationToken},
	error::{CoreResult, DesktopError},
	frame::{FrameGeometry, compose},
	keys::KeyName,
	menus::DesktopMenuItem,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopSessionOptions, DesktopWindow,
		DisplaySelector, Target,
	},
};

pub(super) fn available() -> bool {
	zbus::blocking::Connection::session()
		.ok()
		.and_then(|connection| {
			zbus::blocking::fdo::DBusProxy::new(&connection)
				.ok()?
				.name_has_owner("org.kde.KWin".try_into().ok()?)
				.ok()
		})
		.unwrap_or(false)
}

struct Input {
	libei:    Libei,
	// Fields drop in declaration order: release devices before disconnect(cookie).
	_session: EisSession,
}
struct EisSession {
	connection: zbus::blocking::Connection,
	cookie:     i32,
}
impl Drop for EisSession {
	fn drop(&mut self) {
		if let Ok(proxy) = zbus::blocking::Proxy::new(
			&self.connection,
			"org.kde.KWin",
			"/org/kde/KWin/EIS/RemoteDesktop",
			"org.kde.KWin.EIS.RemoteDesktop",
		) {
			let _: zbus::Result<()> = proxy.call("disconnect", &(self.cookie,));
		}
	}
}

pub struct KwinBackend {
	bus:             KwinConnection,
	display:         DisplaySelector,
	ax:              Option<AtSpiAx>,
	ax_error:        Option<DesktopError>,
	input:           Option<Input>,
	wayland_display: Option<String>,
	nested:          bool,
}
impl KwinBackend {
	pub fn new(display: DisplaySelector, options: &DesktopSessionOptions) -> CoreResult<Self> {
		// All compositor operations (including EIS) are bus-scoped. No host
		// WAYLAND_DISPLAY or process environment mutation is required.
		if options
			.wayland_display
			.as_ref()
			.is_some_and(|display| display.is_empty())
		{
			return Err(DesktopError::invalid_target("waylandDisplay must not be empty"));
		}
		let bus = KwinConnection::new(options.kwin_bus_address.as_deref())?;
		let initialized = initialize_host_accessibility(
			options.kwin_bus_address.is_none(),
			|| bus.accessibility_enabled(),
			|| bus.enable_accessibility(),
		)
		.and_then(|()| AtSpiAx::for_session(&bus.connection));
		let (ax, ax_error) = match initialized {
			Ok(ax) => (Some(ax), None),
			Err(error) => (None, Some(error)),
		};
		Ok(Self {
			bus,
			display,
			ax,
			ax_error,
			input: None,
			wayland_display: options.wayland_display.clone().or_else(|| {
				if options.kwin_bus_address.is_some() {
					None
				} else {
					std::env::var("WAYLAND_DISPLAY").ok()
				}
			}),
			nested: options.kwin_bus_address.is_some(),
		})
	}

	fn atspi(&mut self) -> CoreResult<&mut AtSpiAx> {
		self.ax.as_mut().ok_or_else(|| {
			self
				.ax_error
				.clone()
				.unwrap_or_else(DesktopError::ax_unsupported)
		})
	}

	fn ensure_input(&mut self) -> CoreResult<()> {
		if self.input.is_some() {
			return Ok(());
		}
		// KWin eisbackend.cpp: portal device mask 1 = keyboard, 2 = pointer
		// (relative + absolute + buttons + scroll). No portal is involved.
		let (fd, cookie): (OwnedFd, i32) = self
			.bus
			.proxy("/org/kde/KWin/EIS/RemoteDesktop", "org.kde.KWin.EIS.RemoteDesktop")?
			.call("connectToEIS", &(3_i32,))
			.map_err(|error| DesktopError::input_failed(format!("KWin connectToEIS: {error}")))?;
		let session = EisSession { connection: self.bus.connection.clone(), cookie };
		let libei = Libei::from_fd(fd.into())?;
		self.input = Some(Input { libei, _session: session });
		Ok(())
	}

	fn run_input(
		&mut self,
		target: &Target,
		mode: DeliveryMode,
		allow_active_background: bool,
		action: impl FnOnce(&mut Libei, Option<&mut AtSpiAx>, &KwinConnection) -> CoreResult<()>,
	) -> CoreResult<()> {
		control::check()?;
		if matches!(target, Target::Window(_))
			&& mode == DeliveryMode::Background
			&& !allow_active_background
		{
			return Err(DesktopError::background_unavailable(
				"KWin window input requires takeover: true; use accessibility actions for background \
				 operation",
			));
		}
		// Establish the connection before activation; discovery need not steal
		// focus.
		self.ensure_input()?;
		// Record restoration responsibility before activation: confirmation may
		// fail or be cancelled after KWin already changed the active window.
		let previous = if matches!(target, Target::Window(_)) && mode != DeliveryMode::Background {
			Some(self.bus.active_window()?)
		} else {
			None
		};
		let result = (|| {
			if let Target::Window(id) = target {
				let uuid = windows::uuid(id)?;
				if mode != DeliveryMode::Background {
					self.bus.activate(uuid)?;
				}
				self.bus.require_active(uuid)?;
			}
			action(
				&mut self
					.input
					.as_mut()
					.ok_or_else(|| DesktopError::input_failed("KWin EIS not initialized"))?
					.libei,
				self.ax.as_mut(),
				&self.bus,
			)
		})();
		if let Ok(Some(active)) = self.bus.active_window()
			&& let (Some(ax), Ok(window)) =
				(self.ax.as_mut(), self.bus.window(&format!("kwin:{active}"), Some(&active)))
		{
			let _ = ax.window_root(&window);
		}
		if self
			.input
			.as_ref()
			.is_some_and(|input| input.libei.disconnected())
		{
			self.input = None;
		}
		restore_after_input(result, || {
			if let (Target::Window(id), Some(Some(previous))) = (target, previous) {
				// Give toolkits a beat to consume queued input. Restore only if no
				// third window took focus in the meantime, as on X11.
				std::thread::sleep(Duration::from_millis(150));
				let current = self.bus.active_window()?;
				if current.as_deref() == Some(windows::uuid(id)?)
					&& current.as_deref() != Some(previous.as_str())
				{
					self.bus.activate(&previous)?;
				}
			}
			Ok(())
		})
	}
}

impl Backend for KwinBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		DesktopCapabilities {
			backend: "kwin".into(),
			display_server: Some("wayland".into()),
			capture: true,
			input: true,
			ax: self.ax.is_some(),
			background_window_input: false,
			takeover: true,
			applications: crate::desktop::applications::supported(),
			menus: self.ax.is_some(),
			held_input: true,
			spaces: false,
			global_escape: false,
			capture_permission: "granted".into(),
			input_permission: "granted".into(),
			ax_permission: if self.ax.is_some() {
				"granted"
			} else {
				"unavailable"
			}
			.into(),
			display_count: self.bus.displays().map_or(0, |d| d.len() as u32),
			screen_locked: false,
			display_asleep: false,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		self.bus.displays()
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		self.bus.windows()
	}

	fn focused_keyboard_window(&mut self) -> CoreResult<DesktopWindow> {
		let uuid = self
			.bus
			.active_window()?
			.ok_or_else(|| DesktopError::invalid_target("KWin has no active window"))?;
		self.bus.window(&format!("kwin:{uuid}"), Some(&uuid))
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		control::check()?;
		if let Target::Window(id) = target {
			let window = self.bus.window(id, None)?;
			if window.minimized == Some(true) {
				return Err(DesktopError::capture_failed(format!(
					"KWin window {id} is minimized; raise it before capturing"
				)));
			}
			let capture = self.bus.capture(Some(windows::uuid(id)?), None)?;
			// Decoration is included, shadows excluded: getWindowInfo's frame
			// geometry is exactly the logical coordinate rectangle of this image.
			let expected =
				(f64::from(window.width) * capture.scale, f64::from(window.height) * capture.scale);
			if (f64::from(capture.image.width()) - expected.0).abs() > 2.0
				|| (f64::from(capture.image.height()) - expected.1).abs() > 2.0
			{
				return Err(DesktopError::capture_failed(
					"KWin window geometry changed during capture; capture again",
				));
			}
			let frame =
				FrameGeometry::for_window(&window, capture.image.width(), capture.image.height());
			return Ok((capture.image, frame));
		}
		let focused = self.focused_keyboard_window().ok();
		let explicit = target.display_selector();
		let mut selected = selector
			.or(explicit.as_ref())
			.unwrap_or(&self.display)
			.select(self.bus.displays()?, focused.as_ref())?;
		if selected.len() == 1 {
			selected[0].pixel_x = 0;
			selected[0].pixel_y = 0;
		}
		let mut tiles = Vec::with_capacity(selected.len());
		for display in &mut selected {
			let capture = self.bus.capture(None, Some(&display.name))?;
			// KWin rounds logical output geometry; the screenshot is authoritative
			// for native pixels (e.g. 2560 / 1.5 rounds to 1707 logical pixels).
			if (capture.scale - display.scale).abs() > 0.001
				|| (f64::from(capture.image.width()) / capture.scale).round()
					!= f64::from(display.width)
				|| (f64::from(capture.image.height()) / capture.scale).round()
					!= f64::from(display.height)
			{
				return Err(DesktopError::capture_failed(
					"KWin output geometry changed during capture; capture again",
				));
			}
			display.pixel_width = capture.image.width();
			display.pixel_height = capture.image.height();
			tiles.push(Ok((capture.image, display.pixel_x, display.pixel_y)));
		}
		let frame = FrameGeometry::for_displays(&selected);
		let (width, height) = frame.dimensions();
		let image = compose(width, height, Rgba([0, 0, 0, 255]), tiles)?;
		Ok((image, frame))
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, mode, false, |input, _ax, _bus| input.pointer(event))
	}

	fn type_text(
		&mut self,
		target: &Target,
		value: &str,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		text::type_text(self, target, value, mode, None)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, mode, false, |input, _ax, _bus| input.key_chord(keys))
	}

	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: Duration,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, mode, false, |input, _ax, _bus| input.hold_keys(keys, duration))
	}

	fn element_input(
		&mut self,
		element: &AxHandle,
		input: &ElementInput,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		token.check()?;
		let windows = self.windows()?;
		let target = Target::Window(
			self
				.ax
				.as_mut()
				.ok_or_else(DesktopError::ax_unsupported)?
				.window_id(element, &windows)?,
		);
		// Refuse background delivery before asking the target to change focus.
		if let ElementInput::Text(value) = input {
			text::type_text(self, &target, value, mode, Some(element))?;
			return Ok(ElementDelivery::Delivered);
		}
		self.run_input(&target, mode, false, |libei, ax, _bus| {
			ax.ok_or_else(DesktopError::ax_unsupported)?
				.focus(element)?;
			match input {
				ElementInput::Text(_) => unreachable!("text routed through KWin text policy"),
				ElementInput::Chord(keys) => libei.key_chord(keys),
			}
		})?;
		Ok(ElementDelivery::Delivered)
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<DesktopMenuItem>> {
		self.atspi()?.menu_items(window, path)
	}

	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.atspi()?.menu_select(window, path)
	}

	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
		self.bus.activate(windows::uuid(id)?)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}

	fn ax_result(&mut self) -> CoreResult<&mut dyn AxBackend> {
		self.atspi().map(|ax| ax as &mut dyn AxBackend)
	}
}

fn initialize_host_accessibility(
	host: bool,
	read_enabled: impl FnOnce() -> CoreResult<bool>,
	enable: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	if host && !read_enabled()? {
		enable()?;
	}
	Ok(())
}

fn restore_after_input(
	result: CoreResult<()>,
	restore: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	let restored = control::cleanup(restore);
	match (result, restored) {
		(Ok(()), Ok(())) => Ok(()),
		(Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
		(Err(error), Err(restore)) => {
			Err(DesktopError::input_failed(format!("{error}; focus restoration failed: {restore}")))
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn host_accessibility_status_policy() {
		for (host, enabled, expected_reads, expected_writes) in
			[(true, false, 1, 1), (true, true, 1, 0), (false, false, 0, 0), (false, true, 0, 0)]
		{
			let reads = std::cell::Cell::new(0);
			let writes = std::cell::Cell::new(0);
			initialize_host_accessibility(
				host,
				|| {
					reads.set(reads.get() + 1);
					Ok(enabled)
				},
				|| {
					writes.set(writes.get() + 1);
					Ok(())
				},
			)
			.unwrap();
			assert_eq!(reads.get(), expected_reads);
			assert_eq!(writes.get(), expected_writes);
		}
		let read_error = initialize_host_accessibility(
			true,
			|| Err(DesktopError::ax_failed("status read failed")),
			|| panic!("must not write after read failure"),
		)
		.unwrap_err();
		assert_eq!(read_error.message, "status read failed");
		let write_error = initialize_host_accessibility(
			true,
			|| Ok(false),
			|| Err(DesktopError::ax_failed("status write failed")),
		)
		.unwrap_err();
		assert_eq!(write_error.message, "status write failed");
	}
	#[test]
	fn activation_error_still_returns_focus() {
		let active = std::cell::Cell::new("original");
		let result = (|| {
			active.set("target");
			Err(DesktopError::input_failed("activation confirmation cancelled"))
		})();
		assert!(
			restore_after_input(result, || {
				active.set("original");
				Ok(())
			})
			.is_err()
		);
		assert_eq!(active.get(), "original");
	}
}
