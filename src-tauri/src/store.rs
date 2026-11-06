//! Conversations and images, kept as plain files in Aside's own folder so they never end up in
//! Claude Code's or Codex's session history. Every write goes to a temp file first, then a
//! rename, so a crash mid-write never leaves half a conversation.

use crate::settings::Provider;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TITLE_LIMIT: usize = 80;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub file: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

/// An image the page has already downscaled, ready to send.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingImage {
    pub data_base64: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Search,
    Fetch,
    Other,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ToolUse {
    pub kind: ToolKind,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<ImageRef>,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Streaming,
    Done,
    Stopped,
    Error,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub id: String,
    pub text: String,
    pub provider: Provider,
    #[serde(default)]
    pub model: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub tools: Vec<ToolUse>,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    User(UserMessage),
    Assistant(AssistantMessage),
}

impl Message {
    pub fn id(&self) -> &str {
        match self {
            Message::User(m) => &m.id,
            Message::Assistant(m) => &m.id,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub title: String,
    pub provider: Provider,
    pub messages: Vec<Message>,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub title: String,
    pub provider: Provider,
    pub count: usize,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default()
}

/// Random hex from the standard library's per-process random keys, mixed with the clock.
pub fn random_hex(len: usize) -> String {
    let mut out = String::new();
    while out.len() < len {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default());
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out.truncate(len);
    out
}

/// `YYYYMMDD-HHMMSS-xxxx` in local time, so the files sort by when they were started.
pub fn new_conversation_id() -> String {
    format!("{}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), random_hex(4))
}

pub fn new_message_id() -> String {
    format!("m{}{}", now_ms(), random_hex(6))
}

/// The first line of the first message, trimmed to fit a list row.
pub fn title(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= TITLE_LIMIT {
        return line;
    }
    let cut: String = line.chars().take(TITLE_LIMIT - 1).collect();
    // End on a word if there's one reasonably close.
    let cut = match cut.rfind(' ') {
        Some(space) if space > TITLE_LIMIT / 2 => &cut[..space],
        _ => cut.as_str(),
    };
    format!("{}…", cut.trim_end())
}

/// Writes to a temp file next to the target, then renames over it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temp = path.with_file_name(format!(".{name}.{}.tmp", random_hex(8)));
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Where conversations and images live. Tests point it at a temp folder.
#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Store { root }
    }

    pub fn conversations_dir(&self) -> PathBuf {
        self.root.join("conversations")
    }

    pub fn images_dir(&self) -> PathBuf {
        self.root.join("images")
    }

    fn path(&self, id: &str) -> Result<PathBuf, String> {
        // Ids come from the page, so never let one reach outside the folder.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("That conversation doesn't exist".into());
        }
        Ok(self.conversations_dir().join(format!("{id}.json")))
    }

    /// Newest first, by creation time. Files that don't parse are skipped.
    pub fn list(&self) -> Vec<ConversationSummary> {
        let Ok(entries) = fs::read_dir(self.conversations_dir()) else { return Vec::new() };
        let mut list: Vec<ConversationSummary> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice::<Conversation>(&fs::read(e.path()).ok()?).ok())
            .map(|c| ConversationSummary { count: c.messages.len(), id: c.id, created_at: c.created_at, updated_at: c.updated_at, title: c.title, provider: c.provider })
            .collect();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
        list
    }

    pub fn load(&self, id: &str) -> Result<Conversation, String> {
        let bytes = fs::read(self.path(id)?).map_err(|_| "That conversation doesn't exist any more".to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| format!("Couldn't read that conversation: {e}"))
    }

    pub fn save(&self, conversation: &Conversation) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(conversation).map_err(|e| e.to_string())?;
        write_atomic(&self.path(&conversation.id)?, &json).map_err(|e| format!("Couldn't save the conversation: {e}"))
    }

    /// Deletes the conversation, and any of its images no other conversation uses.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let path = self.path(id)?;
        let images: HashSet<String> = self.load(id).map(|c| image_files(&c)).unwrap_or_default();
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("Couldn't delete the conversation: {e}")),
        }
        if images.is_empty() {
            return Ok(());
        }
        let mut used = HashSet::new();
        if let Ok(entries) = fs::read_dir(self.conversations_dir()) {
            for entry in entries.flatten() {
                if let Some(c) = fs::read(entry.path()).ok().and_then(|b| serde_json::from_slice::<Conversation>(&b).ok()) {
                    used.extend(image_files(&c));
                }
            }
        }
        for file in images.difference(&used) {
            let _ = fs::remove_file(self.images_dir().join(file));
        }
        Ok(())
    }

    /// Saves an image under a name taken from its content, so the same image is kept once.
    pub fn save_image(&self, image: &OutgoingImage) -> Result<ImageRef, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.data_base64.trim())
            .map_err(|_| "Couldn't read an attached image".to_string())?;
        let ext = extension(&image.mime).ok_or_else(|| format!("Aside can't send {} images", image.mime))?;
        let hash = Sha256::digest(&bytes);
        let hex: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
        let file = format!("{hex}.{ext}");
        let path = self.images_dir().join(&file);
        if !path.exists() {
            write_atomic(&path, &bytes).map_err(|e| format!("Couldn't save an image: {e}"))?;
        }
        Ok(ImageRef { file, mime: image.mime.clone(), width: image.width, height: image.height })
    }
}

fn image_files(conversation: &Conversation) -> HashSet<String> {
    conversation
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User(u) => Some(u.images.iter().map(|i| i.file.clone())),
            Message::Assistant(_) => None,
        })
        .flatten()
        .collect()
}

pub fn extension(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("aside-test-{}", random_hex(12)));
        Store::new(dir)
    }

    fn conversation(id: &str, created_at: i64, images: Vec<ImageRef>) -> Conversation {
        Conversation {
            id: id.into(),
            created_at,
            updated_at: created_at,
            title: "hello".into(),
            provider: Provider::Claude,
            messages: vec![
                Message::User(UserMessage { id: "u1".into(), text: "hello".into(), images, at: created_at }),
                Message::Assistant(AssistantMessage {
                    id: "a1".into(),
                    text: "hi".into(),
                    provider: Provider::Claude,
                    model: "sonnet".into(),
                    status: Status::Done,
                    error: None,
                    tools: vec![ToolUse { kind: ToolKind::Search, label: "Searching".into() }],
                    at: created_at,
                }),
            ],
        }
    }

    #[test]
    fn round_trips_and_lists_newest_first() {
        let store = temp_store();
        let older = conversation("20260101-100000-aaaa", 1, vec![]);
        let newer = conversation("20260102-100000-bbbb", 2, vec![]);
        store.save(&older).unwrap();
        store.save(&newer).unwrap();
        assert_eq!(store.load(&older.id).unwrap(), older);
        let list = store.list();
        assert_eq!(list.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), [newer.id.as_str(), older.id.as_str()]);
        assert_eq!(list[0].count, 2);
        // No temp files left behind.
        let names: Vec<_> = fs::read_dir(store.conversations_dir()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 2);
        let _ = fs::remove_dir_all(&store.root);
    }

    #[test]
    fn messages_are_tagged_by_role() {
        let json = serde_json::to_value(conversation("x", 1, vec![])).unwrap();
        assert_eq!(json["messages"][0]["role"], "user");
        assert_eq!(json["messages"][1]["role"], "assistant");
        assert_eq!(json["messages"][1]["status"], "done");
        assert_eq!(json["messages"][1]["tools"][0]["kind"], "search");
        assert!(json["messages"][1].get("error").is_none());
        assert_eq!(json["createdAt"], 1);
    }

    #[test]
    fn rejects_ids_that_leave_the_folder() {
        let store = temp_store();
        assert!(store.load("../settings").is_err());
        assert!(store.load("").is_err());
    }

    #[test]
    fn images_are_named_by_content_and_cleaned_up() {
        let store = temp_store();
        let png = OutgoingImage { data_base64: base64::engine::general_purpose::STANDARD.encode(b"fake png"), mime: "image/png".into(), width: 2, height: 3 };
        let image = store.save_image(&png).unwrap();
        assert_eq!(image, store.save_image(&png).unwrap());
        assert_eq!(image.file.len(), 16 + 4);
        assert!(image.file.ends_with(".png"));
        store.save(&conversation("20260101-100000-aaaa", 1, vec![image.clone()])).unwrap();
        store.save(&conversation("20260101-100000-bbbb", 2, vec![image.clone()])).unwrap();
        store.delete("20260101-100000-aaaa").unwrap();
        assert!(store.images_dir().join(&image.file).exists(), "still used by the other one");
        store.delete("20260101-100000-bbbb").unwrap();
        assert!(!store.images_dir().join(&image.file).exists());
        let _ = fs::remove_dir_all(&store.root);
    }

    #[test]
    fn titles_are_one_trimmed_line() {
        assert_eq!(title("  \n  Hello   there \nsecond line"), "Hello there");
        assert_eq!(title(""), "");
        let long = "word ".repeat(40);
        let t = title(&long);
        assert!(t.chars().count() <= TITLE_LIMIT);
        assert!(t.ends_with("word…"));
        let unbroken = "x".repeat(200);
        assert_eq!(title(&unbroken).chars().count(), TITLE_LIMIT);
    }

    #[test]
    fn ids_have_the_documented_shape() {
        let id = new_conversation_id();
        assert_eq!(id.len(), "YYYYMMDD-HHMMSS-xxxx".len());
        assert!(id.chars().nth(8) == Some('-') && id.chars().nth(15) == Some('-'));
        assert_ne!(random_hex(8), random_hex(8));
    }
}
