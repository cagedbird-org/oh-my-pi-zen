use std::{
	collections::HashMap,
	fs::File,
	io::Read,
	path::PathBuf,
	process::{Child, Command, Stdio},
	sync::atomic::{AtomicU64, Ordering},
	time::Duration,
};

use futures::TryStreamExt;
use zbus::{
	Connection, MatchRule, MessageStream,
	fdo::DBusProxy,
	message::Type,
	zvariant::{OwnedFd, OwnedValue},
};

use super::{SessionBusBridge, start_bridge};

const NAME: &str = "org.freedesktop.secrets";
const PATH: &str = "/org/freedesktop/secrets";
const INTERFACE: &str = "org.example.BridgeTest";

struct Bus {
	child:         Child,
	address:       String,
	configuration: PathBuf,
}

impl Bus {
	fn start() -> Option<Self> {
		static NEXT_BUS: AtomicU64 = AtomicU64::new(0);
		let directory = std::env::temp_dir().join(format!(
			"omp-bridge-test-{}-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos(),
			NEXT_BUS.fetch_add(1, Ordering::Relaxed)
		));
		std::fs::create_dir(&directory).unwrap();
		let configuration = directory.join("bus.conf");
		std::fs::write(&configuration, br#"<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><policy context="default"><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>"#).unwrap();
		let mut child = match Command::new("dbus-daemon")
			.arg(format!("--config-file={}", configuration.display()))
			.args(["--nofork", "--print-address=1"])
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
		{
			Ok(child) => child,
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
				eprintln!("skipping real D-Bus test: dbus-daemon is unavailable");
				std::fs::remove_dir_all(&directory).unwrap();
				return None;
			},
			Err(error) => panic!("start dbus-daemon: {error}"),
		};
		// No activation directories are configured on either fixture bus.
		let mut address = String::new();
		std::io::BufRead::read_line(
			&mut std::io::BufReader::new(child.stdout.take().unwrap()),
			&mut address,
		)
		.unwrap();
		assert!(!address.is_empty(), "dbus-daemon did not publish its address");
		Some(Self { child, address: address.trim().into(), configuration })
	}

	async fn connect(&self) -> Connection {
		zbus::connection::Builder::address(self.address.as_str())
			.unwrap()
			.method_timeout(Duration::from_secs(3))
			.build()
			.await
			.unwrap()
	}

	fn bridge_to(&self, host: &Self) -> SessionBusBridge {
		start_bridge(self.address.clone(), host.address.clone(), vec![NAME.into()]).unwrap()
	}
}

impl Drop for Bus {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
		let _ = std::fs::remove_dir_all(self.configuration.parent().unwrap());
	}
}

struct Service(&'static str);

#[zbus::interface(name = "org.example.BridgeTest")]
impl Service {
	#[zbus(property)]
	fn label(&self) -> &str {
		"host-wallet"
	}

	fn identify(&self, value: &str) -> String {
		format!("{}:{value}", self.0)
	}

	fn denied(&self) -> zbus::fdo::Result<()> {
		Err(zbus::fdo::Error::AccessDenied("wallet is locked".into()))
	}

	fn descriptor(&self, descriptor: OwnedFd) -> OwnedFd {
		descriptor
	}
}

async fn service(bus: &Bus) -> Connection {
	zbus::connection::Builder::address(bus.address.as_str())
		.unwrap()
		.serve_at(PATH, Service("host"))
		.unwrap()
		.serve_at("/org/freedesktop/secrets/session/dynamic", Service("host"))
		.unwrap()
		.name(NAME)
		.unwrap()
		.build()
		.await
		.unwrap()
}

async fn owner(client: &Connection, name: &str, present: bool) {
	let bus = DBusProxy::new(client).await.unwrap();
	tokio::time::timeout(Duration::from_secs(3), async {
		loop {
			if bus.name_has_owner(name.try_into().unwrap()).await.unwrap() == present {
				break;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("bridge did not synchronize the host service owner");
}

#[tokio::test]
async fn nested_clients_receive_properties_dynamic_objects_errors_and_descriptors() {
	let Some(host) = Bus::start() else { return };
	let Some(private) = Bus::start() else { return };
	let _service = service(&host).await;
	let _bridge = private.bridge_to(&host);
	let client = private.connect().await;
	let property = client
		.call_method(
			Some(NAME),
			PATH,
			Some("org.freedesktop.DBus.Properties"),
			"Get",
			&(INTERFACE, "Label"),
		)
		.await
		.unwrap();
	assert_eq!(
		property
			.body()
			.deserialize::<OwnedValue>()
			.unwrap()
			.downcast_ref::<&str>()
			.unwrap(),
		"host-wallet"
	);
	let properties = client
		.call_method(
			Some(NAME),
			PATH,
			Some("org.freedesktop.DBus.Properties"),
			"GetAll",
			&(INTERFACE,),
		)
		.await
		.unwrap();
	let properties: HashMap<String, OwnedValue> = properties.body().deserialize().unwrap();
	assert_eq!(properties["Label"].downcast_ref::<&str>().unwrap(), "host-wallet");
	let dynamic = client
		.call_method(
			Some(NAME),
			"/org/freedesktop/secrets/session/dynamic",
			Some(INTERFACE),
			"Identify",
			&("session",),
		)
		.await
		.unwrap();
	assert_eq!(dynamic.body().deserialize::<String>().unwrap(), "host:session");
	let introspection = client
		.call_method(Some(NAME), PATH, Some("org.freedesktop.DBus.Introspectable"), "Introspect", &())
		.await
		.unwrap();
	assert!(
		introspection
			.body()
			.deserialize::<String>()
			.unwrap()
			.contains(INTERFACE)
	);
	let error = client
		.call_method(Some(NAME), PATH, Some(INTERFACE), "Denied", &())
		.await
		.unwrap_err();
	assert!(
		matches!(&error, zbus::Error::MethodError(name, text, _) if name.as_str() == "org.freedesktop.DBus.Error.AccessDenied" && text.as_deref() == Some("wallet is locked"))
	);
	let descriptor: OwnedFd =
		std::os::fd::OwnedFd::from(File::open("/etc/hostname").unwrap()).into();
	let reply = client
		.call_method(Some(NAME), PATH, Some(INTERFACE), "Descriptor", &(descriptor,))
		.await
		.unwrap();
	let descriptor: OwnedFd = reply.body().deserialize().unwrap();
	let mut actual = String::new();
	File::from(std::os::fd::OwnedFd::from(descriptor))
		.read_to_string(&mut actual)
		.unwrap();
	assert_eq!(actual, std::fs::read_to_string("/etc/hostname").unwrap());
}

#[tokio::test]
async fn only_allowed_services_and_their_signals_cross_the_bus_boundary() {
	let Some(host) = Bus::start() else { return };
	let Some(private) = Bus::start() else { return };
	let service = service(&host).await;
	service
		.request_name("org.example.HostPrivate")
		.await
		.unwrap();
	let mut bridge = private.bridge_to(&host);
	let client = private.connect().await;
	let rule = MatchRule::builder()
		.msg_type(Type::Signal)
		.interface(INTERFACE)
		.unwrap()
		.member("Changed")
		.unwrap()
		.build();
	let mut signals = MessageStream::for_match_rule(rule, &client, None)
		.await
		.unwrap();
	service
		.emit_signal(
			None::<&str>,
			"/org/freedesktop/secrets/session/dynamic",
			INTERFACE,
			"Changed",
			&("unlocked",),
		)
		.await
		.unwrap();
	let signal = tokio::time::timeout(Duration::from_secs(3), signals.try_next())
		.await
		.unwrap()
		.unwrap()
		.unwrap();
	assert_eq!(signal.header().path().unwrap().as_str(), "/org/freedesktop/secrets/session/dynamic");
	assert_eq!(signal.body().deserialize::<String>().unwrap(), "unlocked");
	let private_owner = DBusProxy::new(&client)
		.await
		.unwrap()
		.get_name_owner(NAME.try_into().unwrap())
		.await
		.unwrap();
	assert_eq!(signal.header().sender().unwrap(), &private_owner);
	let forbidden = client
		.call_method(Some("org.example.HostPrivate"), PATH, Some(INTERFACE), "Identify", &("leak",))
		.await;
	assert!(
		matches!(&forbidden, Err(zbus::Error::MethodError(name, _, _)) if name.as_str() == "org.freedesktop.DBus.Error.ServiceUnknown")
	);
	let pinned = client
		.call_method(Some(private_owner.as_str()), PATH, Some(INTERFACE), "Identify", &("pinned",))
		.await
		.unwrap();
	assert_eq!(pinned.body().deserialize::<String>().unwrap(), "host:pinned");
	let host_private = host.connect().await;
	let forbidden = client
		.call_method(
			Some(host_private.unique_name().unwrap().as_str()),
			PATH,
			Some(INTERFACE),
			"Identify",
			&("leak",),
		)
		.await;
	assert!(
		matches!(&forbidden, Err(zbus::Error::MethodError(name, _, _)) if name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner" || name.as_str() == "org.freedesktop.DBus.Error.ServiceUnknown")
	);
	bridge.stop();
	owner(&client, NAME, false).await;
	bridge.stop();
}

#[tokio::test]
async fn host_activation_disappearance_and_replacement_update_nested_names_and_signals() {
	let Some(host) = Bus::start() else { return };
	let Some(private) = Bus::start() else { return };
	let _bridge = private.bridge_to(&host);
	let client = private.connect().await;
	owner(&client, NAME, false).await;
	let service1 = service(&host).await;
	owner(&client, NAME, true).await;
	service1.release_name(NAME).await.unwrap();
	owner(&client, NAME, false).await;
	let service2 = service(&host).await;
	owner(&client, NAME, true).await;
	let rule = MatchRule::builder()
		.msg_type(Type::Signal)
		.interface(INTERFACE)
		.unwrap()
		.member("Changed")
		.unwrap()
		.build();
	let mut signals = MessageStream::for_match_rule(rule, &client, None)
		.await
		.unwrap();
	service1
		.emit_signal(None::<&str>, PATH, INTERFACE, "Changed", &("stale",))
		.await
		.unwrap();
	service2
		.emit_signal(None::<&str>, PATH, INTERFACE, "Changed", &("new-owner",))
		.await
		.unwrap();
	let signal = tokio::time::timeout(Duration::from_secs(3), signals.try_next())
		.await
		.unwrap()
		.unwrap()
		.unwrap();
	assert_eq!(signal.body().deserialize::<String>().unwrap(), "new-owner");
}

#[tokio::test]
async fn colliding_client_serials_no_reply_flags_and_stop_do_not_corrupt_calls() {
	let Some(host) = Bus::start() else { return };
	let Some(private) = Bus::start() else { return };
	let service = host.connect().await;
	let mut calls = MessageStream::from(&service);
	service.request_name(NAME).await.unwrap();
	let mut bridge = private.bridge_to(&host);
	let first = private.connect().await;
	let second = private.connect().await;
	let mut first_replies = MessageStream::from(&first);
	let mut second_replies = MessageStream::from(&second);
	let serial = std::num::NonZeroU32::new(42).unwrap();
	for (client, value) in [(&first, "first"), (&second, "second")] {
		let message = zbus::Message::method_call(PATH, "Identify")
			.unwrap()
			.destination(NAME)
			.unwrap()
			.interface(INTERFACE)
			.unwrap()
			.serial(serial)
			.build(&(value,))
			.unwrap();
		client.send(&message).await.unwrap();
	}
	let mut received = Vec::new();
	while received.len() < 2 {
		let call = tokio::time::timeout(Duration::from_secs(3), calls.try_next())
			.await
			.unwrap()
			.unwrap()
			.unwrap();
		if call.message_type() == Type::MethodCall {
			received.push(call);
		}
	}
	assert_ne!(received[0].primary_header().serial_num(), received[1].primary_header().serial_num());
	assert_eq!(received[0].header().sender(), received[1].header().sender());
	for call in received.iter().rev() {
		let value: String = call.body().deserialize().unwrap();
		service
			.reply(&call.header(), &format!("host:{value}"))
			.await
			.unwrap();
	}
	for (replies, expected) in
		[(&mut first_replies, "host:first"), (&mut second_replies, "host:second")]
	{
		loop {
			let reply = tokio::time::timeout(Duration::from_secs(3), replies.try_next())
				.await
				.unwrap()
				.unwrap()
				.unwrap();
			if reply.message_type() == Type::MethodReturn {
				assert_eq!(reply.header().reply_serial(), Some(serial));
				assert_eq!(reply.body().deserialize::<String>().unwrap(), expected);
				break;
			}
		}
	}
	let no_reply = zbus::Message::method_call(PATH, "Notify")
		.unwrap()
		.destination(NAME)
		.unwrap()
		.interface(INTERFACE)
		.unwrap()
		.with_flags(zbus::message::Flags::NoReplyExpected)
		.unwrap()
		.with_flags(zbus::message::Flags::NoAutoStart)
		.unwrap()
		.build(&())
		.unwrap();
	first.send(&no_reply).await.unwrap();
	loop {
		let call = tokio::time::timeout(Duration::from_secs(3), calls.try_next())
			.await
			.unwrap()
			.unwrap()
			.unwrap();
		if call.message_type() == Type::MethodCall {
			assert_eq!(call.primary_header().flags(), no_reply.primary_header().flags());
			break;
		}
	}
	let pending = zbus::Message::method_call(PATH, "Wait")
		.unwrap()
		.destination(NAME)
		.unwrap()
		.build(&())
		.unwrap();
	first.send(&pending).await.unwrap();
	loop {
		let call = tokio::time::timeout(Duration::from_secs(3), calls.try_next())
			.await
			.unwrap()
			.unwrap()
			.unwrap();
		if call.message_type() == Type::MethodCall {
			break;
		}
	}
	let stopped = std::time::Instant::now();
	bridge.stop();
	assert!(
		stopped.elapsed() < Duration::from_secs(1),
		"stop waited for the 120-second pending call timeout"
	);
	owner(&first, NAME, false).await;
}

#[test]
fn startup_errors_are_reported_before_returning_a_bridge_handle() {
	let result = start_bridge(
		"unix:path=/nonexistent/omp-nested-bus".into(),
		"unix:path=/nonexistent/omp-host-bus".into(),
		vec![NAME.into()],
	);
	assert!(result.is_err());
}

#[tokio::test]
async fn unique_owners_of_different_bridged_services_cannot_cross_route() {
	let Some(host) = Bus::start() else { return };
	let Some(private) = Bus::start() else { return };
	let _secrets = service(&host).await;
	let _notifications = zbus::connection::Builder::address(host.address.as_str())
		.unwrap()
		.serve_at(PATH, Service("notification"))
		.unwrap()
		.name("org.freedesktop.Notifications")
		.unwrap()
		.build()
		.await
		.unwrap();
	let _bridge = start_bridge(private.address.clone(), host.address.clone(), vec![
		NAME.into(),
		"org.freedesktop.Notifications".into(),
	])
	.unwrap();
	let client = private.connect().await;
	let bus = DBusProxy::new(&client).await.unwrap();
	let secrets_owner = bus.get_name_owner(NAME.try_into().unwrap()).await.unwrap();
	let notification_owner = bus
		.get_name_owner("org.freedesktop.Notifications".try_into().unwrap())
		.await
		.unwrap();
	assert_ne!(secrets_owner, notification_owner);
	for (owner, expected) in
		[(&secrets_owner, "host:pinned"), (&notification_owner, "notification:pinned")]
	{
		let reply = client
			.call_method(Some(owner.as_str()), PATH, Some(INTERFACE), "Identify", &("pinned",))
			.await
			.unwrap();
		assert_eq!(reply.body().deserialize::<String>().unwrap(), expected);
	}
}

#[tokio::test]
async fn replacing_host_owner_invalidates_private_owner_and_its_pending_calls() {
	let Some(host) = Bus::start() else { return };
	let Some(private) = Bus::start() else { return };
	let original = host.connect().await;
	let mut original_calls = MessageStream::from(&original);
	DBusProxy::new(&original)
		.await
		.unwrap()
		.request_name(
			NAME.try_into().unwrap(),
			zbus::fdo::RequestNameFlags::AllowReplacement | zbus::fdo::RequestNameFlags::DoNotQueue,
		)
		.await
		.unwrap();
	let _bridge = private.bridge_to(&host);
	let client = private.connect().await;
	let old_owner = DBusProxy::new(&client)
		.await
		.unwrap()
		.get_name_owner(NAME.try_into().unwrap())
		.await
		.unwrap();
	let rule = MatchRule::builder()
		.msg_type(Type::Signal)
		.sender("org.freedesktop.DBus")
		.unwrap()
		.interface("org.freedesktop.DBus")
		.unwrap()
		.member("NameOwnerChanged")
		.unwrap()
		.build();
	let mut changes = MessageStream::for_match_rule(rule, &client, None)
		.await
		.unwrap();
	let pending_client = client.clone();
	let old_destination = old_owner.to_string();
	let pending = tokio::spawn(async move {
		pending_client
			.call_method(Some(old_destination.as_str()), PATH, Some(INTERFACE), "Wait", &())
			.await
	});
	let original_call = loop {
		let message = tokio::time::timeout(Duration::from_secs(3), original_calls.try_next())
			.await
			.unwrap()
			.unwrap()
			.unwrap();
		if message.message_type() == Type::MethodCall {
			assert_eq!(
				message.header().destination().unwrap().as_str(),
				original.unique_name().unwrap().as_str()
			);
			break message;
		}
	};
	let replacement = zbus::connection::Builder::address(host.address.as_str())
		.unwrap()
		.serve_at(PATH, Service("replacement"))
		.unwrap()
		.build()
		.await
		.unwrap();
	DBusProxy::new(&replacement)
		.await
		.unwrap()
		.request_name(
			NAME.try_into().unwrap(),
			zbus::fdo::RequestNameFlags::ReplaceExisting | zbus::fdo::RequestNameFlags::DoNotQueue,
		)
		.await
		.unwrap();
	let mut removed_old_owner = false;
	let new_owner = tokio::time::timeout(Duration::from_secs(3), async {
		loop {
			let change = changes.try_next().await.unwrap().unwrap();
			let (name, previous, current): (String, String, String) =
				change.body().deserialize().unwrap();
			if name != NAME {
				continue;
			}
			if previous == old_owner.as_str() && current.is_empty() {
				removed_old_owner = true;
			}
			if !current.is_empty() && current != old_owner.as_str() {
				break current;
			}
		}
	})
	.await
	.unwrap();
	assert!(
		removed_old_owner,
		"private clients did not observe their old service incarnation disappear"
	);
	let error = pending.await.unwrap().unwrap_err();
	assert!(
		matches!(&error, zbus::Error::MethodError(name, _, _) if name.as_str() == "org.freedesktop.DBus.Error.Disconnected")
	);
	let stale = client
		.call_method(Some(old_owner.as_str()), PATH, Some(INTERFACE), "Identify", &("stale",))
		.await;
	assert!(
		matches!(&stale, Err(zbus::Error::MethodError(name, _, _)) if name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner" || name.as_str() == "org.freedesktop.DBus.Error.ServiceUnknown")
	);
	// A late reply from the old host instance cannot complete a new client's
	// call.
	original
		.reply(&original_call.header(), &"late-old-reply")
		.await
		.unwrap();
	let reply = client
		.call_method(Some(new_owner.as_str()), PATH, Some(INTERFACE), "Identify", &("fresh",))
		.await
		.unwrap();
	assert_eq!(reply.body().deserialize::<String>().unwrap(), "replacement:fresh");
}
