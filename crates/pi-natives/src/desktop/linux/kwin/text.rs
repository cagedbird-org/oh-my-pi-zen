use zbus::blocking::{Connection, Proxy};

use super::KwinBackend;
use crate::desktop::{
	ax::AxHandle,
	backend::{AxBackend, Backend, DeliveryMode},
	control,
	error::{CoreResult, DesktopError},
	keys::KeyName,
	types::{DesktopWindow, Target},
};

const TERMINALS: &[&str] = &[
	"org.kde.konsole",
	"org.kde.yakuake",
	"konsole",
	"kitty",
	"alacritty",
	"foot",
	"org.wezfurlong.wezterm",
	"wezterm",
	"com.mitchellh.ghostty",
	"ghostty",
	"gnome-terminal-server",
	"org.gnome.terminal",
	"org.gnome.ptyxis",
];
fn paste_keys(app: &str) -> Vec<KeyName> {
	if TERMINALS
		.iter()
		.any(|terminal| app.eq_ignore_ascii_case(terminal))
	{
		vec![KeyName::Ctrl, KeyName::Shift, KeyName::Char('v')]
	} else {
		vec![KeyName::Ctrl, KeyName::Char('v')]
	}
}

/// The only entry for `KWin` text policy, including element-addressed typing.
pub(super) fn type_text(
	backend: &mut KwinBackend,
	target: &Target,
	value: &str,
	mode: DeliveryMode,
	element: Option<&AxHandle>,
) -> CoreResult<()> {
	control::check()?;
	if value.is_empty() {
		return Ok(());
	}
	let active = backend.bus.active_window()?;
	let window = match target {
		Target::Window(id) => backend.bus.window(id, active.as_deref())?,
		_ => backend.focused_keyboard_window()?,
	};
	let ax_reason = if let Some(ax) = backend.ax.as_mut() {
		match ax.insert_text(&window, element, value)? {
			super::super::ax::TextInsertion::Inserted => return Ok(()),
			super::super::ax::TextInsertion::Unavailable(reason) => reason,
		}
	} else {
		backend
			.ax_error
			.as_ref()
			.map_or_else(|| "accessibility connection is unavailable".into(), ToString::to_string)
	};
	let mut reasons = vec![format!("AT-SPI: {ax_reason}")];
	if window.app == "org.kde.konsole" {
		match konsole_session(&backend.bus.connection, &window, &backend.bus.windows()?) {
			Ok(Some(path)) => {
				control::check()?;
				let service = format!("org.kde.konsole-{}", window.pid.unwrap_or_default());
				let sent = Proxy::new(
					&backend.bus.connection,
					service.as_str(),
					path.as_str(),
					"org.kde.konsole.Session",
				)
				.and_then(|proxy| proxy.call::<_, _, ()>("sendText", &(value,)));
				match sent {
					Ok(()) => return Ok(()),
					Err(zbus::Error::MethodError(name, detail, _))
						if name.as_str() == "org.freedesktop.DBus.Error.AccessDenied" =>
					{
						reasons.push(format!(
							"Konsole: sendText explicitly denied: {}",
							detail.unwrap_or_default()
						));
					},
					Err(error) => {
						return Err(DesktopError::input_failed(format!(
							"Konsole sendText outcome unknown; do not retry: {error}"
						)));
					},
				}
			},
			Ok(None) => {
				reasons.push("Konsole: window/session association is ambiguous or unavailable".into());
			},
			Err(error) => reasons.push(format!("Konsole: {error}")),
		}
	} else {
		reasons.push("Konsole: target is not org.kde.konsole".into());
	}
	let connection = backend.bus.connection.clone();
	let display = backend.wayland_display.clone();
	let nested = backend.nested;
	let delivery_target = Target::Window(window.id.clone());
	let uuid = super::windows::uuid(&window.id)?;
	backend.run_input(&delivery_target, mode, true, |input, ax, bus| {
		if let (Some(element), Some(ax)) = (element, ax) {
			ax.focus(element)?;
		}
		match input.prepare_text(value) {
			Ok(prepared) => with_fcitx(&connection, !nested, || {
				bus.require_active(uuid)?;
				input.type_prepared_text(prepared)
			}),
			Err(error) => {
				control::check()?;
				reasons.push(format!("EIS: {error}"));
				let display = display.as_deref().ok_or_else(|| {
					DesktopError::input_failed(format!(
						"{}; clipboard: target waylandDisplay is unavailable",
						reasons.join("; ")
					))
				})?;
				let keys = paste_keys(&window.app);
				super::clipboard::with_text_clipboard(Some(display), value, || {
					bus.require_active(uuid)?;
					input.key_chord(&keys)
				})
				.map_err(|error| clipboard_error_context(error, &reasons))
			},
		}
	})
}

fn clipboard_error_context(mut error: DesktopError, reasons: &[String]) -> DesktopError {
	error.message = format!("{}; clipboard: {}", reasons.join("; "), error.message);
	error
}

fn child_paths(xml: &str, prefix: &str) -> Vec<String> {
	xml.split("<node name=\"")
		.skip(1)
		.filter_map(|rest| {
			let name = rest.split('"').next()?;
			name.parse::<u32>().ok().map(|_| format!("{prefix}/{name}"))
		})
		.collect()
}
fn konsole_session(
	connection: &Connection,
	window: &DesktopWindow,
	windows: &[DesktopWindow],
) -> CoreResult<Option<String>> {
	let Some(pid) = window.pid else {
		return Ok(None);
	};
	let service = format!("org.kde.konsole-{pid}");
	let xml: String =
		Proxy::new(connection, service.as_str(), "/Windows", "org.freedesktop.DBus.Introspectable")
			.and_then(|proxy| proxy.call("Introspect", &()))
			.map_err(|e| DesktopError::input_failed(e.to_string()))?;
	let paths = child_paths(&xml, "/Windows");
	let only = paths.len() == 1
		&& windows
			.iter()
			.filter(|candidate| candidate.pid == Some(pid))
			.count()
			== 1;
	let mut matches = Vec::new();
	for path in paths {
		let session: i32 =
			Proxy::new(connection, service.as_str(), path.as_str(), "org.kde.konsole.Window")
				.and_then(|proxy| proxy.call("currentSession", &()))
				.map_err(|e| DesktopError::input_failed(e.to_string()))?;
		let path = format!("/Sessions/{session}");
		let title: String =
			Proxy::new(connection, service.as_str(), path.as_str(), "org.kde.konsole.Session")
				.and_then(|proxy| proxy.call("title", &(1_i32,)))
				.map_err(|e| DesktopError::input_failed(e.to_string()))?;
		let caption = window
			.title
			.strip_suffix(" — Konsole")
			.unwrap_or(&window.title);
		if only || (!title.is_empty() && caption == title) {
			matches.push(path);
		}
	}
	Ok(if matches.len() == 1 {
		matches.pop()
	} else {
		None
	})
}

fn with_fcitx(
	connection: &Connection,
	host: bool,
	action: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	let owner = host
		&& zbus::blocking::fdo::DBusProxy::new(connection)
			.ok()
			.and_then(|dbus| {
				dbus
					.name_has_owner("org.fcitx.Fcitx5".try_into().ok()?)
					.ok()
			})
			.unwrap_or(false);
	if !owner {
		return action();
	}
	let proxy =
		Proxy::new(connection, "org.fcitx.Fcitx5", "/controller", "org.fcitx.Fcitx.Controller1")
			.map_err(|e| DesktopError::input_failed(format!("fcitx controller: {e}")))?;
	let state: i32 = proxy
		.call("State", &())
		.map_err(|e| DesktopError::input_failed(format!("fcitx State: {e}")))?;
	with_deactivated(
		state == 2,
		|| {
			proxy
				.call::<_, _, ()>("Deactivate", &())
				.map_err(|e| DesktopError::input_failed(format!("fcitx Deactivate: {e}")))
		},
		|| {
			proxy
				.call::<_, _, ()>("Activate", &())
				.map_err(|e| DesktopError::input_failed(format!("fcitx Activate: {e}")))
		},
		action,
	)
}
fn with_deactivated(
	active: bool,
	deactivate: impl FnOnce() -> CoreResult<()>,
	activate: impl FnOnce() -> CoreResult<()>,
	action: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	if !active {
		return action();
	}
	control::check()?;
	let result = deactivate().and_then(|()| action());
	let restored = control::cleanup(|| {
		// EIS flush is not consumption acknowledgement. Keep the IM disabled
		// while the compositor/toolkit drains even a partially failed delivery.
		std::thread::sleep(std::time::Duration::from_millis(150));
		activate()
	});
	match (result, restored) {
		(Ok(()), Ok(())) => Ok(()),
		(Err(error), Ok(())) => Err(error),
		(result, Err(error)) => Err(DesktopError::input_failed(format!(
			"{}; restoring fcitx failed: {error}",
			result
				.err()
				.map_or_else(|| "text delivered".into(), |error| error.to_string())
		))),
	}
}
#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn clipboard_diagnostics_preserve_delivery_error_codes() {
		use crate::desktop::error::ErrorCode;
		for code in [ErrorCode::BackgroundUnavailable, ErrorCode::Cancelled, ErrorCode::InputFailed] {
			let error =
				clipboard_error_context(DesktopError::new(code, "original clipboard error"), &[
					"AT-SPI unavailable".into(),
					"EIS layout unavailable".into(),
				]);
			assert_eq!(error.code, code);
			assert!(
				error
					.to_string()
					.starts_with(&format!("{}:", code.as_str()))
			);
			assert!(error.message.contains(
				"AT-SPI unavailable; EIS layout unavailable; clipboard: original clipboard error"
			));
		}
	}

	#[test]
	fn terminal_paste_shortcuts() {
		assert_eq!(paste_keys("org.kde.konsole"), vec![
			KeyName::Ctrl,
			KeyName::Shift,
			KeyName::Char('v')
		]);
		assert_eq!(paste_keys("ALACRITTY"), paste_keys("foot"));
		assert_eq!(paste_keys("org.kde.kwrite"), vec![KeyName::Ctrl, KeyName::Char('v')]);
	}
	#[test]
	fn fcitx_restores_after_success_and_failure() {
		for fails in [false, true] {
			let events = std::cell::RefCell::new(Vec::new());
			let started = std::time::Instant::now();
			let result = with_deactivated(
				true,
				|| {
					events.borrow_mut().push("deactivate");
					Ok(())
				},
				|| {
					assert!(started.elapsed() >= std::time::Duration::from_millis(150));
					events.borrow_mut().push("activate");
					Ok(())
				},
				|| {
					events.borrow_mut().push("type");
					if fails {
						Err(DesktopError::input_failed("typing failed"))
					} else {
						Ok(())
					}
				},
			);
			assert_eq!(events.into_inner(), vec!["deactivate", "type", "activate"]);
			assert_eq!(result.is_err(), fails);
		}
	}
	#[test]
	fn failed_deactivation_still_restores() {
		let restored = std::cell::Cell::new(false);
		assert!(
			with_deactivated(
				true,
				|| Err(DesktopError::input_failed("deactivate failed")),
				|| {
					restored.set(true);
					Ok(())
				},
				|| panic!("must not type after failed deactivate")
			)
			.is_err()
		);
		assert!(restored.get());
	}
	#[test]
	fn inactive_input_method_is_untouched() {
		with_deactivated(
			false,
			|| panic!("unexpected deactivate"),
			|| panic!("unexpected activate"),
			|| Ok(()),
		)
		.unwrap();
	}
	#[test]
	fn parses_konsole_window_children() {
		assert_eq!(
			child_paths("<node><node name=\"1\"/><node name=\"2\"/></node>", "/Windows"),
			vec!["/Windows/1", "/Windows/2"]
		);
	}
}
