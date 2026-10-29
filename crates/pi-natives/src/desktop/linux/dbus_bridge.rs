//! Message-level forwarding for the nested desktop's explicitly allowed session
//! services.

use std::{
	collections::{HashMap, HashSet},
	env,
	sync::mpsc,
	thread,
	time::Duration,
};

use futures::TryStreamExt;
use napi::Error as NapiError;
use napi_derive::napi;
use tokio::{runtime::Builder as RuntimeBuilder, sync::oneshot, time::Instant};
use zbus::{
	Connection, MatchRule, Message, MessageStream,
	fdo::{DBusProxy, RequestNameFlags, RequestNameReply},
	message::{Builder, Flags, Type},
	names::WellKnownName,
};

// Wallet unlock prompts can legitimately wait for a human on the host desktop.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const START_TIMEOUT: Duration = Duration::from_secs(10);

#[napi]
pub struct SessionBusBridge {
	stop:   Option<oneshot::Sender<()>>,
	thread: Option<thread::JoinHandle<()>>,
}

#[napi]
impl SessionBusBridge {
	#[napi]
	pub fn stop(&mut self) {
		if let Some(stop) = self.stop.take() {
			let _ = stop.send(());
		}
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

impl Drop for SessionBusBridge {
	fn drop(&mut self) {
		self.stop();
	}
}

#[napi]
pub fn start_session_bus_bridge(
	private_address: String,
	names: Vec<String>,
) -> napi::Result<SessionBusBridge> {
	let host_address = env::var("DBUS_SESSION_BUS_ADDRESS")
		.map_err(|_| NapiError::from_reason("host session D-Bus address is unavailable"))?;
	start_bridge(private_address, host_address, names).map_err(NapiError::from_reason)
}

fn start_bridge(
	private_address: String,
	host_address: String,
	mut names: Vec<String>,
) -> Result<SessionBusBridge, String> {
	if names.is_empty() {
		return Err("session D-Bus bridge requires at least one name".into());
	}
	for name in &names {
		WellKnownName::try_from(name.as_str()).map_err(|error| error.to_string())?;
	}
	names.sort_unstable();
	names.dedup();
	let (stop, stopped) = oneshot::channel();
	let (ready, started) = mpsc::sync_channel(1);
	let thread = thread::Builder::new()
		.name("omp-dbus-bridge".into())
		.spawn(move || {
			let runtime = match RuntimeBuilder::new_current_thread().enable_all().build() {
				Ok(runtime) => runtime,
				Err(error) => {
					let _ = ready.send(Err(error.to_string()));
					return;
				},
			};
			runtime.block_on(async move {
				let initialized = tokio::time::timeout(START_TIMEOUT, async {
					let mut bridges = Vec::with_capacity(names.len());
					for name in names {
						bridges.push(Bridge::new(&private_address, &host_address, vec![name]).await?);
					}
					Ok::<_, zbus::Error>(bridges)
				})
				.await;
				let mut bridges = match initialized {
					Ok(Ok(bridges)) => bridges,
					result => {
						let reason = match result {
							Ok(Err(error)) => error.to_string(),
							Err(error) => error.to_string(),
							Ok(Ok(_)) => unreachable!(),
						};
						let _ = ready.send(Err(reason));
						return;
					},
				};
				let _ = ready.send(Ok(()));
				tokio::select! {
					_ = stopped => {},
					result = futures::future::try_join_all(bridges.iter_mut().map(Bridge::run)) => {
						if let Err(error) = result {
							log::warn!("session D-Bus bridge stopped: {error}");
						}
					},
				}
				// Dropping the run future cancels every in-flight send and owner
				// update.
				for bridge in bridges {
					let _ = bridge.private.close().await;
					let _ = bridge.host.close().await;
				}
			});
		})
		.map_err(|error| error.to_string())?;
	let mut bridge = SessionBusBridge { stop: Some(stop), thread: Some(thread) };
	match started.recv() {
		Ok(Ok(())) => Ok(bridge),
		result => {
			bridge.stop();
			Err(match result {
				Ok(Err(error)) => error,
				Err(error) => error.to_string(),
				Ok(Ok(())) => unreachable!(),
			})
		},
	}
}

struct PendingCall {
	original: Message,
	deadline: Instant,
}

struct Bridge {
	private:          Connection,
	private_address:  String,
	host:             Connection,
	private_messages: MessageStream,
	host_messages:    MessageStream,
	allowed:          HashSet<String>,
	owners:           HashMap<String, String>,
	pending:          HashMap<u32, PendingCall>,
}

impl Bridge {
	async fn new(
		private_address: &str,
		host_address: &str,
		names: Vec<String>,
	) -> zbus::Result<Self> {
		let private = zbus::connection::Builder::address(private_address)?
			.build()
			.await?;
		let host = zbus::connection::Builder::address(host_address)?
			.method_timeout(START_TIMEOUT)
			.build()
			.await?;
		// Subscribe before querying owners so an activation during startup cannot
		// be lost.
		let private_messages = MessageStream::from(&private);
		let host_messages = MessageStream::from(&host);
		let owner_rule = MatchRule::builder()
			.msg_type(Type::Signal)
			.sender("org.freedesktop.DBus")?
			.path("/org/freedesktop/DBus")?
			.interface("org.freedesktop.DBus")?
			.member("NameOwnerChanged")?
			.build();
		DBusProxy::new(&host)
			.await?
			.add_match_rule(owner_rule)
			.await?;
		let mut bridge = Self {
			private,
			private_address: private_address.into(),
			host,
			private_messages,
			host_messages,
			allowed: names.into_iter().collect(),
			owners: HashMap::new(),
			pending: HashMap::new(),
		};
		for name in bridge.allowed.clone() {
			bridge.update_owner(&name).await?;
		}
		Ok(bridge)
	}

	async fn update_owner(&mut self, name: &str) -> zbus::Result<()> {
		let host_bus = DBusProxy::new(&self.host).await?;
		// Re-query rather than applying a possibly stale queued NameOwnerChanged
		// event.
		let owner = match host_bus.get_name_owner(name.try_into()?).await {
			Ok(owner) => Some(owner.to_string()),
			Err(zbus::fdo::Error::NameHasNoOwner(_)) => None,
			Err(error) => return Err(error.into()),
		};
		if self.owners.get(name) == owner.as_ref() {
			return Ok(());
		}
		if let Some(previous) = self.owners.remove(name) {
			// A private unique owner identifies one host service incarnation.
			// Never let an old Secret Service session/item proxy reach a
			// replacement.
			for (_, call) in self.pending.drain() {
				self
					.private
					.reply_error(
						&call.original.header(),
						"org.freedesktop.DBus.Error.Disconnected",
						&"Host session service owner changed",
					)
					.await?;
			}
			self.private.clone().close().await?;
			self.private = zbus::connection::Builder::address(self.private_address.as_str())?
				.build()
				.await?;
			self.private_messages = MessageStream::from(&self.private);
			host_bus.remove_match_rule(signal_rule(&previous)?).await?;
		}
		if let Some(owner) = &owner {
			host_bus.add_match_rule(signal_rule(owner)?).await?;
			let result = DBusProxy::new(&self.private)
				.await?
				.request_name(name.try_into()?, RequestNameFlags::DoNotQueue.into())
				.await?;
			if !matches!(result, RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner) {
				return Err(zbus::Error::Failure(format!("nested D-Bus name {name} is already owned")));
			}
		}
		if let Some(owner) = owner {
			self.owners.insert(name.into(), owner);
		}
		Ok(())
	}

	async fn run(&mut self) -> zbus::Result<()> {
		let mut expiry = tokio::time::interval(Duration::from_millis(100));
		loop {
			tokio::select! {
				message = self.private_messages.try_next() => {
					let Some(message) = message? else { return Ok(()) };
					self.forward_call(message).await?;
				},
				message = self.host_messages.try_next() => {
					let Some(message) = message? else { return Ok(()) };
					self.forward_host(message).await?;
				},
				_ = expiry.tick() => {
					let now = Instant::now();
					let expired: Vec<_> = self.pending.iter()
						.filter_map(|(serial, call)| (call.deadline <= now).then_some(*serial))
						.collect();
					for serial in expired {
						if let Some(call) = self.pending.remove(&serial) {
							self.private.reply_error(&call.original.header(), "org.freedesktop.DBus.Error.Timeout", &"Host session service did not reply within 120 seconds").await?;
						}
					}
				},
			}
		}
	}

	async fn forward_call(&mut self, message: Message) -> zbus::Result<()> {
		if message.message_type() != Type::MethodCall {
			return Ok(());
		}
		let header = message.header();
		let Some(destination) = header.destination() else {
			return Ok(());
		};
		// Each private connection owns exactly one allowed name. libsecret pins
		// that name's private unique owner before calling dynamic session/item
		// objects; this route can only target the same configured host service.
		let owner = if self
			.private
			.unique_name()
			.is_some_and(|owner| owner.as_str() == destination.as_str())
		{
			self.owners.values().next()
		} else {
			self.owners.get(destination.as_str())
		};
		let Some(owner) = owner else {
			if !header.primary().flags().contains(Flags::NoReplyExpected) {
				self
					.private
					.reply_error(
						&header,
						"org.freedesktop.DBus.Error.AccessDenied",
						&"Destination is not an available bridged service",
					)
					.await?;
			}
			return Ok(());
		};
		let mut builder = Message::method_call(
			header.path().ok_or(zbus::Error::MissingField)?,
			header.member().ok_or(zbus::Error::MissingField)?,
		)?
		// Pin the host incarnation too: a queued NameOwnerChanged must not race
		// a well-known-name send into the replacement service.
		.destination(owner.as_str())?;
		if let Some(interface) = header.interface() {
			builder = builder.interface(interface.clone())?;
		}
		for flag in header.primary().flags() {
			builder = builder.with_flags(flag)?;
		}
		let forwarded = copy_body(builder, &message)?;
		let serial = forwarded.primary_header().serial_num().get();
		self.host.send(&forwarded).await?;
		if !header.primary().flags().contains(Flags::NoReplyExpected) {
			self.pending.insert(serial, PendingCall {
				original: message,
				deadline: Instant::now() + CALL_TIMEOUT,
			});
		}
		Ok(())
	}

	async fn forward_host(&mut self, message: Message) -> zbus::Result<()> {
		let header = message.header();
		match message.message_type() {
			Type::MethodReturn | Type::Error => {
				let Some(call) = header
					.reply_serial()
					.and_then(|serial| self.pending.remove(&serial.get()))
				else {
					return Ok(());
				};
				let original = call.original.header();
				let builder = if message.message_type() == Type::Error {
					Message::error(
						&original,
						header
							.error_name()
							.ok_or(zbus::Error::MissingField)?
							.clone(),
					)?
				} else {
					Message::method_return(&original)?
				};
				self.private.send(&copy_body(builder, &message)?).await?;
			},
			Type::Signal => {
				if header
					.sender()
					.is_some_and(|sender| sender.as_str() == "org.freedesktop.DBus")
					&& header
						.interface()
						.is_some_and(|interface| interface.as_str() == "org.freedesktop.DBus")
					&& header
						.member()
						.is_some_and(|member| member.as_str() == "NameOwnerChanged")
				{
					let (name, ..): (String, String, String) = message.body().deserialize()?;
					if self.allowed.contains(&name) {
						self.update_owner(&name).await?;
					}
				} else if header
					.sender()
					.is_some_and(|sender| self.owners.values().any(|owner| owner == sender.as_str()))
				{
					let builder = Message::signal(
						header.path().ok_or(zbus::Error::MissingField)?,
						header.interface().ok_or(zbus::Error::MissingField)?,
						header.member().ok_or(zbus::Error::MissingField)?,
					)?;
					self.private.send(&copy_body(builder, &message)?).await?;
				}
			},
			_ => {},
		}
		Ok(())
	}
}

fn signal_rule(owner: &str) -> zbus::Result<MatchRule<'_>> {
	Ok(MatchRule::builder()
		.msg_type(Type::Signal)
		.sender(owner)?
		.build())
}

fn copy_body(builder: Builder<'_>, message: &Message) -> zbus::Result<Message> {
	let body = message.body();
	let fds = message
		.data()
		.fds()
		.iter()
		.map(|fd| fd.try_clone().map(Into::into))
		.collect::<Result<Vec<_>, zbus::zvariant::Error>>()?;
	// SAFETY: the source body, signature, byte order, and descriptor ordering
	// are preserved.
	unsafe {
		builder
			.endian(message.primary_header().endian_sig().into())
			.build_raw_body(body.data().bytes(), body.signature(), fds)
	}
}

#[cfg(test)]
mod tests;
