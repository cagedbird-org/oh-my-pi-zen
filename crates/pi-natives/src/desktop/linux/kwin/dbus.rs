use std::{
	cell::RefCell,
	collections::HashMap,
	fs::OpenOptions,
	io::Write,
	os::unix::fs::OpenOptionsExt,
	sync::{
		Arc, LazyLock, Mutex, Weak,
		atomic::{AtomicU64, Ordering},
		mpsc,
	},
	time::Duration,
};

use zbus::{
	blocking::{Connection, Proxy},
	zvariant::OwnedValue,
};

use crate::desktop::error::{CoreResult, DesktopError};

pub(super) type Properties = HashMap<String, OwnedValue>;
pub(super) type RunnerMatch = (String, String, String, i32, f64, Properties);
const CALLBACK_PATH: &str = "/org/ohmypi/KWin";

fn require_active_window(expected: &str, active: Option<&str>) -> CoreResult<()> {
	if active == Some(expected) {
		Ok(())
	} else {
		Err(DesktopError::background_unavailable(format!(
			"KWin window {expected} lost focus; refusing foreground input"
		)))
	}
}
static SCRIPT_ID: AtomicU64 = AtomicU64::new(0);
static SCRIPT_LOCKS: LazyLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> =
	LazyLock::new(|| Mutex::new(HashMap::new()));

struct Reply(mpsc::Sender<String>);
#[zbus::interface(name = "org.ohmypi.KWin")]
impl Reply {
	fn result(&self, value: String) {
		let _ = self.0.send(value);
	}
}

#[derive(Default)]
struct TransientFocus {
	target:      String,
	parent:      String,
	last_active: String,
	closed:      bool,
	pending:     bool,
	returned:    bool,
}

impl TransientFocus {
	fn event(&mut self, closed: bool, active: &str) {
		if closed {
			self.closed = true;
			self.pending = self.last_active == self.target;
		}
		if self.closed && active.is_empty() {
			self.returned = false;
			self.pending = false;
		}
		if self.closed && !(closed && active == self.target) && !active.is_empty() {
			if active == self.parent {
				self.returned |= self.pending;
			} else {
				self.returned = false;
			}
			self.pending = false;
		}
		active.clone_into(&mut self.last_active);
	}
}

struct FocusRecorder(Arc<Mutex<TransientFocus>>);
#[zbus::interface(name = "org.ohmypi.KWin.Focus")]
impl FocusRecorder {
	fn event(&self, closed: bool, active: String) {
		if let Ok(mut state) = self.0.lock() {
			state.event(closed, &active);
		}
	}
}

pub(super) struct TransientWatch {
	connection:  Connection,
	name:        String,
	path:        std::path::PathBuf,
	object_path: String,
	state:       Arc<Mutex<TransientFocus>>,
}

impl TransientWatch {
	pub fn returned_to_parent(&self, current: Option<&str>) -> bool {
		self.state.lock().is_ok_and(|state| {
			state.closed && state.returned && current == Some(state.parent.as_str())
		})
	}
}

impl Drop for TransientWatch {
	fn drop(&mut self) {
		let _ = Proxy::new(&self.connection, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting")
			.and_then(|proxy| proxy.call::<_, _, bool>("unloadScript", &(self.name.as_str(),)));
		let _ = self
			.connection
			.object_server()
			.remove::<FocusRecorder, _>(self.object_path.as_str());
		let _ = std::fs::remove_file(&self.path);
	}
}

pub(super) struct KwinConnection {
	pub connection:  Connection,
	replies:         mpsc::Receiver<String>,
	script_lock:     Arc<Mutex<()>>,
	pub pixel_sizes: RefCell<HashMap<String, (u32, u32, f64)>>,
}

pub(super) fn failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::capture_failed(format!("KWin D-Bus: {error}"))
}

impl KwinConnection {
	pub fn new(address: Option<&str>) -> CoreResult<Self> {
		let (sender, replies) = mpsc::channel();
		let builder = match address {
			Some(address) => zbus::blocking::connection::Builder::address(address),
			None => zbus::blocking::connection::Builder::session(),
		}
		.map_err(failed)?;
		let connection = builder
			.serve_at(CALLBACK_PATH, Reply(sender))
			.map_err(failed)?
			.build()
			.map_err(failed)?;
		if !zbus::blocking::fdo::DBusProxy::new(&connection)
			.map_err(failed)?
			.name_has_owner("org.kde.KWin".try_into().map_err(failed)?)
			.map_err(failed)?
		{
			return Err(failed("org.kde.KWin is not available on the selected session bus"));
		}
		let bus_id = zbus::blocking::fdo::DBusProxy::new(&connection)
			.map_err(failed)?
			.get_id()
			.map_err(failed)?
			.to_string();
		let mut locks = SCRIPT_LOCKS.lock().map_err(failed)?;
		let script_lock = locks
			.get(&bus_id)
			.and_then(Weak::upgrade)
			.unwrap_or_else(|| {
				let lock = Arc::new(Mutex::new(()));
				locks.insert(bus_id, Arc::downgrade(&lock));
				lock
			});
		Ok(Self { connection, replies, script_lock, pixel_sizes: RefCell::new(HashMap::new()) })
	}

	pub fn proxy<'a>(&'a self, path: &'a str, interface: &'a str) -> CoreResult<Proxy<'a>> {
		Proxy::new(&self.connection, "org.kde.KWin", path, interface).map_err(failed)
	}

	pub fn accessibility_enabled(&self) -> CoreResult<bool> {
		let proxy = Proxy::new(
			&self.connection,
			"org.a11y.Bus",
			"/org/a11y/bus",
			"org.freedesktop.DBus.Properties",
		)
		.map_err(|error| DesktopError::ax_failed(format!("AT-SPI status proxy: {error}")))?;
		let value: OwnedValue = proxy
			.call("Get", &("org.a11y.Status", "IsEnabled"))
			.map_err(|error| DesktopError::ax_failed(format!("AT-SPI IsEnabled read: {error}")))?;
		bool::try_from(value)
			.map_err(|error| DesktopError::ax_failed(format!("AT-SPI IsEnabled value: {error}")))
	}

	pub fn enable_accessibility(&self) -> CoreResult<()> {
		Proxy::new(
			&self.connection,
			"org.a11y.Bus",
			"/org/a11y/bus",
			"org.freedesktop.DBus.Properties",
		)
		.and_then(|proxy| {
			proxy.call("Set", &("org.a11y.Status", "IsEnabled", zbus::zvariant::Value::from(true)))
		})
		.map_err(|error| DesktopError::ax_failed(format!("AT-SPI IsEnabled enable: {error}")))
	}

	/// One-shot scripts return directly to our bus object, never through the
	/// journal.
	pub fn script(&self, expression: &str) -> CoreResult<serde_json::Value> {
		let _guard = loop {
			crate::desktop::control::check()?;
			match self.script_lock.try_lock() {
				Ok(guard) => break guard,
				Err(std::sync::TryLockError::WouldBlock) => {
					crate::desktop::control::wait(Duration::from_millis(5))?;
				},
				Err(error) => return Err(failed(error)),
			}
		};
		let serial = SCRIPT_ID.fetch_add(1, Ordering::Relaxed);
		let name = format!("omp-{}-{serial}", std::process::id());
		let path = std::env::temp_dir().join(format!("{name}.js"));
		let destination = self
			.connection
			.unique_name()
			.ok_or_else(|| failed("missing unique bus name"))?;
		let source = format!(
			"try {{ var result = (function() {{ {expression} }})(); callDBus({}, '{}', \
			 'org.ohmypi.KWin', 'Result', JSON.stringify({{request:{serial},value:result}})); }} \
			 catch(e) {{ callDBus({}, '{}', 'org.ohmypi.KWin', 'Result', \
			 JSON.stringify({{request:{serial},error:String(e)}})); }}",
			serde_json::to_string(destination.as_str()).map_err(failed)?,
			CALLBACK_PATH,
			serde_json::to_string(destination.as_str()).map_err(failed)?,
			CALLBACK_PATH
		);
		let mut file = OpenOptions::new()
			.write(true)
			.create_new(true)
			.mode(0o600)
			.open(&path)
			.map_err(failed)?;
		let result = (|| {
			file.write_all(source.as_bytes()).map_err(failed)?;
			let scripting = self.proxy("/Scripting", "org.kde.kwin.Scripting")?;
			crate::desktop::control::check()?;
			let id: i32 = scripting
				.call("loadScript", &(path.to_string_lossy().as_ref(), name.as_str()))
				.map_err(failed)?;
			if id < 0 {
				return Err(failed("KWin refused to load the query script"));
			}
			let result = (|| {
				crate::desktop::control::check()?;
				let script_path = format!("/Scripting/Script{id}");
				self
					.proxy(&script_path, "org.kde.kwin.Script")?
					.call::<_, _, ()>("run", &())
					.map_err(failed)?;
				let deadline = std::time::Instant::now() + Duration::from_secs(2);
				loop {
					crate::desktop::control::check()?;
					let remaining = deadline.saturating_duration_since(std::time::Instant::now());
					if remaining.is_zero() {
						return Err(failed("script callback timed out"));
					}
					let reply = match self
						.replies
						.recv_timeout(remaining.min(Duration::from_millis(10)))
					{
						Ok(reply) => reply,
						Err(mpsc::RecvTimeoutError::Timeout) => continue,
						Err(error) => return Err(failed(error)),
					};
					let result: serde_json::Value = serde_json::from_str(&reply).map_err(failed)?;
					if result["request"].as_u64() != Some(serial) {
						continue;
					}
					if let Some(error) = result.get("error") {
						return Err(failed(error));
					}
					return Ok(result["value"].clone());
				}
			})();
			let cleanup: zbus::Result<bool> = scripting.call("unloadScript", &(name.as_str(),));
			match (result, cleanup) {
				(Ok(value), Ok(_)) => Ok(value),
				(Err(error), _) => Err(error),
				(_, Err(error)) => Err(failed(error)),
			}
		})();
		let cleanup = std::fs::remove_file(path).map_err(failed);
		match result {
			Ok(value) => cleanup.map(|()| value),
			Err(error) => Err(error),
		}
	}

	pub fn watch_transient(&self, target: &str) -> CoreResult<Option<TransientWatch>> {
		let target_json = serde_json::to_string(target).map_err(failed)?;
		let parent = self.script(&format!(
			"for (var w of workspace.windowList()) {{ if (String(w.internalId)==={target_json}) \
			 return w.transientFor ? String(w.transientFor.internalId) : null; }} return null;"
		))?;
		let Some(parent) = parent.as_str() else {
			return Ok(None);
		};
		let serial = SCRIPT_ID.fetch_add(1, Ordering::Relaxed);
		let name = format!("omp-transient-{}-{serial}", std::process::id());
		let path = std::env::temp_dir().join(format!("{name}.js"));
		let object_path = format!("/org/ohmypi/KWin/Focus{serial}");
		let state = Arc::new(Mutex::new(TransientFocus {
			target: target.to_owned(),
			parent: parent.to_owned(),
			..Default::default()
		}));
		self
			.connection
			.object_server()
			.at(object_path.as_str(), FocusRecorder(state.clone()))
			.map_err(failed)?;
		let watch =
			TransientWatch { connection: self.connection.clone(), name, path, object_path, state };
		let destination = serde_json::to_string(
			self
				.connection
				.unique_name()
				.ok_or_else(|| failed("missing unique bus name"))?
				.as_str(),
		)
		.map_err(failed)?;
		let source = format!(
			"var target=null; for (var w of workspace.windowList()) {{ if \
			 (String(w.internalId)==={target_json}) target=w; }} if (target) {{ function \
			 event(closed) {{ var active=workspace.activeWindow; callDBus({destination}, '{}', \
			 'org.ohmypi.KWin.Focus', 'Event', closed, active ? String(active.internalId) : ''); }} \
			 event(false); workspace.windowActivated.connect(function() {{ event(false); }}); \
			 target.closed.connect(function() {{ event(true); }}); }}",
			watch.object_path
		);
		let mut file = OpenOptions::new()
			.write(true)
			.create_new(true)
			.mode(0o600)
			.open(&watch.path)
			.map_err(failed)?;
		file.write_all(source.as_bytes()).map_err(failed)?;
		let id: i32 = self
			.proxy("/Scripting", "org.kde.kwin.Scripting")?
			.call("loadScript", &(watch.path.to_string_lossy().as_ref(), watch.name.as_str()))
			.map_err(failed)?;
		if id < 0 {
			return Err(failed("KWin refused to load transient focus watcher"));
		}
		self
			.proxy(&format!("/Scripting/Script{id}"), "org.kde.kwin.Script")?
			.call::<_, _, ()>("run", &())
			.map_err(failed)?;
		Ok(Some(watch))
	}

	pub fn active_window(&self) -> CoreResult<Option<String>> {
		let value = self.script(
			"return workspace.activeWindow ? String(workspace.activeWindow.internalId) : null;",
		)?;
		Ok(value.as_str().map(ToOwned::to_owned))
	}

	pub fn require_active(&self, uuid: &str) -> CoreResult<()> {
		crate::desktop::control::check()?;
		require_active_window(uuid, self.active_window()?.as_deref())
	}

	pub fn activate_if_active(&self, uuid: &str, expected: &str) -> CoreResult<()> {
		crate::desktop::control::check()?;
		let uuid = serde_json::to_string(uuid).map_err(failed)?;
		let expected = serde_json::to_string(expected).map_err(failed)?;
		self.script(&format!(
			"var active=workspace.activeWindow; if (!active || \
			 String(active.internalId)!=={expected}) return false; for (var w of \
			 workspace.windowList()) {{ if (String(w.internalId)==={uuid}) {{ w.minimized=false; \
			 workspace.activeWindow=w; return true; }} }} return false;"
		))?;
		Ok(())
	}

	pub fn activate(&self, uuid: &str) -> CoreResult<()> {
		crate::desktop::control::check()?;
		let uuid_json = serde_json::to_string(uuid).map_err(failed)?;
		let value = self.script(&format!(
			"var windows = workspace.windowList(); for (var i=0; i<windows.length; ++i) {{ var \
			 w=windows[i]; if (String(w.internalId)==={uuid_json}) {{ w.minimized=false; \
			 workspace.activeWindow=w; return true; }} }} return false;"
		))?;
		if value != true {
			return Err(DesktopError::window_not_found(format!(
				"KWin window {uuid} no longer exists"
			)));
		}
		let deadline = std::time::Instant::now() + Duration::from_millis(800);
		loop {
			crate::desktop::control::check()?;
			if self.active_window()?.as_deref() == Some(uuid) {
				return Ok(());
			}
			if std::time::Instant::now() >= deadline {
				return Err(DesktopError::input_failed(format!("KWin did not activate window {uuid}")));
			}
			crate::desktop::control::wait(Duration::from_millis(10))?;
		}
	}
}

pub(super) fn number(properties: &Properties, name: &str) -> CoreResult<f64> {
	let value = properties
		.get(name)
		.ok_or_else(|| failed(format!("missing {name}")))?;
	if let Ok(number) = f64::try_from(value) {
		return Ok(number);
	}
	if let Ok(number) = u32::try_from(value) {
		return Ok(f64::from(number));
	}
	if let Ok(number) = i32::try_from(value) {
		return Ok(f64::from(number));
	}
	Err(failed(format!("invalid numeric {name}")))
}
pub(super) fn boolean(properties: &Properties, name: &str) -> bool {
	properties
		.get(name)
		.and_then(|value| bool::try_from(value).ok())
		.unwrap_or(false)
}
pub(super) fn string(properties: &Properties, name: &str) -> String {
	properties
		.get(name)
		.and_then(|value| <&str>::try_from(value).ok())
		.unwrap_or_default()
		.to_owned()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn dialog_focus() -> TransientFocus {
		TransientFocus {
			target: "dialog".into(),
			parent: "parent".into(),
			last_active: "dialog".into(),
			..Default::default()
		}
	}

	#[test]
	fn transient_close_accepts_only_immediate_parent_fallback() {
		let mut focus = dialog_focus();
		focus.event(true, "dialog");
		focus.event(false, "parent");
		assert!(focus.closed && focus.returned);
		focus.event(false, "other");
		focus.event(false, "parent");
		assert!(!focus.returned, "a subsequent user choice must not inherit restoration ownership");
		let mut focus = dialog_focus();
		focus.event(true, "parent");
		assert!(focus.returned);
		focus.event(false, "");
		focus.event(false, "parent");
		assert!(!focus.returned);
	}

	#[test]
	fn transient_close_losing_active_window_invalidates_pending_fallback() {
		let mut focus = dialog_focus();
		focus.event(true, "dialog");
		assert!(focus.pending);
		focus.event(false, "");
		assert!(!focus.pending);
		assert!(!focus.returned);
		focus.event(false, "parent");
		assert!(
			!focus.returned,
			"selecting the parent after focus disappeared is not direct fallback"
		);
	}

	#[test]
	fn transient_close_rejects_unrelated_or_user_selected_focus() {
		let mut focus = dialog_focus();
		focus.event(false, "parent");
		assert!(!focus.returned, "parent selection while dialog remains open is not fallback");
		focus.event(true, "parent");
		assert!(!focus.returned, "dialog closure after user changed focus is not ours");
		let mut focus = dialog_focus();
		focus.event(true, "other");
		focus.event(false, "parent");
		assert!(!focus.returned, "closing must fall directly to the transient parent");
	}
	#[test]
	fn focus_gate_rejects_changed_or_missing_active_window() {
		require_active_window("target", Some("target")).unwrap();
		assert!(require_active_window("target", Some("other")).is_err());
		assert!(require_active_window("target", None).is_err());
	}
}
