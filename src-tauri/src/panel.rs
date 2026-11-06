//! The chat panel: a non-activating floating panel that a global shortcut shows over whatever
//! app is in front, so that app keeps its place and gets focus back when the panel goes.
//! It's created hidden at launch and kept around, so showing it is instant.

use crate::settings::{self, Position};
use crate::{chat, tray};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEvent, NSScreen};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_nspanel::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub const LABEL: &str = "panel";
const CARD_WIDTH: f64 = 468.0;
/// Room around the card for its shadow.
const MARGIN_SIDE: f64 = 32.0;
const MARGIN_TOP: f64 = 24.0;
const MARGIN_BOTTOM: f64 = 56.0;
/// From the screen edge when `position` is `right`.
const EDGE_GAP: f64 = 16.0;
/// The page animates out in ~120ms; hide anyway if it hasn't asked by then.
const CLOSE_FALLBACK: Duration = Duration::from_millis(400);

/// In its own module because the macro brings its own AppKit imports along.
mod ns {
    use tauri::{AppHandle, LogicalSize, Size, WebviewUrl};
    use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};

    tauri_panel! {
        panel!(AsidePanel {
            config: {
                can_become_key_window: true,
                is_floating_panel: true
            }
        })

        panel_event!(AsidePanelEvents {
            window_did_resign_key(notification: &NSNotification) -> ()
        })
    }

    pub fn build(app: &AppHandle, width: f64, on_resign_key: impl Fn() + 'static) -> tauri::Result<()> {
        let panel = PanelBuilder::<_, AsidePanel>::new(app, super::LABEL)
            .url(WebviewUrl::App("index.html".into()))
            .size(Size::Logical(LogicalSize::new(width, 600.0)))
            .level(PanelLevel::ModalPanel)
            .transparent(true)
            .has_shadow(false)
            .hides_on_deactivate(false)
            .add_style_mask(StyleMask::empty().nonactivating_panel())
            .collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().ignores_cycle())
            .title("Aside")
            .with_window(|w| w.decorations(false).transparent(true).visible(false).resizable(false).skip_taskbar(true))
            .no_activate(true)
            .build()?;
        let events = AsidePanelEvents::new();
        events.window_did_resign_key(move |_| on_resign_key());
        panel.set_event_handler(Some(events.as_ref()));
        Ok(())
    }
}

static PINNED: AtomicBool = AtomicBool::new(false);
/// Bumped on every show and hide, so a pending fallback hide knows it's out of date.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static LAST_HIDDEN: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct OpenEvent {
    fresh: bool,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let handle = app.clone();
    ns::build(app, CARD_WIDTH + 2.0 * MARGIN_SIDE, move || blurred(&handle))
}

/// The shortcut: open when hidden, close when shown.
pub fn toggle(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(panel) = handle.get_webview_panel(LABEL) else { return };
        if panel.is_visible() {
            request_close(&handle);
        } else {
            show(&handle, false);
        }
    });
}

/// From the menu bar: open (or bring forward), optionally as a clean slate, then send `then`.
pub fn open(app: &AppHandle, fresh: bool, then: Option<&'static str>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        show(&handle, fresh);
        if let Some(event) = then {
            let _ = handle.emit_to(LABEL, event, ());
        }
    });
}

/// Main thread only.
fn show(app: &AppHandle, force_fresh: bool) {
    let Ok(panel) = app.get_webview_panel(LABEL) else { return };
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if panel.is_visible() {
        if force_fresh {
            let _ = app.emit_to(LABEL, "aside://open", OpenEvent { fresh: true });
        }
        panel.show_and_make_key();
        return;
    }
    let settings = settings::load();
    let last_hidden = *LAST_HIDDEN.lock().unwrap();
    let idle_since = [last_hidden, chat::last_finished()].into_iter().flatten().max();
    let fresh = force_fresh || is_fresh(settings.fresh_after_minutes, chat::is_streaming(), idle_since, Instant::now());
    if let Some(visible) = MainThreadMarker::new().and_then(screen_under_pointer) {
        panel.as_panel().setFrame_display(frame(visible, settings.position), false);
    }
    let _ = app.emit_to(LABEL, "aside://open", OpenEvent { fresh });
    panel.show_and_make_key();
}

/// Asks the page to animate out. It calls `hide_panel` when done; if it doesn't, hide anyway.
fn request_close(app: &AppHandle) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit_to(LABEL, "aside://close", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_FALLBACK);
        if GENERATION.load(Ordering::SeqCst) == generation {
            hide(&handle);
        }
    });
}

pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(panel) = handle.get_webview_panel(LABEL) else { return };
        GENERATION.fetch_add(1, Ordering::SeqCst);
        if panel.is_visible() {
            panel.hide();
            *LAST_HIDDEN.lock().unwrap() = Some(Instant::now());
        }
    });
}

pub fn set_pinned(pinned: bool) {
    PINNED.store(pinned, Ordering::SeqCst);
}

/// A click into another app. Our own windows taking key (a file picker) don't count, and
/// AppKit hasn't picked the new key window yet when this fires, so look a moment later.
fn blurred(app: &AppHandle) {
    if PINNED.load(Ordering::SeqCst) || !settings::load().hide_on_blur {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let Ok(panel) = app.get_webview_panel(LABEL) else { return };
            let Some(mtm) = MainThreadMarker::new() else { return };
            let ours_key = NSApplication::sharedApplication(mtm).keyWindow().is_some();
            if panel.is_visible() && !ours_key && !PINNED.load(Ordering::SeqCst) {
                request_close(&app);
            }
        });
    });
}

/// Whether opening now should start a clean slate.
fn is_fresh(minutes: u32, streaming: bool, idle_since: Option<Instant>, now: Instant) -> bool {
    if minutes == 0 || streaming {
        return false;
    }
    match idle_since {
        Some(since) => now.saturating_duration_since(since) >= Duration::from_secs(minutes as u64 * 60),
        None => true,
    }
}

/// The visible frame (no menu bar or Dock) of the screen the pointer is on, in AppKit's
/// bottom-left coordinates.
fn screen_under_pointer(mtm: MainThreadMarker) -> Option<NSRect> {
    let pointer = NSEvent::mouseLocation();
    let screens = NSScreen::screens(mtm);
    let inside = |r: NSRect| pointer.x >= r.origin.x && pointer.x <= r.origin.x + r.size.width && pointer.y >= r.origin.y && pointer.y <= r.origin.y + r.size.height;
    screens
        .iter()
        .find(|s| inside(s.frame()))
        .or_else(|| NSScreen::mainScreen(mtm))
        .map(|s| s.visibleFrame())
}

/// The window frame for the card on this screen. AppKit's y grows upwards, so the bottom
/// margin is below the card's origin.
fn frame(visible: NSRect, position: Position) -> NSRect {
    let max_card = (visible.size.height - MARGIN_TOP - MARGIN_BOTTOM).max(200.0);
    let card_height = (visible.size.height * 0.72).clamp(520.0, 780.0).min(max_card);
    let card_x = match position {
        Position::Center => visible.origin.x + (visible.size.width - CARD_WIDTH) / 2.0,
        Position::Right => visible.origin.x + visible.size.width - EDGE_GAP - CARD_WIDTH,
    };
    let card_y = visible.origin.y + (visible.size.height - card_height) / 2.0;
    NSRect::new(
        NSPoint::new((card_x - MARGIN_SIDE).round(), (card_y - MARGIN_BOTTOM).round()),
        NSSize::new(CARD_WIDTH + 2.0 * MARGIN_SIDE, (card_height + MARGIN_TOP + MARGIN_BOTTOM).round()),
    )
}

// The shortcut

/// The shortcut in use, and why the saved one couldn't be registered if it couldn't.
static SHORTCUT: Mutex<(Option<String>, Option<String>)> = Mutex::new((None, None));

fn register(app: &AppHandle, shortcut: Option<&str>) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let Some(shortcut) = shortcut else { return Ok(()) };
    shortcuts
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .map_err(|e| format!("Couldn't use {shortcut}: {e}. Another app may already use it."))
}

/// Registers the saved shortcut at launch.
pub fn start_shortcut(app: &AppHandle) {
    let shortcut = settings::load().shortcut;
    let error = register(app, shortcut.as_deref()).err();
    *SHORTCUT.lock().unwrap() = (shortcut, error);
}

/// Switches to a new shortcut, keeping the old one if the new one can't be registered.
pub fn set_shortcut(app: &AppHandle, shortcut: Option<&str>) -> Result<(), String> {
    let mut current = SHORTCUT.lock().unwrap();
    if current.0.as_deref() == shortcut && current.1.is_none() {
        return Ok(());
    }
    if let Err(error) = register(app, shortcut) {
        let _ = register(app, current.0.as_deref());
        return Err(error);
    }
    *current = (shortcut.map(String::from), None);
    drop(current);
    tray::refresh(app);
    Ok(())
}

pub fn shortcut() -> Option<String> {
    SHORTCUT.lock().unwrap().0.clone()
}

pub fn shortcut_error() -> Option<String> {
    SHORTCUT.lock().unwrap().1.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_after_idle_minutes() {
        let now = Instant::now() + Duration::from_secs(3600);
        let ago = |mins: u64| Some(now - Duration::from_secs(mins * 60));
        assert!(is_fresh(10, false, ago(10), now));
        assert!(is_fresh(10, false, ago(30), now));
        assert!(!is_fresh(10, false, ago(9), now));
        assert!(!is_fresh(0, false, ago(600), now), "0 means never");
        assert!(!is_fresh(10, true, ago(600), now), "never while answering");
        assert!(is_fresh(10, false, None, now), "first open after launch");
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
    }

    #[test]
    fn card_is_centred_with_shadow_margins() {
        // A 1512×982 laptop screen less a 37px menu bar and no Dock.
        let visible = rect(0.0, 0.0, 1512.0, 945.0);
        let f = frame(visible, Position::Center);
        let card_height = (945.0f64 * 0.72).round();
        assert_eq!(f.size.width, 468.0 + 2.0 * MARGIN_SIDE);
        assert_eq!(f.size.height, (945.0 * 0.72 + MARGIN_TOP + MARGIN_BOTTOM).round());
        // The card itself, not the window, is centred.
        assert_eq!(f.origin.x + MARGIN_SIDE, (1512.0 - 468.0) / 2.0);
        let card_bottom = f.origin.y + MARGIN_BOTTOM;
        assert!((card_bottom - (945.0 - card_height) / 2.0).abs() <= 1.0);
    }

    #[test]
    fn card_height_is_clamped() {
        assert_eq!(frame(rect(0.0, 0.0, 3000.0, 2000.0), Position::Center).size.height, 780.0 + MARGIN_TOP + MARGIN_BOTTOM);
        assert_eq!(frame(rect(0.0, 0.0, 1280.0, 700.0), Position::Center).size.height, 520.0 + MARGIN_TOP + MARGIN_BOTTOM);
    }

    #[test]
    fn right_sits_16px_from_the_edge_of_that_screen() {
        // A second screen to the right of the main one.
        let visible = rect(1512.0, 0.0, 1920.0, 1055.0);
        let f = frame(visible, Position::Right);
        assert_eq!(f.origin.x + MARGIN_SIDE + CARD_WIDTH, 1512.0 + 1920.0 - 16.0);
    }
}
