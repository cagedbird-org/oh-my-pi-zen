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

#[derive(Debug, PartialEq, Eq)]
enum TextPart<'a> {
	Text(&'a str),
	Key(KeyName),
}

fn text_parts(value: &str) -> Vec<TextPart<'_>> {
	let mut parts = Vec::new();
	let mut text_start = 0;
	let mut index = 0;
	while index < value.len() {
		let character = value[index..].chars().next().expect("valid UTF-8 boundary");
		let width = character.len_utf8();
		let (part, consumed) = match character {
			'\r' if value[index + width..].starts_with('\n') => (Some(KeyName::Enter), width + 1),
			'\n' | '\r' => (Some(KeyName::Enter), width),
			'\t' => (Some(KeyName::Tab), width),
			_ => (None, width),
		};
		if let Some(key) = part {
			if text_start < index {
				parts.push(TextPart::Text(&value[text_start..index]));
			}
			parts.push(TextPart::Key(key));
			index += consumed;
			text_start = index;
		} else {
			index += width;
		}
	}
	if text_start < value.len() {
		parts.push(TextPart::Text(&value[text_start..]));
	}
	parts
}

/// The only entry for `KWin` text policy, including element-addressed typing.
pub(super) fn type_text(
	backend: &mut KwinBackend,
	target: &Target,
	value: &str,
	mode: DeliveryMode,
	element: Option<&AxHandle>,
) -> CoreResult<()> {
	let parts = text_parts(value);
	if backend.nested && parts.iter().any(|part| matches!(part, TextPart::Key(_))) {
		// Settle focus before the first AX edit, not after a prefix landed.
		backend.prepare_window_target(target, mode)?;
	}
	// An eventual Enter/Tab needs compositor focus even when the preceding
	// text can be inserted through AT-SPI. Refuse before that first edit so
	// the tool's takeover fallback cannot replay an already-inserted prefix.
	if !backend.nested
		&& mode == DeliveryMode::Background
		&& parts.iter().any(|part| matches!(part, TextPart::Key(_)))
		&& let Target::Window(id) = target
	{
		backend.bus.require_active(super::windows::uuid(id)?)?;
	}
	let mut delivered = false;
	let mut element = element;
	let mut focused_only = false;
	for part in parts {
		let result = match part {
			TextPart::Text(text) => {
				type_text_chunk(backend, target, text, mode, element, focused_only)
			},
			TextPart::Key(key) => {
				let result = backend.run_input(target, mode, true, |input, ax, bus| {
					if let (Some(element), Some(ax)) = (element, ax) {
						ax.focus(element)?;
					}
					input.key_chord_checked(&[key], || {
						if let Target::Window(id) = target {
							bus.require_active(super::windows::uuid(id)?)?;
						}
						Ok(())
					})
				});
				if key == KeyName::Tab {
					element = None;
					focused_only = true;
				}
				result
			},
		};
		result.map_err(|error| text_part_error(error, delivered))?;
		delivered = true;
	}
	Ok(())
}

fn text_part_error(mut error: DesktopError, delivered: bool) -> DesktopError {
	if delivered && error.code == crate::desktop::error::ErrorCode::BackgroundUnavailable {
		error.code = crate::desktop::error::ErrorCode::InputFailed;
		error.message =
			format!("text was partially delivered; do not replay the whole string: {}", error.message);
	}
	error
}

fn type_text_chunk(
	backend: &mut KwinBackend,
	target: &Target,
	value: &str,
	mode: DeliveryMode,
	element: Option<&AxHandle>,
	focused_only: bool,
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
	let ax_reason = if focused_only {
		// Keep the remaining stream on the compositor keyboard queue: the
		// accessibility focus event for Tab can lag behind its delivery.
		"following keyboard focus after Tab".into()
	} else if let Some(ax) = backend.ax.as_mut() {
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
	if !focused_only && window.app == "org.kde.konsole" {
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
		reasons.push(
			if focused_only {
				"Konsole: following keyboard focus after Tab"
			} else {
				"Konsole: target is not org.kde.konsole"
			}
			.into(),
		);
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
		// Fcitx State=1/Deactivate selects the group's first IM, which can be
		// Rime rather than a keyboard layout. It does not guarantee plain text.
		// Controller replies also do not acknowledge the target Wayland IC
		// consuming queued EIS keys. Leave the IM untouched and paste verified
		// text whenever the host has fcitx.
		let prepared = if fcitx_present(&connection, !nested)? {
			Err(DesktopError::input_failed("host fcitx requires composition-free clipboard text"))
		} else {
			input.prepare_text(value)
		};
		send_text_with_fallback(
			input,
			prepared,
			&mut reasons,
			|input, prepared| {
				bus.require_active(uuid)?;
				input.type_prepared_text_checked(prepared, || bus.require_active(uuid))
			},
			|input| {
				let display = display
					.as_deref()
					.ok_or_else(|| DesktopError::input_failed("target waylandDisplay is unavailable"))?;
				let keys = paste_keys(&window.app);
				super::clipboard::with_text_clipboard(Some(display), value, || {
					bus.require_active(uuid)?;
					input.key_chord_checked(&keys, || bus.require_active(uuid))
				})
			},
		)
	})
}

fn send_text_with_fallback<I, T>(
	input: &mut I,
	prepared: CoreResult<T>,
	reasons: &mut Vec<String>,
	send: impl FnOnce(&mut I, T) -> CoreResult<()>,
	paste: impl FnOnce(&mut I) -> CoreResult<()>,
) -> CoreResult<()> {
	match prepared {
		Ok(prepared) => send(input, prepared),
		Err(error) => {
			control::check()?;
			reasons.push(format!("EIS: {error}"));
			paste(input).map_err(|error| clipboard_error_context(error, reasons))
		},
	}
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

fn fcitx_present(connection: &Connection, host: bool) -> CoreResult<bool> {
	if !host {
		return Ok(false);
	}
	let dbus = zbus::blocking::fdo::DBusProxy::new(connection)
		.map_err(|error| DesktopError::input_failed(format!("fcitx presence check: {error}")))?;
	dbus
		.name_has_owner("org.fcitx.Fcitx5".try_into().expect("valid bus name"))
		.map_err(|error| DesktopError::input_failed(format!("fcitx presence check: {error}")))
}
#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn partially_delivered_text_cannot_trigger_takeover_replay() {
		use crate::desktop::error::ErrorCode;
		let refused = || DesktopError::background_unavailable("target lost focus");
		assert_eq!(text_part_error(refused(), false).code, ErrorCode::BackgroundUnavailable);
		let partial = text_part_error(refused(), true);
		assert_eq!(partial.code, ErrorCode::InputFailed);
		assert!(partial.message.contains("do not replay"));
		assert_eq!(
			text_part_error(DesktopError::cancelled("cancelled"), true).code,
			ErrorCode::Cancelled
		);
	}

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
	fn historical_eis_preflight_error_cannot_replay_a_delivered_paste() {
		use std::{
			io::{Read, Write},
			net::Shutdown,
			os::unix::net::UnixStream,
		};
		struct Transport {
			prepares:   usize,
			deliveries: usize,
			reconnects: usize,
			sender:     UnixStream,
			receiver:   UnixStream,
		}
		impl Transport {
			fn prepare(&mut self) -> CoreResult<()> {
				self.prepares += 1;
				Err(DesktopError::input_preflight_failed(
					"libei device state did not settle; no input was sent",
				))
			}

			fn paste_and_wait(&mut self) -> CoreResult<()> {
				self.sender.write_all(b"once").unwrap();
				let mut delivered = [0; 4];
				self.receiver.read_exact(&mut delivered).unwrap();
				assert_eq!(&delivered, b"once");
				self.deliveries += 1;
				// Fail the acknowledgement only after the peer consumed the paste.
				self.receiver.shutdown(Shutdown::Write).unwrap();
				self.sender.read_exact(&mut [0; 1]).map_err(|error| {
					DesktopError::input_failed(format!(
						"clipboard acknowledgement after delivery: {error}"
					))
				})
			}
		}
		let (sender, receiver) = UnixStream::pair().unwrap();
		let mut transport = Transport { prepares: 0, deliveries: 0, reconnects: 0, sender, receiver };
		let result = super::super::run_input_reconnecting(
			&mut transport,
			|input| {
				let prepared = input.prepare();
				send_text_with_fallback(
					input,
					prepared,
					&mut vec!["AT-SPI unavailable".into()],
					|_, ()| panic!("preflight failed"),
					Transport::paste_and_wait,
				)
			},
			|input| {
				input.reconnects += 1;
				Ok(())
			},
		);
		let error = result.unwrap_err();
		assert!(error.message.contains("no input was sent; clipboard:"));
		assert_eq!(transport.prepares, 1);
		assert_eq!(transport.deliveries, 1);
		assert_eq!(transport.reconnects, 0);
	}

	#[test]
	fn current_pre_delivery_failure_reconnects_and_delivers_once() {
		let mut attempts = 0;
		let mut reconnects = 0;
		let mut deliveries = 0;
		super::super::run_input_reconnecting(
			&mut attempts,
			|attempts| {
				*attempts += 1;
				if *attempts == 1 {
					return Err(DesktopError::input_preflight_failed(
						"device disconnected before any input",
					));
				}
				deliveries += 1;
				Ok(())
			},
			|_| {
				reconnects += 1;
				Ok(())
			},
		)
		.unwrap();
		assert_eq!(attempts, 2);
		assert_eq!(deliveries, 1);
		assert_eq!(reconnects, 1);
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
	fn splits_keyboard_control_characters() {
		assert_eq!(text_parts("one\ntwo"), vec![
			TextPart::Text("one"),
			TextPart::Key(KeyName::Enter),
			TextPart::Text("two"),
		]);
		assert_eq!(text_parts("\n\n\t"), vec![
			TextPart::Key(KeyName::Enter),
			TextPart::Key(KeyName::Enter),
			TextPart::Key(KeyName::Tab),
		]);
		assert_eq!(text_parts("\r\nbody\r\n"), vec![
			TextPart::Key(KeyName::Enter),
			TextPart::Text("body"),
			TextPart::Key(KeyName::Enter),
		]);
		assert_eq!(text_parts("plain text"), vec![TextPart::Text("plain text")]);
	}
	#[test]
	fn parses_konsole_window_children() {
		assert_eq!(
			child_paths("<node><node name=\"1\"/><node name=\"2\"/></node>", "/Windows"),
			vec!["/Windows/1", "/Windows/2"]
		);
	}
}
