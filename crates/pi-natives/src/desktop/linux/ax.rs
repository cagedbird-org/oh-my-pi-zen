use atspi::{CoordType, ObjectRefOwned, Role, State, proxy::accessible::ObjectRefExt};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, normalize_role_atspi},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

mod menus;

pub struct AtSpiAx {
	rt:           Runtime,
	connection:   atspi::AccessibilityConnection,
	focused_text: std::collections::HashMap<String, ObjectRefOwned>,
}

pub(crate) enum TextInsertion {
	Inserted,
	Unavailable(String),
}

fn insertion_length(value: &str, toolkit: &str) -> CoreResult<i32> {
	let length = if toolkit.eq_ignore_ascii_case("Qt") {
		value.encode_utf16().count()
	} else {
		value.len()
	};
	i32::try_from(length)
		.map_err(|_| DesktopError::input_failed("text exceeds AT-SPI insertion limit"))
}

fn selection_range((start, end): (i32, i32)) -> Option<(i32, i32)> {
	if start < 0 || end < 0 || start == end {
		return None;
	}
	Some((start.min(end), start.max(end)))
}

/// An AT-SPI top-level frame and whether its reported screen position is real.
///
/// Native Wayland clients cannot learn where the compositor placed them, so
/// their toolkits answer `CoordType::Screen` with window-relative coordinates
/// (usually `0,0`). Consumers that map `window` bounds onto a desktop capture
/// (the Wayland window crop) must refuse when `position_known` is false.
pub struct AtSpiWindow {
	pub window:         DesktopWindow,
	/// Screen and window-relative origins differ, so `window.x`/`window.y` are
	/// global compositor coordinates. False also covers a window genuinely at
	/// the global origin, which is indistinguishable over AT-SPI.
	pub position_known: bool,
}

impl AtSpiAx {
	pub(crate) fn new() -> CoreResult<Self> {
		let rt = Builder::new_current_thread()
			.enable_all()
			.build()
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI runtime: {err}")))?;
		let connection = rt
			.block_on(atspi::AccessibilityConnection::new())
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI connection: {err}")))?;
		Ok(Self { rt, connection, focused_text: Default::default() })
	}

	/// Resolve the accessibility bus on the selected session, not the host bus.
	pub(crate) fn for_session(session: &zbus::blocking::Connection) -> CoreResult<Self> {
		let proxy =
			zbus::blocking::Proxy::new(session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
				.map_err(|error| DesktopError::ax_failed(format!("AT-SPI session bus: {error}")))?;
		let address: String = proxy
			.call("GetAddress", &())
			.map_err(|error| DesktopError::ax_failed(format!("AT-SPI GetAddress: {error}")))?;
		let rt = Builder::new_current_thread()
			.enable_all()
			.build()
			.map_err(|error| DesktopError::ax_failed(format!("AT-SPI runtime: {error}")))?;
		let address = address
			.parse()
			.map_err(|error| DesktopError::ax_failed(format!("AT-SPI address: {error}")))?;
		let connection = rt
			.block_on(atspi::AccessibilityConnection::from_address(address))
			.map_err(|error| DesktopError::ax_failed(format!("AT-SPI selected session: {error}")))?;
		Ok(Self { rt, connection, focused_text: Default::default() })
	}

	pub(crate) fn insert_text(
		&mut self,
		window: &DesktopWindow,
		element: Option<&AxHandle>,
		value: &str,
	) -> CoreResult<TextInsertion> {
		let root = match self.window_root(window) {
			Ok(root) => root,
			Err(error) => {
				return Ok(TextInsertion::Unavailable(format!("window association: {error}")));
			},
		};
		let remembered = self.focused_text.get(&window.id).cloned();
		self.rt.block_on(async {
			let connection = self.connection.connection();
			let object = if let Some(element) = element {
				Self::object(element).clone()
			} else if let Some(focused) =
				Self::focused_editable(connection, Self::object(&root).clone(), 0).await
			{
				focused
			} else if let Some(cached) = remembered.filter(|_| window.id.starts_with("kwin:")) {
				if Self::valid_cached_text(connection, &cached, Self::object(&root)).await {
					cached
				} else {
					let Some(unique) =
						Self::unique_editable(connection, Self::object(&root).clone()).await
					else {
						return Ok(TextInsertion::Unavailable(
							"no focused, valid cached, or unique showing editable element".into(),
						));
					};
					unique
				}
			} else {
				let Some(unique) = Self::unique_editable(connection, Self::object(&root).clone()).await
				else {
					return Ok(TextInsertion::Unavailable(
						"no focused or unique showing editable element".into(),
					));
				};
				unique
			};
			let accessible = match object.as_accessible_proxy(connection).await {
				Ok(proxy) => proxy,
				Err(error) => return Ok(TextInsertion::Unavailable(format!("element proxy: {error}"))),
			};
			if !accessible
				.get_interfaces()
				.await
				.is_ok_and(|interfaces| interfaces.contains(atspi::Interface::EditableText))
			{
				return Ok(TextInsertion::Unavailable("element does not expose EditableText".into()));
			}
			let Some(name) = object.name() else {
				return Ok(TextInsertion::Unavailable("element has no accessibility bus owner".into()));
			};
			let editable = atspi::proxy::editable_text::EditableTextProxy::builder(connection)
				.destination(name.clone())
				.map_err(|e| DesktopError::ax_failed(e.to_string()))?
				.path(object.path().clone())
				.map_err(|e| DesktopError::ax_failed(e.to_string()))?
				.cache_properties(atspi::zbus::proxy::CacheProperties::No)
				.build()
				.await;
			let text = atspi::proxy::text::TextProxy::builder(connection)
				.destination(name.clone())
				.map_err(|e| DesktopError::ax_failed(e.to_string()))?
				.path(object.path().clone())
				.map_err(|e| DesktopError::ax_failed(e.to_string()))?
				.cache_properties(atspi::zbus::proxy::CacheProperties::No)
				.build()
				.await;
			let (Ok(editable), Ok(text)) = (editable, text) else {
				return Ok(TextInsertion::Unavailable(
					"Text/EditableText proxy construction failed".into(),
				));
			};
			let caret = match text.caret_offset().await {
				Ok(caret) => caret,
				Err(error) => return Ok(TextInsertion::Unavailable(format!("CaretOffset: {error}"))),
			};
			let selections = match text.get_n_selections().await {
				Ok(count) => count,
				Err(error) => {
					return Ok(TextInsertion::Unavailable(format!("GetNSelections: {error}")));
				},
			};
			let selection = if selections > 0 {
				match text.get_selection(0).await {
					Ok(range) => selection_range(range),
					Err(error) => {
						return Ok(TextInsertion::Unavailable(format!("GetSelection: {error}")));
					},
				}
			} else {
				None
			};
			let insert_at = selection.map_or(caret, |(start, _)| start);
			let application = accessible
				.get_application()
				.await
				.map_err(|e| DesktopError::ax_failed(format!("AT-SPI application lookup: {e}")))?;
			let Some(owner) = application.name() else {
				return Ok(TextInsertion::Unavailable("application has no bus owner".into()));
			};
			let app = atspi::zbus::Proxy::new(
				connection,
				owner.as_str(),
				application.path().as_str(),
				"org.freedesktop.DBus.Properties",
			)
			.await
			.map_err(|e| DesktopError::ax_failed(format!("AT-SPI application proxy: {e}")))?;
			let toolkit: atspi::zbus::zvariant::OwnedValue = app
				.call("Get", &("org.a11y.atspi.Application", "ToolkitName"))
				.await
				.map_err(|e| DesktopError::ax_failed(format!("AT-SPI ToolkitName: {e}")))?;
			let toolkit = String::try_from(toolkit)
				.map_err(|e| DesktopError::ax_failed(format!("AT-SPI ToolkitName value: {e}")))?;
			// Qt's adaptor resizes QString to this length (UTF-16 units), whereas
			// ATK consumes a UTF-8 byte length. Never let Qt extend past the text.
			let length = insertion_length(value, &toolkit)?;
			if let Some((start, end)) = selection {
				crate::desktop::control::check()?;
				if !editable.delete_text(start, end).await.map_err(|e| {
					DesktopError::input_failed(format!(
						"AT-SPI DeleteText outcome unknown; do not retry: {e}"
					))
				})? {
					return Ok(TextInsertion::Unavailable(
						"EditableText.DeleteText explicitly returned false".into(),
					));
				}
				if !text.set_caret_offset(start).await.map_err(|e| {
					DesktopError::input_failed(format!(
						"AT-SPI deleted selected text but could not move caret: {e}"
					))
				})? {
					return Err(DesktopError::input_failed(
						"AT-SPI deleted selected text but rejected caret update",
					));
				}
			}
			let before_count = text
				.character_count()
				.await
				.map_err(|e| DesktopError::input_failed(format!("AT-SPI CharacterCount: {e}")))?;
			let before_text = text.get_text(0, before_count).await.map_err(|e| {
				DesktopError::input_failed(format!("AT-SPI text before insertion: {e}"))
			})?;
			crate::desktop::control::check()?;
			if !editable
				.insert_text(insert_at, value, length)
				.await
				.map_err(|e| {
					DesktopError::input_failed(format!(
						"AT-SPI InsertText outcome unknown; do not retry: {e}"
					))
				})? {
				return Ok(TextInsertion::Unavailable(
					"EditableText.InsertText explicitly returned false".into(),
				));
			}
			let after_count = text.character_count().await.map_err(|e| {
				DesktopError::input_failed(format!(
					"AT-SPI inserted text count unavailable; do not retry: {e}"
				))
			})?;
			let end = after_count
				.checked_sub(before_count)
				.and_then(|delta| insert_at.checked_add(delta))
				.ok_or_else(|| {
					DesktopError::input_failed("AT-SPI inserted text count overflow; do not retry")
				})?;
			let inserted = text.get_text(insert_at, end).await.map_err(|e| {
				DesktopError::input_failed(format!(
					"AT-SPI inserted text could not be verified; do not retry: {e}"
				))
			})?;
			if inserted != value {
				if selection.is_none() && after_count == before_count {
					let actual = text.get_text(0, after_count).await.map_err(|e| {
						DesktopError::input_failed(format!("AT-SPI insertion readback: {e}"))
					})?;
					if actual == before_text {
						return Ok(TextInsertion::Unavailable(
							"EditableText.InsertText acknowledged without changing text".into(),
						));
					}
				}
				return Err(DesktopError::input_failed(
					"AT-SPI InsertText readback mismatch; do not retry",
				));
			}
			if !text.set_caret_offset(end).await.map_err(|e| {
				DesktopError::input_failed(format!(
					"AT-SPI inserted text but could not move caret: {e}"
				))
			})? {
				return Err(DesktopError::input_failed(
					"AT-SPI inserted text but rejected caret update",
				));
			}
			Ok(TextInsertion::Inserted)
		})
	}

	async fn focused_editable(
		connection: &atspi::zbus::Connection,
		object: ObjectRefOwned,
		depth: u8,
	) -> Option<ObjectRefOwned> {
		if depth > 40 || object.is_null() {
			return None;
		}
		let proxy = object.as_accessible_proxy(connection).await.ok()?;
		if proxy.get_state().await.ok()?.contains(State::Focused)
			&& proxy
				.get_interfaces()
				.await
				.ok()?
				.contains(atspi::Interface::EditableText)
		{
			return Some(object);
		}
		for child in proxy.get_children().await.ok()? {
			if let Some(found) = Box::pin(Self::focused_editable(connection, child, depth + 1)).await {
				return Some(found);
			}
		}
		None
	}

	async fn valid_cached_text(
		connection: &atspi::zbus::Connection,
		object: &ObjectRefOwned,
		root: &ObjectRefOwned,
	) -> bool {
		let Ok(proxy) = object.as_accessible_proxy(connection).await else {
			return false;
		};
		if !proxy
			.get_state()
			.await
			.is_ok_and(|state| state.contains(State::Showing))
			|| !proxy
				.get_interfaces()
				.await
				.is_ok_and(|interfaces| interfaces.contains(atspi::Interface::EditableText))
		{
			return false;
		}
		let mut parent = object.clone();
		for _ in 0..64 {
			if &parent == root {
				return true;
			}
			let Ok(proxy) = parent.as_accessible_proxy(connection).await else {
				return false;
			};
			let Ok(next) = proxy.parent().await else {
				return false;
			};
			if next.is_null() || next == parent {
				return false;
			}
			parent = next;
		}
		false
	}

	async fn unique_editable(
		connection: &atspi::zbus::Connection,
		root: ObjectRefOwned,
	) -> Option<ObjectRefOwned> {
		let mut candidate = None;
		let mut count = 0;
		Self::collect_editable(connection, root, 0, &mut candidate, &mut count).await;
		if count == 1 { candidate } else { None }
	}

	async fn collect_editable(
		connection: &atspi::zbus::Connection,
		object: ObjectRefOwned,
		depth: u8,
		candidate: &mut Option<ObjectRefOwned>,
		count: &mut u8,
	) {
		if depth > 40 || *count > 1 || object.is_null() {
			return;
		}
		let Ok(proxy) = object.as_accessible_proxy(connection).await else {
			return;
		};
		if proxy
			.get_state()
			.await
			.is_ok_and(|state| state.contains(State::Showing) && state.contains(State::Editable))
			&& proxy
				.get_interfaces()
				.await
				.is_ok_and(|interfaces| interfaces.contains(atspi::Interface::EditableText))
		{
			*count += 1;
			*candidate = Some(object.clone());
		}
		for child in proxy.get_children().await.unwrap_or_default() {
			Box::pin(Self::collect_editable(connection, child, depth + 1, candidate, count)).await;
			if *count > 1 {
				break;
			}
		}
	}

	const fn object(h: &AxHandle) -> &ObjectRefOwned {
		match h {
			AxHandle::AtSpi(object) => object,
			#[cfg(test)]
			_ => panic!("AT-SPI backend received a non-AT-SPI handle"),
		}
	}

	pub(crate) fn windows(&self) -> CoreResult<Vec<AtSpiWindow>> {
		self.rt.block_on(async {
			let mut windows = Vec::new();
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				let app_proxy = app
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI application: {err}")))?;
				let app_name = app_proxy.name().await.unwrap_or_default();
				let pid = if let Some(bus_name) = app.name() {
					let dbus = atspi::zbus::fdo::DBusProxy::new(self.connection.connection())
						.await
						.ok();
					if let Some(dbus) = dbus {
						dbus
							.get_connection_unix_process_id(bus_name.clone().into())
							.await
							.ok()
					} else {
						None
					}
				} else {
					None
				};
				for frame in Self::frames(&self.connection, &app)
					.await
					.unwrap_or_default()
				{
					let frame_proxy = frame
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame: {err}")))?;
					let title = frame_proxy.name().await.unwrap_or_default();
					let state = frame_proxy.get_state().await.ok();
					let Ok(component) = Self::component(&self.connection, &frame).await else {
						continue;
					};
					let Ok((x, y, width, height)) = component.get_extents(CoordType::Screen).await
					else {
						continue;
					};
					if width < 16 || height < 16 {
						continue;
					}
					let position_known = component
						.get_extents(CoordType::Window)
						.await
						.is_ok_and(|(window_x, window_y, ..)| (window_x, window_y) != (x, y));
					let id = atspi_window_id(&frame);
					windows.push(AtSpiWindow {
						window: DesktopWindow {
							minimized: None,
							id,
							title,
							app: app_name.clone(),
							pid,
							x,
							y,
							width: width as u32,
							height: height as u32,
							focused: state.as_ref().is_some_and(|states| {
								states.contains(State::Focused) || states.contains(State::Active)
							}),
						},
						position_known,
					});
					if windows.len() == 48 {
						return Ok(windows);
					}
				}
			}
			Ok(windows)
		})
	}

	async fn apps(
		connection: &atspi::AccessibilityConnection,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let root = connection
			.root_accessible_on_registry()
			.await
			.map_err(|err| err.to_string())?;
		root.get_children().await.map_err(|err| err.to_string())
	}

	async fn app_for_window(
		connection: &atspi::AccessibilityConnection,
		win: &DesktopWindow,
	) -> Result<ObjectRefOwned, String> {
		let apps = Self::apps(connection).await?;
		let mut matches = Vec::new();
		for app in apps {
			if win.id.starts_with("atspi:") {
				if app
					.name()
					.is_some_and(|name| win.id.starts_with(&format!("atspi:{name}:")))
				{
					matches.push(app);
				}
				continue;
			}
			let proxy = app
				.as_accessible_proxy(connection.connection())
				.await
				.map_err(|err| err.to_string())?;
			let name = proxy.name().await.unwrap_or_default();
			if win.pid.is_none() && name.eq_ignore_ascii_case(&win.app) {
				matches.push(app.clone());
			}
			if let Some(pid) = win.pid {
				let Some(bus_name) = app.name() else {
					continue;
				};
				let dbus = atspi::zbus::fdo::DBusProxy::new(connection.connection())
					.await
					.map_err(|err| err.to_string())?;
				if dbus
					.get_connection_unix_process_id(bus_name.clone().into())
					.await
					.ok()
					== Some(pid)
				{
					matches.push(app);
				}
			}
		}
		if matches.len() == 1 {
			Ok(matches.remove(0))
		} else {
			Err(format!(
				"application '{}' (pid {:?}) has {} AT-SPI matches; refusing ambiguous ownership",
				win.app,
				win.pid,
				matches.len()
			))
		}
	}

	async fn frames(
		connection: &atspi::AccessibilityConnection,
		app: &ObjectRefOwned,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let mut pending = vec![(app.clone(), 0_u8)];
		let mut frames = Vec::new();
		while let Some((object, depth)) = pending.pop() {
			if depth > 3 || frames.len() >= 64 {
				continue;
			}
			let proxy = object
				.as_accessible_proxy(connection.connection())
				.await
				.map_err(|err| err.to_string())?;
			let role = proxy.get_role().await.map_err(|err| err.to_string())?;
			if matches!(role, Role::Frame | Role::Dialog | Role::Window) {
				frames.push(object.clone());
			}
			let children = proxy.get_children().await.map_err(|err| err.to_string())?;
			pending.extend(
				children
					.into_iter()
					.filter(|child| !child.is_null())
					.map(|child| (child, depth + 1)),
			);
		}
		Ok(frames)
	}

	async fn component<'a>(
		connection: &'a atspi::AccessibilityConnection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::component::ComponentProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::component::ComponentProxy::builder(connection.connection())
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	async fn action<'a>(
		connection: &'a atspi::AccessibilityConnection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::action::ActionProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::action::ActionProxy::builder(connection.connection())
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	async fn find_focused(
		connection: &atspi::zbus::Connection,
		root: ObjectRefOwned,
		depth: u8,
	) -> Result<Option<ObjectRefOwned>, String> {
		// Chromium/Electron frames report children that are the AT-SPI null
		// object.
		if depth > 40 || root.is_null() {
			return Ok(None);
		}
		let proxy = root
			.as_accessible_proxy(connection)
			.await
			.map_err(|err| err.to_string())?;
		if proxy
			.get_state()
			.await
			.is_ok_and(|state| state.contains(State::Focused))
		{
			return Ok(Some(root));
		}
		for child in proxy.get_children().await.unwrap_or_default() {
			if let Some(found) = Box::pin(Self::find_focused(connection, child, depth + 1)).await? {
				return Ok(Some(found));
			}
		}
		Ok(None)
	}
}

fn atspi_window_id(frame: &ObjectRefOwned) -> String {
	let name = frame.name().map_or_default(ToString::to_string);
	format!("atspi:{name}:{}", frame.path())
}

fn native_window_for_frame(windows: &[DesktopWindow], pid: u32, title: &str) -> CoreResult<String> {
	let mut matches = windows.iter().filter(|window| {
		!window.id.starts_with("atspi:")
			&& window.pid == Some(pid)
			&& titles_match(&window.title, title)
	});
	let first = matches.next().ok_or_else(|| {
		DesktopError::window_not_found("AT-SPI frame has no matching native window")
	})?;
	if matches.next().is_some() {
		return Err(DesktopError::ax_failed(
			"AT-SPI frame matches multiple native windows; refusing ambiguous input ownership",
		));
	}
	Ok(first.id.clone())
}

/// Generic press means activation, not action zero (GTK4 text views put
/// `buffer.delete-line` there). Explicit advertised actions remain available.
fn action_index<'a>(
	mut actions: impl Iterator<Item = &'a str> + Clone,
	requested: &str,
) -> Option<usize> {
	actions
		.clone()
		.position(|name| name.eq_ignore_ascii_case(requested))
		.or_else(|| {
			requested
				.eq_ignore_ascii_case("press")
				.then(|| {
					actions.position(|name| {
						[
							"click",
							"clickAncestor",
							"activate",
							"invoke",
							"toggle",
							"open",
							"jump",
							"do default",
							"do-default",
						]
						.iter()
						.any(|safe| name.eq_ignore_ascii_case(safe))
					})
				})
				.flatten()
		})
}

fn titles_match(left: &str, right: &str) -> bool {
	!left.trim().is_empty() && left.split_whitespace().eq(right.split_whitespace())
}

struct WindowFrame<T> {
	object:         T,
	showing:        bool,
	populated:      bool,
	geometry_match: bool,
}

fn select_window_frame<T>(
	window: &DesktopWindow,
	frames: Vec<WindowFrame<T>>,
) -> Result<T, String> {
	if window.minimized == Some(true) {
		return Err(format!("window '{}' is minimized; refusing AT-SPI input", window.title));
	}
	// Count identity candidates before visibility. A hidden same-title frame
	// must not make its visible sibling look like a unique destination.
	let ambiguous_title = frames.len() > 1;
	let mut candidates = frames
		.into_iter()
		.filter(|frame| !ambiguous_title || frame.geometry_match);
	let Some(first) = candidates.next() else {
		return Err(format!("window '{}' has no matching AT-SPI frame", window.title));
	};
	if candidates.next().is_some() || !first.showing || !first.populated {
		return Err(format!("window '{}' has no unique visible AT-SPI frame", window.title));
	}
	Ok(first.object)
}

fn geometry_matches(window: &DesktopWindow, (_x, _y, width, height): (i32, i32, i32, i32)) -> bool {
	const TOLERANCE: i32 = 64;
	(width - i32::try_from(window.width).unwrap_or(i32::MAX)).abs() <= TOLERANCE
		&& (height - i32::try_from(window.height).unwrap_or(i32::MAX)).abs() <= TOLERANCE
}
impl AxBackend for AtSpiAx {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		let result = self.rt.block_on(async {
			let app = Self::app_for_window(&self.connection, win).await?;
			let frames = Self::frames(&self.connection, &app).await?;
			let mut titled = Vec::new();
			for frame in frames {
				let id = atspi_window_id(&frame);
				if win.id.starts_with("atspi:") {
					if id == win.id {
						return Ok(frame);
					}
					continue;
				}
				let proxy = frame
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| err.to_string())?;
				let title = proxy.name().await.map_err(|err| err.to_string())?;
				if !titles_match(&title, &win.title) {
					continue;
				}
				let state = proxy.get_state().await.map_err(|err| err.to_string())?;
				let children = proxy.get_children().await.map_err(|err| err.to_string())?;
				let geometry_match = match Self::component(&self.connection, &frame).await {
					Ok(component) => component
						.get_extents(CoordType::Screen)
						.await
						.is_ok_and(|extents| geometry_matches(win, extents)),
					Err(_) => false,
				};
				titled.push(WindowFrame {
					object: frame,
					showing: state.contains(State::Showing),
					populated: !children.is_empty(),
					geometry_match,
				});
			}
			select_window_frame(win, titled)
		});
		let object = result
			.map_err(|err: String| DesktopError::ax_failed(format!("AT-SPI window root: {err}")))?;
		if win.id.starts_with("kwin:")
			&& win.focused
			&& let Some(focused) = self.rt.block_on(Self::focused_editable(
				self.connection.connection(),
				object.clone(),
				0,
			)) {
			self.focused_text.insert(win.id.clone(), focused);
		}
		Ok(AxHandle::AtSpi(object))
	}

	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let mut object = Self::object(h).clone();
		self.rt.block_on(async {
			// Follow ownership, never screen containment: overlapping windows and
			// same-process dialogs are distinct input destinations.
			for _ in 0..64 {
				let proxy = object
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window owner: {err}")))?;
				let role = proxy
					.get_role()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window role: {err}")))?;
				if matches!(role, Role::Frame | Role::Dialog | Role::Window) {
					let id = atspi_window_id(&object);
					if windows.iter().any(|window| window.id == id) {
						return Ok(id);
					}
					let name = object
						.name()
						.ok_or_else(|| DesktopError::ax_failed("AT-SPI window has no bus owner"))?;
					let dbus = atspi::zbus::fdo::DBusProxy::new(self.connection.connection())
						.await
						.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
					let pid = dbus
						.get_connection_unix_process_id(name.clone().into())
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window pid: {err}")))?;
					let title = proxy
						.name()
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window title: {err}")))?;
					return native_window_for_frame(windows, pid, &title);
				}
				let parent = proxy
					.parent()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window parent: {err}")))?;
				if parent.is_null() || parent == object {
					break;
				}
				drop(proxy);
				object = parent;
			}
			Err(DesktopError::ax_failed("AT-SPI element has no identifiable top-level window"))
		})
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI accessible: {err}")))?;
			let title = proxy.name().await.ok().filter(|s| !s.is_empty());
			let description = proxy.description().await.ok().filter(|s| !s.is_empty());
			let native_role = match proxy.get_role_name().await {
				Ok(role) => role,
				Err(_) => proxy
					.get_localized_role_name()
					.await
					.unwrap_or_else(|_| "unknown".to_string()),
			};
			let state = proxy.get_state().await.ok();
			let multiline = state
				.as_ref()
				.is_some_and(|states| states.contains(State::MultiLine));
			let value = if let Some(name) = object.name().cloned() {
				let builder = atspi::proxy::text::TextProxy::builder(self.connection.connection())
					.destination(name)
					.and_then(|builder| builder.path(object.path().clone()));
				if let Ok(builder) = builder {
					// Qt virtual accessible Text objects implement Get(property)
					// but can reject Properties.GetAll for that same interface.
					// Do not let zbus' default property cache turn a valid value
					// into an empty string after a failed CharacterCount lookup.
					if let Ok(text) = builder
						.cache_properties(atspi::zbus::proxy::CacheProperties::No)
						.build()
						.await
					{
						let count = text.character_count().await.unwrap_or(0).clamp(0, 16_384);
						text.get_text(0, count).await.ok()
					} else {
						None
					}
				} else {
					None
				}
			} else {
				None
			};
			let bounds = if let Ok(component) = Self::component(&self.connection, &object).await {
				component
					.get_extents(CoordType::Screen)
					.await
					.ok()
					.and_then(|(x, y, width, height)| {
						(width >= 0 && height >= 0).then_some(AxBounds {
							x:      f64::from(x),
							y:      f64::from(y),
							width:  f64::from(width),
							height: f64::from(height),
						})
					})
			} else {
				None
			};
			let actions = match Self::action(&self.connection, &object).await {
				Ok(action) => action
					.get_actions()
					.await
					.unwrap_or_default()
					.into_iter()
					.map(|a| a.name)
					.collect(),
				Err(_) => Vec::new(),
			};
			let child_count = proxy.child_count().await.unwrap_or(0).max(0) as u32;
			Ok(AxProps {
				role: normalize_role_atspi(&native_role, multiline),
				native_role,
				title,
				value,
				description,
				enabled: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Enabled)),
				focused: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Focused)),
				bounds,
				actions,
				child_count,
				identity: None,
				partial: false,
			})
		})
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))?;
			proxy
				.get_children()
				.await
				.map(|items| {
					items
						.into_iter()
						.filter(|item| !item.is_null())
						.map(AxHandle::AtSpi)
						.collect()
				})
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))
		})
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			let parent = proxy
				.parent()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			Ok((!parent.is_null()).then_some(AxHandle::AtSpi(parent)))
		})
	}

	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = Self::action(&self.connection, &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			let actions = proxy
				.get_actions()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI actions: {err}")))?;
			let mut names = actions.iter().map(|item| item.name.as_str());
			let mut index = action_index(names.clone(), action);
			if index.is_none() && action.eq_ignore_ascii_case("press") {
				let accessible = object
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
				if matches!(accessible.get_role().await, Ok(Role::CheckBox | Role::CheckMenuItem)) {
					index = names.position(|name| {
						name.eq_ignore_ascii_case("check") || name.eq_ignore_ascii_case("uncheck")
					});
				}
			}
			let index = index.ok_or_else(|| {
				DesktopError::ax_failed(format!("AT-SPI action '{action}' is unavailable"))
			})? as i32;
			if proxy
				.do_action(index)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI action: {err}")))?
			{
				Ok(())
			} else {
				Err(DesktopError::ax_failed(format!("AT-SPI action '{action}' failed")))
			}
		})
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let name = object
				.name()
				.ok_or_else(|| DesktopError::ax_failed("AT-SPI object has no bus name"))?
				.clone();
			let accessible = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
			let state = accessible
				.get_state()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI state: {err}")))?;
			if !state.contains(State::Showing) {
				return Err(DesktopError::ax_failed("AT-SPI element is not visible"));
			}
			if !state.contains(State::Enabled) || !state.contains(State::Sensitive) {
				return Err(DesktopError::ax_failed("AT-SPI element is not editable"));
			}
			let interfaces = accessible
				.get_interfaces()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI interfaces: {err}")))?;
			if interfaces.contains(atspi::Interface::EditableText) {
				let editable = atspi::proxy::editable_text::EditableTextProxy::builder(
					self.connection.connection(),
				)
				.destination(name.clone())
				.and_then(|b| b.path(object.path().clone()))
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?
				.build()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI editable text: {err}")))?;
				if !editable
					.set_text_contents(value)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text value: {err}")))?
				{
					return Err(DesktopError::ax_failed("AT-SPI text value was rejected"));
				}
				let text = atspi::proxy::text::TextProxy::builder(self.connection.connection())
					.destination(name.clone())
					.and_then(|b| b.path(object.path().clone()))
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?
					.cache_properties(atspi::zbus::proxy::CacheProperties::No)
					.build()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text readback: {err}")))?;
				let count = text
					.character_count()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text count: {err}")))?
					.max(0);
				let actual = text
					.get_text(0, count)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text readback: {err}")))?;
				if actual != value {
					return Err(DesktopError::ax_failed(format!(
						"AT-SPI text value readback mismatch: expected {value:?}, got {actual:?}"
					)));
				}
				return Ok(());
			}
			if !interfaces.contains(atspi::Interface::Value) {
				return Err(DesktopError::ax_failed("AT-SPI element has no writable value interface"));
			}
			let numeric = value.parse::<f64>().map_err(|_| {
				DesktopError::ax_failed("AT-SPI value is not editable text or a number")
			})?;
			if !numeric.is_finite() {
				return Err(DesktopError::ax_failed("AT-SPI numeric value must be finite"));
			}
			let proxy = atspi::proxy::value::ValueProxy::builder(self.connection.connection())
				.destination(name)
				.and_then(|b| b.path(object.path().clone()))
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?
				.build()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))?;
			proxy
				.set_current_value(numeric)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))?;
			let actual = proxy
				.current_value()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value readback: {err}")))?;
			if (actual - numeric).abs() > f64::EPSILON * actual.abs().max(numeric.abs()).max(1.0) {
				return Err(DesktopError::ax_failed(format!(
					"AT-SPI numeric value readback mismatch: expected {numeric}, got {actual}"
				)));
			}
			Ok(())
		})
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let component = Self::component(&self.connection, &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			if component
				.grab_focus()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI focus: {err}")))?
			{
				Ok(())
			} else {
				Err(DesktopError::ax_failed("AT-SPI focus request was rejected"))
			}
		})
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		let x = x.round() as i32;
		let y = y.round() as i32;
		self.rt.block_on(async {
			let mut root = None;
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				for frame in Self::frames(&self.connection, &app)
					.await
					.map_err(DesktopError::ax_failed)?
				{
					let contains = {
						let component = Self::component(&self.connection, &frame)
							.await
							.map_err(DesktopError::ax_failed)?;
						component
							.contains(x, y, CoordType::Screen)
							.await
							.map_err(|err| {
								DesktopError::ax_failed(format!("AT-SPI frame hit test: {err}"))
							})?
					};
					if !contains {
						continue;
					}
					// AT-SPI enumeration is not stacking order. Never choose an
					// arbitrary frame when two top-levels contain the point.
					if let Some(previous) = &root {
						if previous != &frame {
							return Err(DesktopError::ax_failed(
								"multiple AT-SPI windows contain this point; topmost ownership is \
								 ambiguous",
							));
						}
					} else {
						root = Some(frame);
					}
				}
			}
			let Some(mut current) = root else {
				return Ok(None);
			};
			let mut ancestors = Vec::new();
			for _ in 0..64 {
				let has_component = {
					let accessible = current
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI hit-test element: {err}"))
						})?;
					accessible
						.get_interfaces()
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI hit-test interfaces: {err}"))
						})?
						.contains(atspi::Interface::Component)
				};
				if !has_component {
					return Ok(Some(AxHandle::AtSpi(current)));
				}
				// GetAccessibleAtPoint returns an immediate child, not
				// necessarily the leaf that owns the requested pixel.
				let child = {
					let component = Self::component(&self.connection, &current)
						.await
						.map_err(DesktopError::ax_failed)?;
					component
						.get_accessible_at_point(x, y, CoordType::Screen)
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI element at point: {err}"))
						})?
				};
				if child.is_null() || child == current {
					return Ok(Some(AxHandle::AtSpi(current)));
				}
				if ancestors.contains(&child) {
					return Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy contains a cycle"));
				}
				ancestors.push(current);
				current = child;
			}
			Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy exceeds the depth limit"))
		})
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self.rt.block_on(async {
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				if let Some(found) = Self::find_focused(self.connection.connection(), app, 0)
					.await
					.map_err(DesktopError::ax_failed)?
				{
					return Ok(Some(AxHandle::AtSpi(found)));
				}
			}
			Ok(None)
		})
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?;
			let mut attrs: Vec<_> = proxy
				.get_attributes()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?
				.into_iter()
				.map(|(key, mut value)| {
					value.truncate(200);
					(key, value)
				})
				.collect();
			attrs.sort_by(|a, b| a.0.cmp(&b.0));
			Ok(attrs)
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn generic_press_never_selects_an_unrelated_editing_action() {
		let actions = ["buffer.delete-line", "clipboard.cut", "activate"];
		assert_eq!(action_index(actions.into_iter(), "press"), Some(2));
		assert_eq!(action_index(actions[..2].iter().copied(), "press"), None);
		assert_eq!(action_index(actions.into_iter(), "buffer.delete-line"), Some(0));
		assert_eq!(action_index(std::iter::empty(), "press"), None);
	}

	#[test]
	fn toolkit_text_lengths_preserve_non_bmp_characters() {
		assert_eq!(insertion_length("中文🙂 mixed text", "Qt").unwrap(), 15);
		assert_eq!(insertion_length("中文🙂 mixed text", "gtk").unwrap(), 21);
	}

	#[test]
	fn selection_ranges_are_ordered_and_empty_ranges_are_carets() {
		assert_eq!(selection_range((4, 1)), Some((1, 4)));
		assert_eq!(selection_range((2, 2)), None);
		assert_eq!(selection_range((-1, 3)), None);
	}

	#[test]
	fn geometry_filter_rejects_stale_small_frame() {
		let window = DesktopWindow {
			minimized: None,
			id:        "kwin:{id}".into(),
			title:     "Save".into(),
			app:       "org.kde.kwrite".into(),
			pid:       Some(1),
			x:         10,
			y:         20,
			width:     864,
			height:    540,
			focused:   true,
		};
		assert!(geometry_matches(&window, (10, 20, 864, 540)));
		assert!(!geometry_matches(&window, (10, 20, 100, 30)));
		assert!(titles_match(&window.title, "  Save  "));
		assert!(!titles_match(&window.title, "Save another document"));
		let frames =
			[("Save", false, (10, 20, 864, 540)), ("Other document", true, (10, 20, 864, 540))];
		let candidates = frames
			.into_iter()
			.filter(|(title, ..)| titles_match(&window.title, title))
			.map(|(title, showing, extents)| WindowFrame {
				object: title,
				showing,
				populated: true,
				geometry_match: geometry_matches(&window, extents),
			})
			.collect();
		assert!(select_window_frame(&window, candidates).is_err());
		for other_geometry in [false, true] {
			let frames = vec![
				WindowFrame {
					object:         "hidden target",
					showing:        false,
					populated:      true,
					geometry_match: true,
				},
				WindowFrame {
					object:         "visible sibling",
					showing:        true,
					populated:      true,
					geometry_match: other_geometry,
				},
			];
			assert!(select_window_frame(&window, frames).is_err());
		}
		let minimized = DesktopWindow { minimized: Some(true), ..window };
		for other_geometry in [false, true] {
			let frames = vec![
				WindowFrame {
					object:         "hidden target",
					showing:        false,
					populated:      true,
					geometry_match: true,
				},
				WindowFrame {
					object:         "visible sibling",
					showing:        true,
					populated:      true,
					geometry_match: other_geometry,
				},
			];
			assert!(select_window_frame(&minimized, frames).is_err());
		}
	}
	#[test]
	fn frame_ownership_requires_unique_process_and_title() {
		let window = |id: &str, pid: u32| DesktopWindow {
			minimized: None,
			id:        id.to_owned(),
			pid:       Some(pid),
			title:     "Document".into(),
			app:       "Editor".into(),
			x:         0,
			y:         0,
			width:     100,
			height:    100,
			focused:   false,
		};
		let mut windows = vec![window("1", 10), window("2", 20)];
		assert_eq!(native_window_for_frame(&windows, 20, "Document").unwrap(), "2");
		assert!(native_window_for_frame(&windows, 30, "Document").is_err());
		windows.push(window("3", 20));
		assert!(native_window_for_frame(&windows, 20, "Document").is_err());
		let mut kwin = vec![window("kwin:first", 20)];
		assert!(native_window_for_frame(&kwin, 20, "Document — Editor").is_err());
		assert_eq!(native_window_for_frame(&kwin, 20, "  Document  ").unwrap(), "kwin:first");
		kwin.push(window("kwin:second", 20));
		kwin[1].title = "Other".into();
		assert_eq!(native_window_for_frame(&kwin, 20, "Document").unwrap(), "kwin:first");
		kwin[1].title = "Document".into();
		assert!(native_window_for_frame(&kwin, 20, "Document — Editor").is_err());
	}

	#[test]
	fn focused_search_skips_null_child_refs() {
		use atspi::zbus::{
			connection::Builder as ConnectionBuilder, interface, zvariant::OwnedObjectPath,
		};

		/// Minimal `org.a11y.atspi.Accessible` node: a state set plus `(name,
		/// path)` children.
		struct Node {
			state:    Vec<u32>,
			children: Vec<(String, OwnedObjectPath)>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Node {
			fn get_state(&self) -> Vec<u32> {
				self.state.clone()
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				self.children.clone()
			}
		}

		const PEER: &str = ":1.7";
		let path = |p: &str| OwnedObjectPath::try_from(p).unwrap();
		let focused = State::Focused as u64;
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let found = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let root = Node {
				state:    vec![0, 0],
				// Chromium frames report children that are all the AT-SPI null object.
				children: vec![
					(PEER.to_owned(), path("/org/a11y/atspi/null")),
					(PEER.to_owned(), path("/focus")),
				],
			};
			let leaf =
				Node { state: vec![focused as u32, (focused >> 32) as u32], children: Vec::new() };
			let guid = atspi::zbus::Guid::generate();
			let server = ConnectionBuilder::unix_stream(server)
				.server(guid)
				.unwrap()
				.p2p()
				.serve_at("/root", root)
				.unwrap()
				.serve_at("/focus", leaf)
				.unwrap()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let root = ObjectRefOwned::from_static_str_unchecked(PEER, "/root");
			let found = AtSpiAx::find_focused(&client, root, 0).await;
			drop(server);
			found
		});
		let found = found.expect("null child refs must not fail the focused search");
		assert_eq!(
			found
				.map(|object| object.path_as_str().to_owned())
				.as_deref(),
			Some("/focus")
		);
	}
}
