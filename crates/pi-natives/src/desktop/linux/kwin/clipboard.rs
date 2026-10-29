//! A short-lived text selection followed by a live owner for the original MIME
//! data.
//!
//! Use a dedicated connection, never process-global Wayland environment
//! overrides. A restored selection must keep its owner alive until the
//! compositor cancels it.
use std::{
	collections::HashMap,
	fs::File,
	io::{self, Read, Write},
	os::{
		fd::{AsFd, AsRawFd, OwnedFd},
		unix::net::UnixStream,
	},
	path::PathBuf,
	sync::{
		Arc,
		mpsc::{self, Receiver, Sender},
	},
	thread,
	time::{Duration, Instant},
};

use wayland_client::{
	Connection, Dispatch, EventQueue, Proxy, QueueHandle,
	backend::ObjectId,
	protocol::{wl_callback, wl_registry, wl_seat},
};
use wayland_protocols::ext::data_control::v1::client::{
	ext_data_control_device_v1 as ext_device, ext_data_control_manager_v1 as ext_manager,
	ext_data_control_offer_v1 as ext_offer, ext_data_control_source_v1 as ext_source,
};
use wayland_protocols_wlr::data_control::v1::client::{
	zwlr_data_control_device_v1 as wlr_device, zwlr_data_control_manager_v1 as wlr_manager,
	zwlr_data_control_offer_v1 as wlr_offer, zwlr_data_control_source_v1 as wlr_source,
};

use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
};

const MIME_LIMIT: usize = 16 * 1024 * 1024;
const TOTAL_LIMIT: usize = 64 * 1024 * 1024;
const TRANSFER_TIMEOUT: Duration = Duration::from_millis(500);
const READ_WAIT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const TEXT_MIMES: [&str; 5] =
	["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "TEXT", "STRING"];

type MimeData = Vec<(String, Arc<[u8]>)>;

fn failed(context: &str, error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("Wayland clipboard {context}: {error}"))
}

fn display_path(display: Option<&str>) -> CoreResult<PathBuf> {
	let name = display
		.map(str::to_owned)
		.or_else(|| std::env::var("WAYLAND_DISPLAY").ok())
		.unwrap_or_else(|| "wayland-0".to_owned());
	let path = PathBuf::from(name);
	if path.is_absolute() {
		return Ok(path);
	}
	let runtime = std::env::var_os("XDG_RUNTIME_DIR")
		.ok_or_else(|| failed("connection", "XDG_RUNTIME_DIR is unset for a relative display"))?;
	Ok(PathBuf::from(runtime).join(path))
}

fn text_data(text: &str) -> MimeData {
	let bytes: Arc<[u8]> = Arc::from(text.as_bytes());
	let mut data: MimeData = TEXT_MIMES
		.iter()
		.map(|mime| ((*mime).to_owned(), bytes.clone()))
		.collect();
	data.push(("x-kde-passwordManagerHint".to_owned(), Arc::from(&b"secret"[..])));
	data
}

/// Paste on the caller's thread; the private Wayland thread serves requests
/// while the callback runs. Even cancellation/paste failure waits for
/// restoration.
pub(super) fn with_text_clipboard(
	display: Option<&str>,
	text: &str,
	paste: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	control::check()?;
	let path = display_path(display)?;
	let data = text_data(text);
	let (ready_tx, ready_rx) = mpsc::channel();
	let (read_tx, read_rx) = mpsc::channel();
	let (paste_tx, paste_rx) = mpsc::channel();
	let (restore_tx, restore_rx) = mpsc::channel();
	let (done_tx, done_rx) = mpsc::channel();
	thread::Builder::new()
		.name("kwin-clipboard".into())
		.spawn(move || {
			let result =
				run_owner(path, data, ready_tx.clone(), read_tx, paste_rx, restore_rx, &done_tx);
			if let Err(error) = result {
				// One receiver may already have gone away; the other still needs an
				// error.
				let _ = ready_tx.send(Err(error.clone()));
				let _ = done_tx.send(Err(error));
			}
		})
		.map_err(|error| failed("owner thread", error))?;
	ready_rx
		.recv()
		.map_err(|error| failed("starting owner", error))??;
	thread::sleep(Duration::from_millis(25));
	let paste_result = (|| {
		control::check()?;
		paste_tx
			.send(())
			.map_err(|error| failed("arming paste read", error))?;
		ready_rx
			.recv()
			.map_err(|error| failed("waiting for paste arm", error))??;
		control::check()?;
		paste()
	})();
	let read_result = if paste_result.is_ok() {
		let deadline = Instant::now() + READ_WAIT;
		loop {
			if let Err(error) = control::check() {
				break Err(error);
			}
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				break Ok(());
			}
			match read_rx.recv_timeout(remaining.min(POLL_INTERVAL)) {
				Ok(result) => break result,
				Err(mpsc::RecvTimeoutError::Timeout) => {},
				Err(error) => break Err(failed("waiting for paste read", error)),
			}
		}
	} else {
		Ok(())
	};
	let restored = control::cleanup(|| {
		restore_tx
			.send(())
			.map_err(|error| failed("requesting restoration", error))?;
		done_rx
			.recv()
			.map_err(|error| failed("restoring selection", error))?
	});
	// Restoration failures must not disappear behind an earlier paste failure.
	restored?;
	paste_result?;
	read_result
}

enum Manager {
	Ext(ext_manager::ExtDataControlManagerV1),
	Wlr(wlr_manager::ZwlrDataControlManagerV1),
}
enum Device {
	Ext(ext_device::ExtDataControlDeviceV1),
	Wlr(wlr_device::ZwlrDataControlDeviceV1),
}
#[derive(Clone)]
enum Offer {
	Ext(ext_offer::ExtDataControlOfferV1),
	Wlr(wlr_offer::ZwlrDataControlOfferV1),
}
enum Source {
	Ext(ext_source::ExtDataControlSourceV1),
	Wlr(wlr_source::ZwlrDataControlSourceV1),
}

impl Offer {
	fn receive(&self, mime: String, fd: &UnixStream) {
		match self {
			Self::Ext(v) => v.receive(mime, fd.as_fd()),
			Self::Wlr(v) => v.receive(mime, fd.as_fd()),
		}
	}

	fn destroy(&self) {
		match self {
			Self::Ext(v) => v.destroy(),
			Self::Wlr(v) => v.destroy(),
		}
	}
}
impl Source {
	fn destroy(&self) {
		match self {
			Self::Ext(v) => v.destroy(),
			Self::Wlr(v) => v.destroy(),
		}
	}
}
impl Manager {
	fn device(&self, seat: &wl_seat::WlSeat, qh: &QueueHandle<State>) -> Device {
		match self {
			Self::Ext(v) => Device::Ext(v.get_data_device(seat, qh, ())),
			Self::Wlr(v) => Device::Wlr(v.get_data_device(seat, qh, ())),
		}
	}

	fn source(&self, data: Arc<Payload>, qh: &QueueHandle<State>) -> Source {
		match self {
			Self::Ext(v) => {
				let source = v.create_data_source(qh, data.clone());
				for (mime, _) in &data.data {
					source.offer(mime.clone());
				}
				Source::Ext(source)
			},
			Self::Wlr(v) => {
				let source = v.create_data_source(qh, data.clone());
				for (mime, _) in &data.data {
					source.offer(mime.clone());
				}
				Source::Wlr(source)
			},
		}
	}
}
impl Device {
	fn select(&self, source: Option<&Source>) {
		match (self, source) {
			(Self::Ext(v), Some(Source::Ext(s))) => v.set_selection(Some(s)),
			(Self::Wlr(v), Some(Source::Wlr(s))) => v.set_selection(Some(s)),
			(Self::Ext(v), None) => v.set_selection(None),
			(Self::Wlr(v), None) => v.set_selection(None),
			_ => unreachable!("source and device use the same data-control manager"),
		}
	}
}

struct Payload {
	data:     MimeData,
	restored: bool,
}
struct PendingWrite {
	file:        File,
	bytes:       Arc<[u8]>,
	offset:      usize,
	deadline:    Instant,
	report_read: bool,
}
#[derive(Default)]
struct State {
	globals:              Vec<(u32, String, u32)>,
	offers:               HashMap<ObjectId, (Offer, Vec<String>)>,
	selection:            Option<ObjectId>,
	selection_generation: u64,
	temporary_cancelled:  bool,
	synced:               bool,
	finished:             bool,
	restored_cancelled:   bool,
	pasting:              bool,
	read_tx:              Option<Sender<CoreResult<()>>>,
	writes:               Vec<PendingWrite>,
}
impl State {
	fn select(&mut self, selected: Option<ObjectId>) {
		self.offers.retain(|id, (offer, _)| {
			if Some(id) == selected.as_ref() {
				true
			} else {
				offer.destroy();
				false
			}
		});
		self.selection = selected;
		self.selection_generation = self.selection_generation.wrapping_add(1);
	}

	fn send(&mut self, mime: &str, fd: OwnedFd, data: &Payload) {
		let Some((_, bytes)) = data.data.iter().find(|(name, _)| name == mime) else {
			return;
		};
		let file = File::from(fd);
		// The compositor may pass a pipe; socket timeouts alone do not cover it.
		// SAFETY: fcntl only changes flags on this live, exclusively owned fd.
		unsafe {
			let flags = libc::fcntl(file.as_raw_fd(), libc::F_GETFL);
			if flags == -1
				|| libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) == -1
			{
				return;
			}
		}
		self.writes.push(PendingWrite {
			file,
			bytes: bytes.clone(),
			offset: 0,
			deadline: Instant::now() + TRANSFER_TIMEOUT,
			report_read: !data.restored && self.pasting && TEXT_MIMES.contains(&mime),
		});
	}

	fn cancelled(&mut self, restored: bool) {
		if restored {
			self.restored_cancelled = true;
		} else {
			self.temporary_cancelled = true;
			if let Some(tx) = self.read_tx.take() {
				let _ = tx.send(Err(failed("ownership", "selection was replaced during paste")));
			}
		}
	}

	fn write_pending(&mut self) {
		let read_tx = &mut self.read_tx;
		self.writes.retain_mut(|write| {
			if Instant::now() >= write.deadline {
				return false;
			}
			while write.offset < write.bytes.len() {
				match write.file.write(&write.bytes[write.offset..]) {
					Ok(0) => return false,
					Ok(count) => write.offset += count,
					Err(error) if error.kind() == io::ErrorKind::WouldBlock => return true,
					Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
					Err(_) => return false,
				}
			}
			if write.report_read
				&& let Some(tx) = read_tx.take()
			{
				let _ = tx.send(Ok(()));
			}
			false
		});
	}
}

fn pump(
	connection: &Connection,
	queue: &mut EventQueue<State>,
	state: &mut State,
) -> CoreResult<()> {
	queue
		.dispatch_pending(state)
		.map_err(|error| failed("dispatching events", error))?;
	state.write_pending();
	connection
		.flush()
		.map_err(|error| failed("flushing requests", error))?;
	if let Some(guard) = queue.prepare_read() {
		let mut fd = libc::pollfd {
			fd:      connection.as_fd().as_raw_fd(),
			events:  libc::POLLIN,
			revents: 0,
		};
		// SAFETY: poll borrows one initialized descriptor for a bounded time.
		let result = unsafe { libc::poll(&mut fd, 1, POLL_INTERVAL.as_millis() as i32) };
		if result < 0 {
			let error = io::Error::last_os_error();
			if error.kind() != io::ErrorKind::Interrupted {
				return Err(failed("polling events", error));
			}
		} else if result > 0 {
			guard
				.read()
				.map_err(|error| failed("reading events", error))?;
		}
	}
	queue
		.dispatch_pending(state)
		.map_err(|error| failed("dispatching events", error))?;
	state.write_pending();
	if state.finished {
		return Err(failed("data-control device", "compositor finished the device"));
	}
	Ok(())
}

fn sync(
	connection: &Connection,
	queue: &mut EventQueue<State>,
	state: &mut State,
) -> CoreResult<()> {
	state.synced = false;
	connection.display().sync(&queue.handle(), ());
	let deadline = Instant::now() + READ_WAIT;
	while !state.synced {
		if Instant::now() >= deadline {
			return Err(failed("synchronizing", "compositor timed out"));
		}
		pump(connection, queue, state)?;
	}
	Ok(())
}

// Read one complete MIME only. Never restore a silently truncated
// representation.
fn read_bounded(mut stream: UnixStream, remaining: usize) -> io::Result<Option<Arc<[u8]>>> {
	let limit = MIME_LIMIT.min(remaining);
	let deadline = Instant::now() + TRANSFER_TIMEOUT;
	let mut bytes = Vec::new();
	let mut buffer = [0u8; 8192];
	loop {
		let remaining_time = deadline.saturating_duration_since(Instant::now());
		if remaining_time.is_zero() {
			return Ok(None);
		}
		stream.set_read_timeout(Some(remaining_time))?;
		match stream.read(&mut buffer) {
			Ok(0) => return Ok(Some(Arc::from(bytes))),
			Ok(count) => {
				if count > limit.saturating_sub(bytes.len()) {
					return Ok(None);
				}
				bytes.extend_from_slice(&buffer[..count]);
			},
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			Err(error)
				if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) =>
			{
				return Ok(None);
			},
			Err(error) => return Err(error),
		}
	}
}

fn backup(
	connection: &Connection,
	queue: &mut EventQueue<State>,
	state: &mut State,
) -> CoreResult<MimeData> {
	let generation = state.selection_generation;
	let Some((offer, mimes)) = state
		.selection
		.as_ref()
		.and_then(|id| state.offers.get(id))
		.cloned()
	else {
		return Ok(Vec::new());
	};
	let mut result = Vec::new();
	let mut total = 0;
	for mime in mimes {
		if total >= TOTAL_LIMIT {
			break;
		}
		let (read, write) =
			UnixStream::pair().map_err(|error| failed("creating receive pipe", error))?;
		offer.receive(mime.clone(), &write);
		connection
			.flush()
			.map_err(|error| failed("requesting original MIME", error))?;
		drop(write);
		// An owner can disappear or refuse one MIME. Preserve the other formats.
		if let Ok(Some(bytes)) = read_bounded(read, TOTAL_LIMIT - total) {
			total += bytes.len();
			result.push((mime, bytes));
		}
		sync(connection, queue, state)?;
		if state.selection_generation != generation {
			return Err(failed("backup", "selection changed; leaving the new clipboard untouched"));
		}
	}
	Ok(result)
}

fn verify_selection(
	connection: &Connection,
	queue: &mut EventQueue<State>,
	state: &mut State,
	expected: &[u8],
) -> CoreResult<()> {
	let generation = state.selection_generation;
	let Some((offer, mimes)) = state
		.selection
		.as_ref()
		.and_then(|id| state.offers.get(id))
		.cloned()
	else {
		return Err(failed("ownership", "temporary clipboard selection has no readable offer"));
	};
	let mime = mimes
		.into_iter()
		.find(|mime| TEXT_MIMES.contains(&mime.as_str()))
		.ok_or_else(|| failed("ownership", "temporary clipboard selection has no text MIME"))?;
	let (mut read, write) =
		UnixStream::pair().map_err(|error| failed("creating receive pipe", error))?;
	offer.receive(mime, &write);
	connection
		.flush()
		.map_err(|error| failed("requesting clipboard verification", error))?;
	drop(write);
	// The offer may belong to this same connection. Keep serving its Send
	// events while the reader drains the pipe; a blocking read here deadlocks
	// against our own source and can only time out.
	read
		.set_nonblocking(true)
		.map_err(|error| failed("clipboard verification pipe", error))?;
	let deadline = Instant::now() + TRANSFER_TIMEOUT;
	let mut actual_len = 0;
	let mut buffer = [0u8; 8192];
	loop {
		match read.read(&mut buffer) {
			Ok(0) => break,
			Ok(count) => {
				if count > expected.len().saturating_sub(actual_len)
					|| buffer[..count] != expected[actual_len..actual_len + count]
				{
					return Err(failed(
						"ownership",
						"temporary clipboard readback did not match the requested text",
					));
				}
				actual_len += count;
			},
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
				if Instant::now() >= deadline {
					return Err(failed("ownership", "temporary clipboard readback timed out"));
				}
				pump(connection, queue, state)?;
			},
			Err(error) => return Err(failed("reading clipboard verification", error)),
		}
	}
	sync(connection, queue, state)?;
	if state.selection_generation != generation || state.temporary_cancelled {
		return Err(failed("ownership", "temporary clipboard selection changed before paste"));
	}
	if actual_len != expected.len() {
		return Err(failed(
			"ownership",
			"temporary clipboard readback did not match the requested text",
		));
	}
	Ok(())
}

fn run_owner(
	path: PathBuf,
	data: MimeData,
	ready: Sender<CoreResult<()>>,
	read: Sender<CoreResult<()>>,
	paste: Receiver<()>,
	restore: Receiver<()>,
	done: &Sender<CoreResult<()>>,
) -> CoreResult<()> {
	let stream = UnixStream::connect(&path)
		.map_err(|error| failed(&format!("connecting to {}", path.display()), error))?;
	let connection = Connection::from_socket(stream).map_err(|error| failed("connecting", error))?;
	let mut queue = connection.new_event_queue();
	let qh = queue.handle();
	let mut state = State { read_tx: Some(read), ..State::default() };
	let registry = connection.display().get_registry(&qh, ());
	sync(&connection, &mut queue, &mut state)?;
	let seat_id = state
		.globals
		.iter()
		.find(|(_, name, _)| name == "wl_seat")
		.ok_or_else(|| failed("initializing", "display has no wl_seat"))?
		.0;
	let seat = registry.bind::<wl_seat::WlSeat, _, _>(seat_id, 1, &qh, ());
	let manager = if let Some((id, ..)) = state
		.globals
		.iter()
		.find(|(_, name, _)| name == "ext_data_control_manager_v1")
	{
		Manager::Ext(registry.bind(*id, 1, &qh, ()))
	} else if let Some((id, ..)) = state
		.globals
		.iter()
		.find(|(_, name, _)| name == "zwlr_data_control_manager_v1")
	{
		Manager::Wlr(registry.bind(*id, 1, &qh, ()))
	} else {
		return Err(failed("initializing", "display supports neither ext nor wlr data-control"));
	};
	let device = manager.device(&seat, &qh);
	sync(&connection, &mut queue, &mut state)?;
	let generation = state.selection_generation;
	let original = backup(&connection, &mut queue, &mut state)?;
	sync(&connection, &mut queue, &mut state)?;
	if state.selection_generation != generation {
		return Err(failed("backup", "selection changed; leaving the new clipboard untouched"));
	}
	let expected = data
		.iter()
		.find(|(mime, _)| TEXT_MIMES.contains(&mime.as_str()))
		.map(|(_, bytes)| bytes.clone())
		.ok_or_else(|| failed("ownership", "temporary clipboard has no text payload"))?;
	let temporary = manager.source(Arc::new(Payload { data, restored: false }), &qh);
	device.select(Some(&temporary));
	// Everything after taking ownership goes through the restoration path.
	let serving: CoreResult<()> = (|| {
		sync(&connection, &mut queue, &mut state)?;
		if state.temporary_cancelled {
			return Err(failed("ownership", "selection was replaced before paste"));
		}
		verify_selection(&connection, &mut queue, &mut state, &expected)?;
		let _ = ready.send(Ok(()));
		loop {
			if !state.pasting && paste.try_recv().is_ok() {
				// Drain eager clipboard-manager reads and our own verification
				// before acknowledging the caller's paste boundary. Only a text
				// transfer begun afterwards can complete the paste wait.
				sync(&connection, &mut queue, &mut state)?;
				if state.temporary_cancelled {
					return Err(failed("ownership", "selection was replaced before paste"));
				}
				state.pasting = true;
				let _ = ready.send(Ok(()));
			}
			match restore.try_recv() {
				Ok(()) | Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
				Err(mpsc::TryRecvError::Empty) => pump(&connection, &mut queue, &mut state)?,
			}
		}
	})();
	// Dispatch queued cancellation before deciding whether the old snapshot is
	// still ours to restore. A third-party copy always wins over this operation.
	sync(&connection, &mut queue, &mut state)?;
	let restored = if state.temporary_cancelled || original.is_empty() {
		None
	} else {
		Some(manager.source(Arc::new(Payload { data: original, restored: true }), &qh))
	};
	if !state.temporary_cancelled {
		device.select(restored.as_ref());
		sync(&connection, &mut queue, &mut state)?;
	}
	temporary.destroy();
	connection
		.flush()
		.map_err(|error| failed("releasing temporary source", error))?;
	if let Err(error) = &serving {
		let _ = ready.send(Err(error.clone()));
	}
	let _ = done.send(serving);
	while (!state.restored_cancelled && restored.is_some()) || !state.writes.is_empty() {
		pump(&connection, &mut queue, &mut state)?;
	}
	if let Some(source) = restored {
		source.destroy();
	}
	Ok(())
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
	fn event(
		state: &mut Self,
		_: &wl_registry::WlRegistry,
		event: wl_registry::Event,
		(): &(),
		_: &Connection,
		_: &QueueHandle<Self>,
	) {
		if let wl_registry::Event::Global { name, interface, version } = event {
			state.globals.push((name, interface, version));
		}
	}
}
impl Dispatch<wl_callback::WlCallback, ()> for State {
	fn event(
		state: &mut Self,
		_: &wl_callback::WlCallback,
		_: wl_callback::Event,
		(): &(),
		_: &Connection,
		_: &QueueHandle<Self>,
	) {
		state.synced = true;
	}
}
wayland_client::delegate_noop!(State: ignore wl_seat::WlSeat);
wayland_client::delegate_noop!(State: ignore ext_manager::ExtDataControlManagerV1);
wayland_client::delegate_noop!(State: ignore wlr_manager::ZwlrDataControlManagerV1);

// The protocols have identical event shapes; keep one ownership implementation.
macro_rules! dispatch_data_control {
	($device:ident, $device_ty:ident, $offer:ident, $offer_ty:ident, $source:ident, $source_ty:ident, $variant:ident) => {
		impl Dispatch<$device::$device_ty, ()> for State {
			fn event(state: &mut Self, _: &$device::$device_ty, event: $device::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
				match event {
					$device::Event::DataOffer { id } => { state.offers.insert(id.id(), (Offer::$variant(id), Vec::new())); },
					$device::Event::Selection { id } => state.select(id.map(|offer| offer.id())),
					$device::Event::PrimarySelection { id: Some(offer) } => {
						if let Some((offer, _)) = state.offers.remove(&offer.id()) { offer.destroy(); }
					},
					$device::Event::Finished => state.finished = true,
					_ => {},
				}
			}
			wayland_client::event_created_child!(State, $device::$device_ty, [
				$device::EVT_DATA_OFFER_OPCODE => ($offer::$offer_ty, ())
			]);
		}
		impl Dispatch<$offer::$offer_ty, ()> for State {
			fn event(state: &mut Self, proxy: &$offer::$offer_ty, event: $offer::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
				if let $offer::Event::Offer { mime_type } = event {
					if let Some((_, mimes)) = state.offers.get_mut(&proxy.id()) {
						if !mimes.contains(&mime_type) { mimes.push(mime_type); }
					}
				}
			}
		}
		impl Dispatch<$source::$source_ty, Arc<Payload>> for State {
			fn event(state: &mut Self, _: &$source::$source_ty, event: $source::Event, data: &Arc<Payload>, _: &Connection, _: &QueueHandle<Self>) {
				match event {
					$source::Event::Send { mime_type, fd } => state.send(&mime_type, fd, data),
					$source::Event::Cancelled => state.cancelled(data.restored),
					_ => {},
				}
			}
		}
	};
}
dispatch_data_control!(
	ext_device,
	ExtDataControlDeviceV1,
	ext_offer,
	ExtDataControlOfferV1,
	ext_source,
	ExtDataControlSourceV1,
	Ext
);
dispatch_data_control!(
	wlr_device,
	ZwlrDataControlDeviceV1,
	wlr_offer,
	ZwlrDataControlOfferV1,
	wlr_source,
	ZwlrDataControlSourceV1,
	Wlr
);

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn pre_paste_reads_do_not_complete_paste_and_writes_finish_before_ack() {
		let (tx, rx) = mpsc::channel();
		let mut state = State { read_tx: Some(tx), ..State::default() };
		let payload = Payload { data: text_data("requested text"), restored: false };
		for pasting in [false, true] {
			state.pasting = pasting;
			let (read, write) = UnixStream::pair().unwrap();
			state.send(TEXT_MIMES[0], write.into(), &payload);
			assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
			state.write_pending();
			assert_eq!(&*read_bounded(read, 100).unwrap().unwrap(), b"requested text");
			if pasting {
				rx.try_recv().unwrap().unwrap();
			} else {
				assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
			}
		}
	}

	#[test]
	fn text_formats_share_bytes_and_hide_history() {
		let data = text_data("你好 world");
		assert_eq!(data.len(), 6);
		for ((name, bytes), expected) in data.iter().zip(TEXT_MIMES) {
			assert_eq!(name, expected);
			assert_eq!(&**bytes, "你好 world".as_bytes());
			assert!(Arc::ptr_eq(bytes, &data[0].1));
		}
		assert_eq!(data[5].0, "x-kde-passwordManagerHint");
		assert_eq!(&*data[5].1, b"secret");
	}

	fn bounded(bytes: Vec<u8>, budget: usize) -> Option<Arc<[u8]>> {
		let (read, mut write) = UnixStream::pair().unwrap();
		let writer = thread::spawn(move || {
			let _ = write.write_all(&bytes);
		});
		let result = read_bounded(read, budget).unwrap();
		writer.join().unwrap();
		result
	}

	#[test]
	fn backup_limits_never_keep_partial_data() {
		assert_eq!(&*bounded(vec![1; 8], 8).unwrap(), &[1; 8]);
		assert!(bounded(vec![1; 9], 8).is_none());
		assert!(bounded(vec![1; MIME_LIMIT + 1], TOTAL_LIMIT).is_none());
		assert_eq!(bounded(Vec::new(), 0).unwrap().len(), 0);
		assert!(bounded(vec![1], 0).is_none());
	}

	#[test]
	fn unresponsive_mime_is_skipped() {
		let (read, _write) = UnixStream::pair().unwrap();
		assert!(read_bounded(read, TOTAL_LIMIT).unwrap().is_none());
	}

	#[test]
	fn absolute_display_does_not_use_runtime_environment() {
		assert_eq!(
			display_path(Some("/private/nested/socket")).unwrap(),
			PathBuf::from("/private/nested/socket")
		);
	}

	fn nested_connection(path: &str) -> (Connection, EventQueue<State>, State, Manager, Device) {
		let connection = Connection::from_socket(UnixStream::connect(path).unwrap()).unwrap();
		let mut queue = connection.new_event_queue();
		let mut state = State::default();
		let qh = queue.handle();
		let registry = connection.display().get_registry(&qh, ());
		sync(&connection, &mut queue, &mut state).unwrap();
		let seat_id = state
			.globals
			.iter()
			.find(|(_, name, _)| name == "wl_seat")
			.unwrap()
			.0;
		let seat = registry.bind::<wl_seat::WlSeat, _, _>(seat_id, 1, &qh, ());
		let manager_id = state
			.globals
			.iter()
			.find(|(_, name, _)| name == "ext_data_control_manager_v1")
			.unwrap()
			.0;
		let manager = Manager::Ext(registry.bind(manager_id, 1, &qh, ()));
		let device = manager.device(&seat, &qh);
		sync(&connection, &mut queue, &mut state).unwrap();
		(connection, queue, state, manager, device)
	}

	fn nested_read(path: &str) -> MimeData {
		let (connection, mut queue, mut state, _manager, _device) = nested_connection(path);
		backup(&connection, &mut queue, &mut state).unwrap()
	}

	fn nested_fixture(path: &str, data: MimeData) -> (Sender<()>, thread::JoinHandle<()>) {
		let path = path.to_owned();
		let (ready_tx, ready_rx) = mpsc::channel();
		let (stop_tx, stop_rx) = mpsc::channel();
		let owner = thread::spawn(move || {
			let (connection, mut queue, mut state, manager, device) = nested_connection(&path);
			let source = manager.source(Arc::new(Payload { data, restored: true }), &queue.handle());
			device.select(Some(&source));
			sync(&connection, &mut queue, &mut state).unwrap();
			ready_tx.send(()).unwrap();
			let mut stopped = false;
			loop {
				stopped |= !matches!(stop_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
				if (stopped || state.restored_cancelled) && state.writes.is_empty() {
					break;
				}
				pump(&connection, &mut queue, &mut state).unwrap();
			}
		});
		ready_rx.recv_timeout(READ_WAIT).unwrap();
		(stop_tx, owner)
	}

	fn stop_fixture((stop, owner): (Sender<()>, thread::JoinHandle<()>)) {
		let _ = stop.send(());
		owner.join().unwrap();
	}

	fn nested_takeover_during_paste(path: &str) {
		let original = nested_fixture(path, text_data("old snapshot"));
		let new_data = text_data("third-party copy during paste");
		let mut replacement = None;
		let error = with_text_clipboard(Some(path), "temporary text", || {
			replacement = Some(nested_fixture(path, new_data.clone()));
			Ok(())
		})
		.unwrap_err();
		assert!(error.to_string().contains("selection was replaced"));
		assert_eq!(nested_read(path), new_data);
		// The replaced temporary owner must not reappear after return either.
		assert_eq!(nested_read(path), new_data);
		stop_fixture(original);
		stop_fixture(replacement.unwrap());
	}

	fn nested_takeover_during_backup(path: &str) {
		let fixture_path = path.to_owned();
		let (ready_tx, ready_rx) = mpsc::channel();
		let (receiving_tx, receiving_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		let original = thread::spawn(move || {
			let (connection, mut queue, mut state, manager, device) = nested_connection(&fixture_path);
			let source = manager.source(
				Arc::new(Payload { data: text_data("old snapshot"), restored: true }),
				&queue.handle(),
			);
			device.select(Some(&source));
			sync(&connection, &mut queue, &mut state).unwrap();
			ready_tx.send(()).unwrap();
			// Queue a real receive request without writing its bytes yet. The
			// third-party owner will be installed before this backup can finish.
			let deadline = Instant::now() + READ_WAIT;
			while state.writes.is_empty() {
				assert!(Instant::now() < deadline, "backup did not request the fixture");
				queue.roundtrip(&mut state).unwrap();
				thread::sleep(POLL_INTERVAL);
			}
			receiving_tx.send(()).unwrap();
			resume_rx.recv_timeout(READ_WAIT).unwrap();
			while !state.restored_cancelled || !state.writes.is_empty() {
				pump(&connection, &mut queue, &mut state).unwrap();
			}
		});
		ready_rx.recv_timeout(READ_WAIT).unwrap();
		let input_path = path.to_owned();
		let (pasted_tx, pasted_rx) = mpsc::channel();
		let input = thread::spawn(move || {
			with_text_clipboard(Some(&input_path), "must not paste", || {
				pasted_tx.send(()).unwrap();
				Ok(())
			})
		});
		receiving_rx.recv_timeout(READ_WAIT).unwrap();
		let new_data = text_data("third-party copy during backup");
		let replacement = nested_fixture(path, new_data.clone());
		resume_tx.send(()).unwrap();
		let error = input.join().unwrap().unwrap_err();
		assert!(error.to_string().contains("selection changed"));
		assert!(pasted_rx.try_recv().is_err(), "paste callback must not run with a stale backup");
		original.join().unwrap();
		assert_eq!(nested_read(path), new_data);
		stop_fixture(replacement);
	}

	#[test]
	#[ignore = "requires OMP_CLIPBOARD_TEST_DISPLAY pointing at a private nested KWin socket"]
	fn nested_selection_roundtrip() {
		let path =
			std::env::var("OMP_CLIPBOARD_TEST_DISPLAY").expect("private nested display required");
		assert!(path.starts_with("/tmp/omp-clipboard-kwin-"), "refusing a non-private test display");
		let original: MimeData = vec![
			("text/plain;charset=utf-8".into(), Arc::from(&b"original clipboard"[..])),
			("image/png".into(), Arc::from(&b"\x89PNG\r\n\x1a\n\0binary fixture\xff"[..])),
		];
		let fixture = original.clone();
		let fixture_path = path.clone();
		let (ready_tx, ready_rx) = mpsc::channel();
		let fixture_owner = thread::spawn(move || {
			let (connection, mut queue, mut state, manager, device) = nested_connection(&fixture_path);
			let source =
				manager.source(Arc::new(Payload { data: fixture, restored: true }), &queue.handle());
			device.select(Some(&source));
			sync(&connection, &mut queue, &mut state).unwrap();
			ready_tx.send(()).unwrap();
			while !state.restored_cancelled || !state.writes.is_empty() {
				pump(&connection, &mut queue, &mut state).unwrap();
			}
		});
		ready_rx.recv().unwrap();
		assert_eq!(nested_read(&path), original);
		with_text_clipboard(Some(&path), "你好 world", || {
			assert_eq!(nested_read(&path), text_data("你好 world"));
			Ok(())
		})
		.unwrap();
		fixture_owner.join().unwrap();
		assert_eq!(nested_read(&path), original);
		// A second independent consumer after return needs a still-live owner.
		assert_eq!(nested_read(&path), original);
		let error =
			with_text_clipboard(Some(&path), "not pasted", || Err(failed("test", "paste failed")))
				.unwrap_err();
		assert!(error.to_string().contains("paste failed"));
		assert_eq!(nested_read(&path), original);
		let start = Instant::now();
		with_text_clipboard(Some(&path), "unread", || Ok(())).unwrap();
		assert!(start.elapsed() >= READ_WAIT);
		assert_eq!(nested_read(&path), original);
		// Clearing also cancels the final restored owner and tests empty backup.
		let (connection, mut queue, mut state, _manager, device) = nested_connection(&path);
		device.select(None);
		sync(&connection, &mut queue, &mut state).unwrap();
		assert!(nested_read(&path).is_empty());
		with_text_clipboard(Some(&path), "empty backup", || {
			assert_eq!(nested_read(&path), text_data("empty backup"));
			Ok(())
		})
		.unwrap();
		assert!(nested_read(&path).is_empty());
		nested_takeover_during_paste(&path);
		nested_takeover_during_backup(&path);
	}
}
