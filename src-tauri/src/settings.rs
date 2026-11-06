//! The user's settings, kept as JSON in Aside's own folder. Missing fields take their defaults,
//! so an older file keeps working after a new setting is added.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub const DEFAULT_SHORTCUT: &str = "Cmd+Shift+Space";
const IDENTIFIER: &str = "com.kelvinamoaba.aside";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Claude,
    Codex,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Position {
    #[default]
    Center,
    Right,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// An accelerator like "Cmd+Shift+Space", or None for no shortcut.
    pub shortcut: Option<String>,
    pub provider: Provider,
    pub claude_model: String,
    pub claude_effort: String,
    pub codex_model: String,
    pub codex_effort: String,
    pub web_search: bool,
    pub fresh_after_minutes: u32,
    pub hide_on_blur: bool,
    pub position: Position,
    pub instructions: String,
    /// The conversation's text size in px. The panel's own chrome stays the same size.
    pub text_size: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            shortcut: Some(DEFAULT_SHORTCUT.into()),
            provider: Provider::Claude,
            claude_model: "sonnet".into(),
            claude_effort: String::new(),
            codex_model: String::new(),
            codex_effort: String::new(),
            web_search: true,
            fresh_after_minutes: 10,
            hide_on_blur: true,
            position: Position::Center,
            instructions: String::new(),
            text_size: 15,
        }
    }
}

impl Settings {
    /// Drops values the CLIs wouldn't accept, so a hand-edited file can't break sending.
    pub fn tidy(mut self) -> Self {
        self.shortcut = self.shortcut.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        self.claude_model = self.claude_model.trim().to_string();
        if self.claude_model.is_empty() {
            self.claude_model = "sonnet".into();
        }
        self.codex_model = self.codex_model.trim().to_string();
        if !["", "low", "medium", "high", "xhigh", "max"].contains(&self.claude_effort.as_str()) {
            self.claude_effort.clear();
        }
        if !["", "minimal", "low", "medium", "high", "xhigh"].contains(&self.codex_effort.as_str()) {
            self.codex_effort.clear();
        }
        self.text_size = self.text_size.clamp(12, 20);
        self
    }
}

/// Whether a provider's CLI is installed and signed in.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: Provider,
    pub ready: bool,
    pub detail: String,
}

/// The settings as last read or saved, so hot paths (the panel losing focus) skip the disk.
static CURRENT: Mutex<Option<Settings>> = Mutex::new(None);

/// `~/Library/Application Support/com.kelvinamoaba.aside`, the same folder Tauri's app_data_dir uses.
pub fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support").join(IDENTIFIER)
}

fn path() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn load() -> Settings {
    CURRENT
        .lock()
        .unwrap()
        .get_or_insert_with(|| {
            std::fs::read_to_string(path())
                .ok()
                .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
                .unwrap_or_default()
                .tidy()
        })
        .clone()
}

/// Tests use settings without touching the user's file.
#[cfg(test)]
pub fn use_for_test(settings: Settings) {
    *CURRENT.lock().unwrap() = Some(settings);
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    crate::store::write_atomic(&path(), json.as_bytes()).map_err(|e| format!("Couldn't save settings: {e}"))?;
    *CURRENT.lock().unwrap() = Some(settings.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_take_defaults() {
        let settings: Settings = serde_json::from_str(r#"{"provider":"codex","webSearch":false}"#).unwrap();
        assert_eq!(settings.provider, Provider::Codex);
        assert!(!settings.web_search);
        assert_eq!(settings.shortcut.as_deref(), Some(DEFAULT_SHORTCUT));
        assert_eq!(settings.fresh_after_minutes, 10);
        assert_eq!(settings.position, Position::Center);
    }

    #[test]
    fn null_shortcut_means_none() {
        let settings: Settings = serde_json::from_str(r#"{"shortcut":null}"#).unwrap();
        assert_eq!(settings.shortcut, None);
    }

    #[test]
    fn round_trips_in_camel_case() {
        let json = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(json["claudeModel"], "sonnet");
        assert_eq!(json["freshAfterMinutes"], 10);
        assert_eq!(json["position"], "center");
        assert_eq!(json["provider"], "claude");
    }

    #[test]
    fn tidy_drops_unknown_values() {
        let settings = Settings { claude_effort: "huge".into(), claude_model: " ".into(), shortcut: Some("".into()), ..Settings::default() }.tidy();
        assert_eq!(settings.claude_effort, "");
        assert_eq!(settings.claude_model, "sonnet");
        assert_eq!(settings.shortcut, None);
    }
}
