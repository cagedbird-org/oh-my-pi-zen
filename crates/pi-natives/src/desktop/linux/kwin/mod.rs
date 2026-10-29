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
		if self
			.input
			.as_ref()
			.is_some_and(|input| !input.libei.disconnected())
		{
			return Ok(());
		}
		self.input = None;
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
}
fn background_window_input_allowed(
	nested: bool,
	mode: DeliveryMode,
	allow_active_background: bool,
) -> bool {
	mode != DeliveryMode::Background || nested || allow_active_background
}

fn prepare_window_input(
	nested: bool,
	mode: DeliveryMode,
	activate: impl FnOnce() -> CoreResult<()>,
	confirm: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	if nested || mode != DeliveryMode::Background {
		activate()?;
	}
	confirm()
}

fn should_reconnect_input(result: &CoreResult<()>) -> bool {
	result.as_ref().is_err_and(|error| error.input_not_sent)
}

fn run_input_reconnecting<C>(
	context: &mut C,
	mut run: impl FnMut(&mut C) -> CoreResult<()>,
	reconnect: impl FnOnce(&mut C) -> CoreResult<()>,
) -> CoreResult<()> {
	let result = run(context);
	if should_reconnect_input(&result) {
		reconnect(context)?;
		run(context)
	} else {
		result
	}
}

fn should_restore_focus(
	target: &str,
	app: &str,
	pid: Option<u32>,
	current: Option<&str>,
	known: &std::collections::HashSet<String>,
	windows: &[DesktopWindow],
) -> bool {
	let Some(current) = current else {
		return false;
	};
	current == target
		|| (!known.contains(&format!("kwin:{current}"))
			&& windows
				.iter()
				.find(|w| w.id.strip_prefix("kwin:") == Some(current))
				.is_some_and(|w| w.app == app || pid.is_some() && w.pid == pid))
}

impl KwinBackend {
	fn prepare_window_target(&self, target: &Target, mode: DeliveryMode) -> CoreResult<()> {
		if let Target::Window(id) = target {
			let uuid = windows::uuid(id)?;
			prepare_window_input(
				self.nested,
				mode,
				|| {
					if !self.nested || self.bus.active_window()?.as_deref() != Some(uuid) {
						self.bus.activate(uuid)?;
					}
					Ok(())
				},
				|| self.bus.require_active(uuid),
			)?;
		}
		Ok(())
	}

	fn run_input_once(
		&mut self,
		target: &Target,
		mode: DeliveryMode,
		action: &mut impl FnMut(&mut Libei, Option<&mut AtSpiAx>, &KwinConnection) -> CoreResult<()>,
	) -> CoreResult<()> {
		self.prepare_window_target(target, mode)?;
		action(
			&mut self
				.input
				.as_mut()
				.ok_or_else(|| DesktopError::input_failed("KWin EIS not initialized"))?
				.libei,
			self.ax.as_mut(),
			&self.bus,
		)
	}
}

impl KwinBackend {
	fn run_input(
		&mut self,
		target: &Target,
		mode: DeliveryMode,
		allow_active_background: bool,
		action: impl FnMut(&mut Libei, Option<&mut AtSpiAx>, &KwinConnection) -> CoreResult<()>,
	) -> CoreResult<()> {
		control::check()?;
		if matches!(target, Target::Window(_))
			&& !background_window_input_allowed(self.nested, mode, allow_active_background)
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
		let (previous, takeover_target) =
			if let (Target::Window(id), false) = (target, mode == DeliveryMode::Background) {
				let previous = self.bus.active_window()?;
				let target_window = self.bus.window(id, previous.as_deref())?;
				let known: std::collections::HashSet<String> = self
					.bus
					.windows()
					.unwrap_or_default()
					.into_iter()
					.map(|window| window.id)
					.collect();
				(
					Some(previous),
					Some((windows::uuid(id)?.to_owned(), target_window.app, target_window.pid, known)),
				)
			} else {
				(None, None)
			};
		let transient_watch = takeover_target
			.as_ref()
			.map(|(uuid, ..)| self.bus.watch_transient(uuid))
			.transpose()?
			.flatten();
		let mut action = action;
		let result = run_input_reconnecting(
			self,
			|backend| backend.run_input_once(target, mode, &mut action),
			|backend| {
				backend.input = None;
				backend.ensure_input()
			},
		);
		restore_after_input(result, || {
			if let (Some((target_uuid, target_app, target_pid, known)), Some(Some(previous))) =
				(takeover_target.as_ref(), previous.as_ref())
			{
				// Give toolkits a beat to consume queued input. Restore only if no
				// third window took focus in the meantime, as on X11.
				std::thread::sleep(Duration::from_millis(150));
				let current = self.bus.active_window()?;
				let restore = should_restore_focus(
					target_uuid,
					target_app,
					*target_pid,
					current.as_deref(),
					known,
					&self.bus.windows()?,
				) || transient_watch
					.as_ref()
					.is_some_and(|watch| watch.returned_to_parent(current.as_deref()));
				if restore
					&& current.as_deref() != Some(previous.as_str())
					&& let Some(current) = current.as_deref()
				{
					self.bus.activate_if_active(previous, current)?;
				}
				let observed = self.bus.active_window()?;
				let front_pid = observed
					.as_deref()
					.and_then(|id| self.bus.window(&format!("kwin:{id}"), Some(id)).ok()?.pid);
				let previous_pid = self
					.bus
					.window(&format!("kwin:{previous}"), None)
					.ok()
					.and_then(|w| w.pid);
				control::report_focus_return(crate::desktop::types::DesktopFocusReturn {
					handed_back: observed.as_deref() == Some(previous.as_str()),
					previous_pid,
					front_pid,
				});
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
			background_window_input: self.nested,
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
		self.run_input(target, mode, false, |input, _ax, _bus| input.pointer(event.clone()))
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
		self.run_input(target, mode, false, |input, _ax, bus| {
			input.key_chord_checked(keys, || {
				if let Target::Window(id) = target {
					bus.require_active(windows::uuid(id)?)?;
				}
				Ok(())
			})
		})
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
		self.run_input(&target, mode, false, |libei, ax, bus| {
			ax.ok_or_else(DesktopError::ax_unsupported)?
				.focus(element)?;
			match input {
				ElementInput::Text(_) => unreachable!("text routed through KWin text policy"),
				ElementInput::Chord(keys) => libei.key_chord_checked(keys, || {
					let Target::Window(id) = &target else {
						unreachable!("element window target")
					};
					bus.require_active(windows::uuid(id)?)
				}),
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

	fn raise_window_if_active(
		&mut self,
		id: &str,
		expected: &str,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self
			.bus
			.activate_if_active(windows::uuid(id)?, windows::uuid(expected)?)
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
	#[test]
	fn closed_target_does_not_override_user_selected_existing_sibling() {
		let sibling = DesktopWindow {
			id:        "kwin:sibling".into(),
			app:       "editor".into(),
			title:     "Other".into(),
			pid:       Some(10),
			x:         0,
			y:         0,
			width:     100,
			height:    100,
			focused:   true,
			minimized: None,
		};
		let known = ["kwin:target".into(), sibling.id.clone()]
			.into_iter()
			.collect();
		assert!(!should_restore_focus(
			"target",
			"editor",
			Some(10),
			Some("sibling"),
			&known,
			std::slice::from_ref(&sibling)
		));
		let popup = DesktopWindow { id: "kwin:new-popup".into(), ..sibling };
		assert!(should_restore_focus("target", "editor", Some(10), Some("new-popup"), &known, &[
			popup
		]));
		assert!(should_restore_focus("target", "editor", Some(10), Some("target"), &known, &[]));
	}
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

	#[test]
	fn nested_background_keyboard_activates_and_confirms_before_delivery() {
		use std::cell::Cell;
		for (nested, mode, success) in [
			(true, DeliveryMode::Background, true),
			(false, DeliveryMode::Background, false),
			(false, DeliveryMode::Foreground, true),
		] {
			let active = Cell::new("new-window");
			let activations = Cell::new(0);
			let delivered = Cell::new(0);
			let result = prepare_window_input(
				nested,
				mode,
				|| {
					activations.set(activations.get() + 1);
					active.set("original-window");
					Ok(())
				},
				|| {
					if active.get() != "original-window" {
						return Err(DesktopError::background_unavailable("target is inactive"));
					}
					Ok(())
				},
			)
			.map(|()| delivered.set(delivered.get() + 1));
			assert_eq!(result.is_ok(), success);
			assert_eq!(activations.get(), usize::from(success));
			assert_eq!(delivered.get(), usize::from(success));
		}
		let delivered = Cell::new(false);
		let result = prepare_window_input(
			true,
			DeliveryMode::Background,
			|| Ok(()),
			|| Err(DesktopError::input_failed("activation not confirmed")),
		)
		.map(|()| delivered.set(true));
		assert!(result.is_err());
		assert!(!delivered.get());
	}

	#[test]
	fn nested_window_input_skips_host_takeover_refusal() {
		assert!(!background_window_input_allowed(false, DeliveryMode::Background, false));
		assert!(background_window_input_allowed(true, DeliveryMode::Background, false));
		assert!(background_window_input_allowed(false, DeliveryMode::Background, true));
		assert!(background_window_input_allowed(false, DeliveryMode::Foreground, false));
	}
}
