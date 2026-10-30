//! Android has no desktop clipboard API available to a Termux process.

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::task;

/// Clipboard image payload encoded as PNG bytes.
#[napi(object)]
pub struct ClipboardImage {
	/// PNG-encoded image bytes.
	pub data:      Uint8Array,
	/// MIME type for the encoded image payload.
	pub mime_type: String,
}

/// Copying to the desktop clipboard is unsupported on Android.
#[napi]
pub fn copy_to_clipboard(_text: JsString) -> Result<()> {
	Err(Error::from_reason("Clipboard is unsupported on Android"))
}

/// Reading the desktop clipboard is unsupported on Android.
#[napi]
pub fn read_text_from_clipboard() -> task::Promise<Option<String>> {
	task::blocking("clipboard.read_text", (), |_| {
		Err(Error::from_reason("Clipboard is unsupported on Android"))
	})
}

/// Reading clipboard images is unsupported on Android.
#[napi]
pub fn read_image_from_clipboard() -> task::Promise<Option<ClipboardImage>> {
	task::blocking("clipboard.read_image", (), |_| {
		Err(Error::from_reason("Clipboard is unsupported on Android"))
	})
}
