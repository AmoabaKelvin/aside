mod chat;
mod claude;
mod cli;
mod clipboard;
mod codex;
mod panel;
mod settings;
mod store;
mod tray;

use serde::Serialize;
use settings::{Provider, ProviderStatus, Settings};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use store::{Conversation, ConversationSummary, Store};
use tauri::{Manager, RunEvent};

/// Runs blocking work (files, CLIs, the clipboard) off the main thread.
async fn blocking<T: Send + 'static>(app: tauri::AppHandle, work: impl FnOnce(&Store) -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<Store>())).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsInfo {
    settings: Settings,
    shortcut_error: Option<String>,
    providers: Vec<ProviderStatus>,
    transcripts_dir: String,
    images_dir: String,
}

/// Checking sign-in runs both CLIs, so reuse a recent answer.
static PROVIDERS: Mutex<Option<(Instant, Vec<ProviderStatus>)>> = Mutex::new(None);

fn providers() -> Vec<ProviderStatus> {
    if let Some((at, list)) = PROVIDERS.lock().unwrap().as_ref()
        && at.elapsed() < Duration::from_secs(10)
    {
        return list.clone();
    }
    let list = std::thread::scope(|s| {
        let claude = s.spawn(claude::status);
        let codex = s.spawn(codex::status);
        vec![claude.join().unwrap(), codex.join().unwrap()]
    });
    *PROVIDERS.lock().unwrap() = Some((Instant::now(), list.clone()));
    list
}

fn info(store: &Store) -> SettingsInfo {
    SettingsInfo {
        settings: settings::load(),
        shortcut_error: panel::shortcut_error(),
        providers: providers(),
        transcripts_dir: store.conversations_dir().display().to_string(),
        images_dir: store.images_dir().display().to_string(),
    }
}

#[tauri::command]
async fn get_settings(app: tauri::AppHandle) -> Result<SettingsInfo, String> {
    blocking(app, info).await
}

/// Nothing is saved if the new shortcut can't be registered; the old one stays.
#[tauri::command]
async fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<SettingsInfo, String> {
    let handle = app.clone();
    blocking(app, move |store| {
        let settings = settings.tidy();
        panel::set_shortcut(&handle, settings.shortcut.as_deref())?;
        settings::save(&settings)?;
        Ok(info(store))
    })
    .await?
}

#[tauri::command]
async fn codex_models(app: tauri::AppHandle) -> Result<Vec<codex::ModelOption>, String> {
    blocking(app, |_| codex::models()).await?
}

#[tauri::command]
async fn list_conversations(app: tauri::AppHandle) -> Result<Vec<ConversationSummary>, String> {
    blocking(app, |store| store.list()).await
}

#[tauri::command]
async fn load_conversation(app: tauri::AppHandle, id: String) -> Result<Conversation, String> {
    blocking(app, move |store| store.load(&id).map(chat::settle)).await?
}

#[tauri::command]
async fn delete_conversation(app: tauri::AppHandle, id: String) -> Result<(), String> {
    chat::stop(&id);
    blocking(app, move |store| {
        // Let a stopped answer finish saving first, so it can't write the file back.
        let deadline = Instant::now() + Duration::from_secs(2);
        while chat::is_streaming_in(&id) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        store.delete(&id)
    })
    .await?
}

#[tauri::command]
async fn send(app: tauri::AppHandle, request: chat::SendRequest) -> Result<chat::SendResult, String> {
    let handle = app.clone();
    blocking(app, move |store| chat::send(&handle, store, request)).await?
}

#[tauri::command]
fn stop(conversation_id: String) {
    chat::stop(&conversation_id);
}

#[tauri::command]
fn warm(provider: Provider) {
    std::thread::spawn(move || {
        let settings = settings::load();
        match provider {
            Provider::Claude => claude::warm(&settings),
            Provider::Codex => codex::warm(&settings),
        }
    });
}

#[tauri::command]
fn hide_panel(app: tauri::AppHandle) {
    panel::hide(&app);
}

#[tauri::command]
fn set_pinned(pinned: bool) {
    panel::set_pinned(pinned);
}

#[tauri::command]
async fn paste_image(app: tauri::AppHandle) -> Result<Option<clipboard::RawImage>, String> {
    blocking(app, |_| clipboard::paste_image()).await
}

#[tauri::command]
async fn read_image(app: tauri::AppHandle, path: String) -> Result<clipboard::RawImage, String> {
    blocking(app, move |_| clipboard::read_image(&PathBuf::from(path))).await?
}

#[tauri::command]
fn reveal_transcripts(store: tauri::State<Store>) {
    let dir = store.conversations_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::process::Command::new("open").arg(&dir).spawn();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = Store::new(settings::data_dir());
    let _ = std::fs::create_dir_all(store.conversations_dir());
    let _ = std::fs::create_dir_all(store.images_dir());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_nspanel::init())
        .manage(store)
        .setup(|app| {
            // Menu bar only: no Dock icon, and opening the panel doesn't pull Aside to the front.
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle();
            panel::create(handle)?;
            panel::start_shortcut(handle);
            tray::create(handle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            codex_models,
            list_conversations,
            load_conversation,
            delete_conversation,
            send,
            stop,
            warm,
            hide_panel,
            set_pinned,
            paste_image,
            read_image,
            reveal_transcripts
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aside")
        .run(|_, event| {
            // No CLI process outlives the app.
            if let RunEvent::Exit = event {
                chat::stop_all();
                claude::shutdown();
                codex::shutdown();
            }
        });
}
