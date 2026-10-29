use std::{
	fs::File,
	io::Read,
	os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd},
	time::{Duration, Instant},
};

use image::RgbaImage;
use zbus::zvariant::{Fd, Value};

use super::dbus::{self, KwinConnection, Properties};
use crate::desktop::error::{CoreResult, DesktopError};

pub(super) struct Captured {
	pub image: RgbaImage,
	pub scale: f64,
}
impl KwinConnection {
	pub fn capture(&self, window: Option<&str>, screen: Option<&str>) -> CoreResult<Captured> {
		let mut fds = [-1; 2];
		// SAFETY: pipe2 initializes exactly two descriptors, owned below on
		// success.
		if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
			return Err(dbus::failed(std::io::Error::last_os_error()));
		}
		// SAFETY: successful pipe2 returned two unique owned descriptors.
		let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
		let options = std::collections::HashMap::from([
			("include-decoration", Value::from(true)),
			("include-shadow", Value::from(false)),
			("native-resolution", Value::from(true)),
			("hide-caller-windows", Value::from(false)),
		]);
		let proxy = self.proxy("/org/kde/KWin/ScreenShot2", "org.kde.KWin.ScreenShot2")?;
		let metadata: Properties = match (window, screen) {
			(Some(uuid), _) => proxy.call("CaptureWindow", &(uuid, options, Fd::from(write.as_fd()))),
			(_, Some(name)) => proxy.call("CaptureScreen", &(name, options, Fd::from(write.as_fd()))),
			_ => proxy.call("CaptureWorkspace", &(options, Fd::from(write.as_fd()))),
		}
		.map_err(dbus::failed)?;
		drop(write);
		let width = dbus::number(&metadata, "width")? as u32;
		let height = dbus::number(&metadata, "height")? as u32;
		let stride = dbus::number(&metadata, "stride")? as usize;
		let format = dbus::number(&metadata, "format")? as u32;
		let scale = dbus::number(&metadata, "scale")?;
		validate(width, height, stride, scale)?;
		let size = stride
			.checked_mul(height as usize)
			.ok_or_else(|| dbus::failed("capture buffer overflow"))?;
		let bytes = read_pixels(read, size, Duration::from_secs(5))?;
		let image = decode(width, height, stride, format, scale, bytes)?;
		if let Some(screen) = screen {
			self
				.pixel_sizes
				.borrow_mut()
				.insert(screen.to_owned(), (width, height, scale));
		}
		Ok(Captured { image, scale })
	}
}

fn read_pixels(fd: OwnedFd, size: usize, timeout: Duration) -> CoreResult<Vec<u8>> {
	let deadline = Instant::now() + timeout;
	let mut file = File::from(fd);
	let mut bytes = Vec::with_capacity(size);
	let mut buffer = [0_u8; 16_384];
	loop {
		crate::desktop::control::check()?;
		let remaining = deadline.saturating_duration_since(Instant::now());
		if remaining.is_zero() {
			return Err(dbus::failed("screenshot pixel read timed out"));
		}
		let mut pollfd =
			libc::pollfd { fd: file.as_raw_fd(), events: libc::POLLIN, revents: 0 };
		// SAFETY: one valid pollfd, with an operation-bounded timeout.
		let ready = unsafe { libc::poll(&mut pollfd, 1, remaining.as_millis().clamp(1, 10) as i32) };
		if ready < 0 {
			let error = std::io::Error::last_os_error();
			if error.kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			return Err(dbus::failed(error));
		}
		if ready == 0 {
			continue;
		}
		match file.read(&mut buffer) {
			Ok(0) => return Ok(bytes),
			Ok(count) => {
				if bytes.len().saturating_add(count) > size {
					return Err(dbus::failed("screenshot exceeds declared pixel size"));
				}
				bytes.extend_from_slice(&buffer[..count]);
			},
			Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
			Err(error) => return Err(dbus::failed(error)),
		}
	}
}

fn validate(width: u32, height: u32, stride: usize, scale: f64) -> CoreResult<()> {
	if width == 0
		|| height == 0
		|| u64::from(width) * u64::from(height) > crate::desktop::frame::MAX_COMPOSITE_PIXELS
		|| stride < width as usize * 4
		|| !scale.is_finite()
		|| scale <= 0.0
	{
		return Err(dbus::failed("invalid screenshot dimensions, stride or scale"));
	}
	Ok(())
}

/// `QImage` 4/5/6 are native-endian RGB32/ARGB32/premultiplied ARGB32;
/// 16/17/18 are byte-ordered RGBX8888/RGBA8888/premultiplied RGBA8888.
fn decode(
	width: u32,
	height: u32,
	stride: usize,
	format: u32,
	scale: f64,
	mut bytes: Vec<u8>,
) -> CoreResult<RgbaImage> {
	validate(width, height, stride, scale)?;
	if ![4, 5, 6, 16, 17, 18].contains(&format) {
		return Err(DesktopError::capture_failed(format!("unsupported KWin QImage format {format}")));
	}
	if stride.checked_mul(height as usize) != Some(bytes.len()) {
		return Err(dbus::failed("screenshot byte count does not match stride × height"));
	}
	if format == 17 && stride == width as usize * 4 {
		return RgbaImage::from_raw(width, height, bytes)
			.ok_or_else(|| dbus::failed("invalid RGBA screenshot"));
	}
	for y in 0..height as usize {
		for x in 0..width as usize {
			let source = y * stride + x * 4;
			let pixel: [u8; 4] = bytes[source..source + 4].try_into().map_err(dbus::failed)?;
			let (mut r, mut g, mut b, a) = if [16, 17, 18].contains(&format) {
				(pixel[0], pixel[1], pixel[2], if format == 16 { 255 } else { pixel[3] })
			} else {
				let argb = u32::from_ne_bytes(pixel);
				(
					(argb >> 16) as u8,
					(argb >> 8) as u8,
					argb as u8,
					if format == 4 { 255 } else { (argb >> 24) as u8 },
				)
			};
			if (format == 6 || format == 18) && a != 255 {
				let straight = |channel: u8| {
					if a == 0 {
						0
					} else {
						((u32::from(channel) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8
					}
				};
				r = straight(r);
				g = straight(g);
				b = straight(b);
			}
			let destination = (y * width as usize + x) * 4;
			bytes[destination..destination + 4].copy_from_slice(&[r, g, b, a]);
		}
	}
	bytes.truncate(width as usize * height as usize * 4);
	RgbaImage::from_raw(width, height, bytes).ok_or_else(|| dbus::failed("invalid RGBA screenshot"))
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn pixel_pipe_read_times_out_and_closes() {
		let mut fds = [-1; 2];
		// SAFETY: valid storage for two descriptors.
		assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
		// SAFETY: these descriptors were just created and are uniquely owned.
		let (read, _write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
		assert!(
			read_pixels(read, 4, Duration::from_millis(5))
				.unwrap_err()
				.to_string()
				.contains("timed out")
		);
	}
	#[test]
	fn converts_qimage_formats_and_padding() {
		assert_eq!(
			decode(1, 1, 8, 18, 1.25, vec![64, 32, 16, 128, 0, 0, 0, 0])
				.unwrap()
				.as_raw(),
			&[128, 64, 32, 128]
		);
		for format in [4, 5, 6] {
			let word = if format == 6 {
				0x80402010_u32
			} else {
				0xff804020
			};
			let image = decode(1, 1, 4, format, 2.0, word.to_ne_bytes().to_vec()).unwrap();
			assert_eq!(&image.as_raw()[..3], &[128, 64, 32]);
		}
		assert_eq!(decode(1, 1, 4, 17, 1.0, vec![1, 2, 3, 4]).unwrap().as_raw(), &[1, 2, 3, 4]);
		assert_eq!(
			decode(1, 2, 8, 18, 1.0, vec![1, 2, 3, 255, 9, 9, 9, 9, 64, 32, 16, 128, 9, 9, 9, 9])
				.unwrap()
				.as_raw(),
			&[1, 2, 3, 255, 128, 64, 32, 128]
		);
		assert_eq!(decode(1, 1, 4, 18, 1.0, vec![9, 8, 7, 0]).unwrap().as_raw(), &[0, 0, 0, 0]);
		assert_eq!(decode(1, 1, 4, 16, 1.0, vec![1, 2, 3, 0]).unwrap().as_raw(), &[1, 2, 3, 255]);
	}
	#[test]
	fn rejects_invalid_metadata() {
		for (stride, format, scale, bytes) in [
			(3, 18, 1.0, vec![0; 3]),
			(4, 99, 1.0, vec![0; 4]),
			(4, 18, 0.0, vec![0; 4]),
			(4, 18, f64::NAN, vec![0; 4]),
			(4, 18, 1.0, vec![0; 3]),
		] {
			assert!(decode(1, 1, stride, format, scale, bytes).is_err());
		}
	}
	#[test]
	fn scaled_window_pixels_map_to_logical_coordinates() {
		use crate::desktop::{frame::FrameGeometry, types::DesktopWindow};
		let window = DesktopWindow {
			id:        "kwin:{01234567-89ab-cdef-0123-456789abcdef}".into(),
			title:     String::new(),
			app:       String::new(),
			pid:       None,
			x:         -400,
			y:         80,
			width:     800,
			height:    600,
			focused:   false,
			minimized: Some(false),
		};
		let frame = FrameGeometry::for_window(&window, 1000, 750);
		assert_eq!(frame.map_point(500.0, 375.0, Some(&window)).unwrap(), (0.0, 380.0));
		let moved = DesktopWindow { x: 100, y: 200, ..window };
		assert_eq!(frame.map_point(500.0, 375.0, Some(&moved)).unwrap(), (500.0, 500.0));
	}
}
