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
	#[test]
	fn focus_gate_rejects_changed_or_missing_active_window() {
		require_active_window("target", Some("target")).unwrap();
		assert!(require_active_window("target", Some("other")).is_err());
		assert!(require_active_window("target", None).is_err());
	}
}
