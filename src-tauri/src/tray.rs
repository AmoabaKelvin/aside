//! The menu bar icon. Aside has no Dock icon, so this is how you find it without the shortcut.

use crate::panel;
use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Wry};

const ID: &str = "aside";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(ID)
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Aside")
        .show_menu_on_left_click(true)
        .menu(&menu(app)?)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    Ok(())
}

/// Rebuilds the menu, so "Open Aside" shows the current shortcut.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(ID) else { return };
    if let Ok(menu) = menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let plain = || MenuItemBuilder::with_id("open", "Open Aside");
    // A shortcut the menu can't display shouldn't cost the whole menu.
    let open = match panel::shortcut() {
        Some(shortcut) => plain().accelerator(shortcut).build(app).or_else(|_| plain().build(app))?,
        None => plain().build(app)?,
    };
    MenuBuilder::new(app)
        .item(&open)
        .item(&MenuItemBuilder::with_id("new", "New chat").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("settings", "Settings…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit Aside").build(app)?)
        .build()
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => panel::open(app, false, None),
        "new" => panel::open(app, true, None),
        "settings" => panel::open(app, false, Some("aside://settings")),
        "quit" => app.exit(0),
        _ => {}
    }
}
