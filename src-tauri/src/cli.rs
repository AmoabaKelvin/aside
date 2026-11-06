//! Finding and running the `claude` and `codex` CLIs from an app opened in Finder, which gets a
//! bare PATH and no shell profile.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};

static BINARIES: Mutex<Option<HashMap<&'static str, PathBuf>>> = Mutex::new(None);
static LOGIN_PATH: OnceLock<String> = OnceLock::new();

/// Looks where installers usually put things, then asks a login shell.
pub fn binary(name: &'static str) -> Option<PathBuf> {
    let mut cache = BINARIES.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(path) = cache.get(name) {
        return Some(path.clone());
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [".local/bin", ".claude/local", "/opt/homebrew/bin", "/usr/local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin"];
    let found = dirs
        .iter()
        .map(|dir| Path::new(&home).join(dir).join(name))
        .find(|path| path.is_file())
        .or_else(|| {
            let output = Command::new("/bin/zsh").args(["-lc", &format!("command -v {name}")]).output().ok()?;
            let path = PathBuf::from(String::from_utf8(output.stdout).ok()?.lines().last()?.trim());
            (path.is_absolute() && path.is_file()).then_some(path)
        })?;
    cache.insert(name, found.clone());
    Some(found)
}

/// The login shell's PATH, so the CLIs can find node and friends.
fn login_path() -> &'static str {
    LOGIN_PATH.get_or_init(|| {
        Command::new("/bin/zsh")
            .args(["-lc", "printf '\\n%s' \"$PATH\""])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|text| text.rsplit('\n').next().map(String::from))
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into())
    })
}

/// An empty folder to run in, so no project files or CLAUDE.md get picked up.
pub fn workdir() -> PathBuf {
    let dir = std::env::temp_dir().join("aside-chat");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn command(name: &'static str, missing: &str) -> Result<Command, String> {
    let path = binary(name).ok_or_else(|| missing.to_string())?;
    let mut command = Command::new(path);
    command.env("PATH", login_path()).current_dir(workdir());
    Ok(command)
}

/// Collects stderr on its own thread so a chatty process never blocks on a full pipe.
pub fn collect(mut stream: impl Read + Send + 'static) -> JoinHandle<String> {
    thread::spawn(move || {
        let mut text = String::new();
        let _ = stream.read_to_string(&mut text);
        text
    })
}

/// The last line of stderr worth showing.
pub fn last_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(|line| line.trim_start_matches("ERROR:").trim_start_matches("Error:").trim().to_string())
}
