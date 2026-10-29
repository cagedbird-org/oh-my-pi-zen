pub mod ax;
pub mod dbus_bridge;
mod kwin;
mod menus;
pub mod wayland;
pub mod x11;

use super::{
	backend::Backend,
	error::{CoreResult, DesktopError},
	types::{DesktopSessionOptions, DisplaySelector},
};

pub fn new_backend(
	display: DisplaySelector,
	options: DesktopSessionOptions,
) -> CoreResult<Box<dyn Backend>> {
	if options.kwin_bus_address.is_some() {
		return Ok(Box::new(kwin::KwinBackend::new(display, &options)?));
	}
	if std::env::var_os("WAYLAND_DISPLAY").is_some()
		&& std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|desktop| {
			desktop
				.split(':')
				.any(|part| part.eq_ignore_ascii_case("KDE"))
		})
		&& kwin::available()
	{
		return Ok(Box::new(kwin::KwinBackend::new(display, &options)?));
	}
	if std::env::var_os("WAYLAND_DISPLAY").is_some() {
		return Ok(Box::new(wayland::WaylandBackend::new(display)));
	}
	if std::env::var_os("DISPLAY").is_some() {
		return Ok(Box::new(x11::X11Backend::new(display)?));
	}
	Err(DesktopError::capture_failed(
		"no display server (neither WAYLAND_DISPLAY nor DISPLAY is set)",
	))
}
