//! Images from the clipboard and from dropped files, as raw bytes for the page to downscale.
//! Formats the webview can't draw (TIFF, HEIC, BMP) are turned into PNG first.

use base64::Engine;
use objc2::rc::Retained;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
use objc2_foundation::{NSData, NSDictionary, NSString, NSURL};
use serde::Serialize;
use std::path::Path;

const MAX_BYTES: u64 = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawImage {
    pub data_base64: String,
    pub mime: String,
}

fn raw(bytes: &[u8], mime: &str) -> RawImage {
    RawImage { data_base64: base64::engine::general_purpose::STANDARD.encode(bytes), mime: mime.into() }
}

/// The image on the clipboard, if there is one.
pub fn paste_image() -> Option<RawImage> {
    let pasteboard = NSPasteboard::generalPasteboard();
    // A file copied in Finder also puts its icon on the clipboard as TIFF, so look at the file
    // first, and don't fall back to the icon when the file isn't an image.
    if let Some(url) = unsafe { pasteboard.stringForType(NSPasteboardTypeFileURL) } {
        let path = NSURL::URLWithString(&url).and_then(|u| u.path()).map(|p| p.to_string())?;
        return read_image(Path::new(&path)).ok();
    }
    if let Some(data) = unsafe { pasteboard.dataForType(NSPasteboardTypePNG) } {
        let bytes = data.to_vec();
        return (bytes.len() as u64 <= MAX_BYTES).then(|| raw(&bytes, "image/png"));
    }
    let jpeg = NSString::from_str("public.jpeg");
    if let Some(data) = pasteboard.dataForType(&jpeg) {
        let bytes = data.to_vec();
        return (bytes.len() as u64 <= MAX_BYTES).then(|| raw(&bytes, "image/jpeg"));
    }
    let tiff = unsafe { pasteboard.dataForType(NSPasteboardTypeTIFF) }?;
    let png = to_png(&tiff)?;
    (png.len() as u64 <= MAX_BYTES).then(|| raw(&png, "image/png"))
}

/// A dropped or picked image file.
pub fn read_image(path: &Path) -> Result<RawImage, String> {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err("That isn't an image".into());
    }
    let size = std::fs::metadata(path).map_err(|_| "Couldn't read that file".to_string())?.len();
    if size > MAX_BYTES {
        return Err("That image is too big (over 25 MB)".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Couldn't read that file".to_string())?;
    if let Some(mime) = sniff(&bytes) {
        return Ok(raw(&bytes, mime));
    }
    let png = to_png(&NSData::with_bytes(&bytes)).ok_or("Aside can't read that kind of image")?;
    Ok(raw(&png, "image/png"))
}

/// The mime type of an image the webview can draw, from its first bytes.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// Any image macOS can decode, as PNG.
fn to_png(data: &NSData) -> Option<Vec<u8>> {
    let rep: Retained<NSBitmapImageRep> = NSBitmapImageRep::imageRepWithData(data)?;
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(png.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_web_formats() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(b"\xFF\xD8\xFF\xE0"), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"II*\0"), None);
    }

    #[test]
    fn rejects_non_images_and_converts_tiff() {
        let dir = std::env::temp_dir().join(format!("aside-img-{}", crate::store::random_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let text = dir.join("notes.txt");
        std::fs::write(&text, "hello").unwrap();
        assert_eq!(read_image(&text), Err("That isn't an image".into()));
        let fake = dir.join("fake.png");
        std::fs::write(&fake, "not really").unwrap();
        assert!(read_image(&fake).is_err());
        // A 1×1 PNG, turned into TIFF by `sips`, which macOS always has.
        let png = dir.join("one.png");
        std::fs::write(&png, base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==").unwrap()).unwrap();
        assert_eq!(read_image(&png).unwrap().mime, "image/png");
        let tiff = dir.join("one.tiff");
        let made = std::process::Command::new("sips").args(["-s", "format", "tiff"]).arg(&png).arg("--out").arg(&tiff).output().unwrap();
        assert!(made.status.success());
        let converted = read_image(&tiff).unwrap();
        assert_eq!(converted.mime, "image/png");
        let bytes = base64::engine::general_purpose::STANDARD.decode(converted.data_base64).unwrap();
        assert_eq!(sniff(&bytes), Some("image/png"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
