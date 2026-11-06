//! Answers with the user's own Codex login, through `codex app-server`: newline-delimited
//! JSON-RPC over stdio. Same shape as `claude.rs`: `stream` one turn, `warm` ahead of time,
//! `models` for the picker, `status` for settings, `shutdown` on quit.
//!
//! One server process holds a thread per chat, so a follow-up sends only the new message.
//! Threads are ephemeral, so nothing lands in the user's Codex history. The user's hooks, MCP
//! servers, notify command and agent tools are all switched off per thread: Aside is a chat.

use crate::chat::{self, Cancel, Turn, Update};
use crate::cli;
use crate::settings::{Provider, ProviderStatus, Settings};
use crate::store::{Message, ToolKind, ToolUse};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// Kill the server once nobody has used it for this long.
const IDLE: Duration = Duration::from_secs(10 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a stopped turn gets to say it's over before we stop waiting.
const STOP_GRACE: Duration = Duration::from_secs(3);
const MAX_LIVE: usize = 20;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_default: bool,
}

// The server process

type Reply = Result<Value, String>;

struct Server {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    /// Requests waiting for their response, by id.
    pending: Mutex<HashMap<u64, Sender<Reply>>>,
    /// Notifications go to whoever is streaming on that thread.
    listeners: Mutex<HashMap<String, Sender<Value>>>,
    alive: AtomicBool,
    /// The user's MCP servers, each switched off, for every thread's config.
    mcp_off: Mutex<Value>,
    last_used: Mutex<Instant>,
}

impl Server {
    fn spawn() -> Result<Arc<Server>, String> {
        let mut child = cli::command("codex", "Codex isn't installed. Install it, then sign in with `codex login`.")?
            .arg("app-server")
            .args(test_args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn't start Codex: {e}"))?;
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let server = Arc::new(Server {
            stdin: Mutex::new(child.stdin.take().unwrap()),
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            listeners: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            mcp_off: Mutex::new(json!({})),
            last_used: Mutex::new(Instant::now()),
        });
        let reader = server.clone();
        thread::spawn(move || reader.read(stdout));

        let client = json!({ "name": "aside", "title": "Aside", "version": env!("CARGO_PKG_VERSION") });
        server.request("initialize", json!({ "clientInfo": client, "capabilities": { "experimentalApi": false, "requestAttestation": false } }))?;
        server.write(&json!({ "method": "initialized" }))?;
        // `mcp_servers: {}` merges rather than replaces, so each server is switched off by name.
        if let Ok(config) = server.request("config/read", json!({}))
            && let Some(servers) = config["config"]["mcp_servers"].as_object()
        {
            let off: serde_json::Map<String, Value> = servers.keys().map(|name| (name.clone(), json!({ "enabled": false }))).collect();
            *server.mcp_off.lock().unwrap() = Value::Object(off);
        }
        Ok(server)
    }

    fn read(&self, mut stdout: BufReader<std::process::ChildStdout>) {
        let mut line = String::new();
        while matches!(stdout.read_line(&mut line), Ok(1..)) {
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                self.dispatch(message);
            }
            line.clear();
        }
        // Gone: wake everyone waiting, so they see it.
        self.alive.store(false, Ordering::SeqCst);
        self.pending.lock().unwrap().clear();
        self.listeners.lock().unwrap().clear();
    }

    fn dispatch(&self, message: Value) {
        let id = message["id"].as_u64();
        match (id, message["method"].as_str()) {
            // The server asking us something (an approval). Aside never runs tools, so say no.
            (Some(id), Some(_)) => {
                let _ = self.write(&json!({ "id": id, "error": { "code": -32601, "message": "Aside doesn't handle requests" } }));
            }
            (Some(id), None) => {
                if let Some(reply) = self.pending.lock().unwrap().remove(&id) {
                    let result = match message.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("Codex couldn't do that").to_string()),
                        None => Ok(message["result"].clone()),
                    };
                    let _ = reply.send(result);
                }
            }
            (None, Some(_)) => {
                let params = &message["params"];
                let thread = params["threadId"].as_str().or_else(|| params["thread"]["id"].as_str());
                if let Some(thread) = thread
                    && let Some(listener) = self.listeners.lock().unwrap().get(thread)
                {
                    let _ = listener.send(message.clone());
                }
            }
            _ => {}
        }
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        writeln!(stdin, "{message}").and_then(|_| stdin.flush()).map_err(|_| "Codex stopped unexpectedly".to_string())
    }

    fn send_request(&self, method: &str, params: Value) -> Result<Receiver<Reply>, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.write(&json!({ "id": id, "method": method, "params": params }))?;
        Ok(rx)
    }

    fn request(&self, method: &str, params: Value) -> Reply {
        let rx = self.send_request(method, params)?;
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => Err("Codex took too long to respond".into()),
            Err(RecvTimeoutError::Disconnected) => Err("Codex stopped unexpectedly".into()),
        }
    }

    fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    fn kill(&self) {
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Tests can point the server at another provider (`ASIDE_CODEX_ARGS='-c model_provider="x"'`).
/// The app itself never passes anything, so it uses the user's own config.
#[cfg(test)]
fn test_args() -> Vec<String> {
    std::env::var("ASIDE_CODEX_ARGS").map(|a| a.split_whitespace().map(String::from).collect()).unwrap_or_default()
}

#[cfg(not(test))]
fn test_args() -> Vec<String> {
    Vec::new()
}

/// What a thread was started with. A chat can only keep using a thread started the same way;
/// effort is per turn, so it isn't part of this.
#[derive(Clone, PartialEq, Debug)]
struct Key {
    model: String,
    web_search: bool,
    system: String,
}

impl Key {
    fn new(settings: &Settings) -> Self {
        Key { model: settings.codex_model.clone(), web_search: settings.web_search, system: chat::system_prompt(settings) }
    }
}

/// A thread on the server, waiting for its next turn.
struct Session {
    server: Arc<Server>,
    thread_id: String,
    key: Key,
    /// The answer it gave last, so a chat only reuses a thread that saw everything before.
    last_answer: Option<String>,
    since: Instant,
}

static SERVER: Mutex<Option<Arc<Server>>> = Mutex::new(None);
static WARM: Mutex<Option<Session>> = Mutex::new(None);
static LIVE: Mutex<Option<HashMap<String, Session>>> = Mutex::new(None);
static MODELS: Mutex<Option<Vec<ModelOption>>> = Mutex::new(None);
static REAPER: OnceLock<()> = OnceLock::new();
/// Turns in progress, so the reaper never kills the server under one.
static ACTIVE: AtomicU64 = AtomicU64::new(0);

fn live<T>(f: impl FnOnce(&mut HashMap<String, Session>) -> T) -> T {
    f(LIVE.lock().unwrap().get_or_insert_with(HashMap::new))
}

/// The running server, or a new one.
fn server() -> Result<Arc<Server>, String> {
    let mut slot = SERVER.lock().unwrap();
    if let Some(server) = slot.as_ref().filter(|s| s.alive()) {
        server.touch();
        return Ok(server.clone());
    }
    if let Some(old) = slot.take() {
        old.kill();
    }
    let server = Server::spawn()?;
    *slot = Some(server.clone());
    REAPER.get_or_init(|| {
        thread::spawn(reap);
    });
    Ok(server)
}

fn start_thread(server: &Arc<Server>, key: &Key) -> Result<Session, String> {
    let mut config = json!({
        "web_search": if key.web_search { "live" } else { "disabled" },
        "include_permissions_instructions": false,
        "include_apps_instructions": false,
        "include_collaboration_mode_instructions": false,
        "include_environment_context": false,
        "skills": { "include_instructions": false },
        "features": {
            "shell_tool": false, "unified_exec": false, "apps": false, "plugins": false, "hooks": false,
            "sleep_tool": false, "computer_use": false, "browser_use": false, "view_image": false,
            "image_generation": false, "goals": false, "tool_suggest": false, "multi_agent": false,
            "default_mode_request_user_input": false, "tool_search": false
        },
        "notify": []
    });
    config["mcp_servers"] = server.mcp_off.lock().unwrap().clone();
    let mut params = json!({
        "ephemeral": true,
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "cwd": cli::workdir(),
        "baseInstructions": key.system,
        "config": config,
    });
    if !key.model.is_empty() {
        params["model"] = json!(key.model);
    }
    let result = server.request("thread/start", params).map_err(|e| readable_error(&e, None))?;
    let thread_id = result["thread"]["id"].as_str().ok_or("Codex didn't start a conversation")?.to_string();
    Ok(Session { server: server.clone(), thread_id, key: key.clone(), last_answer: None, since: Instant::now() })
}

/// Starts the server and a spare thread for the current settings, so the next chat answers sooner.
pub fn warm(settings: &Settings) {
    let key = Key::new(settings);
    let Ok(server) = server() else { return };
    let mut warm = WARM.lock().unwrap();
    if warm.as_ref().is_some_and(|w| w.key == key && Arc::ptr_eq(&w.server, &server)) {
        return;
    }
    *warm = start_thread(&server, &key).ok();
}

/// Kills the server, e.g. on quit.
pub fn shutdown() {
    WARM.lock().unwrap().take();
    live(|l| l.clear());
    if let Some(server) = SERVER.lock().unwrap().take() {
        server.kill();
    }
}

fn reap() {
    loop {
        thread::sleep(Duration::from_secs(30));
        let mut slot = SERVER.lock().unwrap();
        let idle = slot.as_ref().is_some_and(|s| s.last_used.lock().unwrap().elapsed() > IDLE);
        if idle && ACTIVE.load(Ordering::SeqCst) == 0 {
            slot.take().unwrap().kill();
            drop(slot);
            WARM.lock().unwrap().take();
            live(|l| l.clear());
        }
    }
}

/// The thread already holding this chat, or else the spare one, or else a new one.
fn session(conversation_id: &str, key: &Key, earlier: &[Message]) -> Result<Session, String> {
    let current = server()?;
    let previous = earlier.last().map(|m| m.id().to_string());
    if let Some(session) = live(|l| l.remove(conversation_id)) {
        let same = Arc::ptr_eq(&session.server, &current) && &session.key == key;
        if same && session.last_answer.is_some() && session.last_answer == previous {
            return Ok(session);
        }
    }
    let warm = WARM.lock().unwrap().take();
    if let Some(warm) = warm
        && Arc::ptr_eq(&warm.server, &current)
        && &warm.key == key
    {
        // Started now, the next spare is ready by the time the user starts another chat.
        let key = key.clone();
        thread::spawn(move || {
            if let Ok(server) = server()
                && let Ok(session) = start_thread(&server, &key)
            {
                WARM.lock().unwrap().get_or_insert(session);
            }
        });
        return Ok(warm);
    }
    start_thread(&current, key)
}

fn input(text: &str, images: &[crate::store::OutgoingImage]) -> Value {
    let mut input = Vec::new();
    if !text.trim().is_empty() {
        input.push(json!({ "type": "text", "text": text, "text_elements": [] }));
    }
    for image in images {
        input.push(json!({ "type": "image", "url": format!("data:{};base64,{}", image.mime, image.data_base64) }));
    }
    Value::Array(input)
}

/// Blocking. Streams one answer through `on`; Ok when Codex says the turn is over.
pub fn stream(turn: &Turn, cancel: &Cancel, on: &mut dyn FnMut(Update)) -> Result<(), String> {
    ACTIVE.fetch_add(1, Ordering::SeqCst);
    let result = run_turn(turn, cancel, on);
    ACTIVE.fetch_sub(1, Ordering::SeqCst);
    result
}

fn run_turn(turn: &Turn, cancel: &Cancel, on: &mut dyn FnMut(Update)) -> Result<(), String> {
    let key = Key::new(&turn.settings);
    let mut session = session(&turn.conversation_id, &key, &turn.earlier)?;
    let server = session.server.clone();
    let text = if session.last_answer.is_some() { turn.text.clone() } else { chat::with_transcript(&turn.earlier, &turn.text) };

    // Listen before starting, so no notification is missed.
    let (tx, rx) = mpsc::channel();
    server.listeners.lock().unwrap().insert(session.thread_id.clone(), tx);
    let unlisten = |server: &Server, thread_id: &str| {
        server.listeners.lock().unwrap().remove(thread_id);
    };

    let mut params = json!({ "threadId": session.thread_id, "summary": "concise", "input": input(&text, &turn.images) });
    if !turn.settings.codex_effort.is_empty() {
        params["effort"] = json!(turn.settings.codex_effort);
    }
    let started = server.request("turn/start", params);
    let turn_id = match started.as_ref().ok().and_then(|r| r["turn"]["id"].as_str()) {
        Some(id) => id.to_string(),
        None => {
            unlisten(&server, &session.thread_id);
            return Err(readable_error(&started.err().unwrap_or_else(|| "Codex didn't start answering".into()), None));
        }
    };
    let interrupt = (server.clone(), session.thread_id.clone(), turn_id.clone());
    cancel.on_stop(move || {
        let (server, thread_id, turn_id) = interrupt;
        let _ = server.send_request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }));
    });

    let mut parser = Parser::new(turn_id);
    let mut stopped_at: Option<Instant> = None;
    let ended = loop {
        if cancel.is_stopped() && stopped_at.get_or_insert_with(Instant::now).elapsed() > STOP_GRACE {
            break None;
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(message) => {
                let mut end = None;
                for parsed in parser.message(&message) {
                    match parsed {
                        Parsed::Update(update) if !cancel.is_stopped() => on(update),
                        Parsed::Update(_) => {}
                        Parsed::End(result) => end = Some(result),
                    }
                }
                if end.is_some() {
                    break end;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break None,
        }
    };
    unlisten(&server, &session.thread_id);
    server.touch();

    match ended {
        Some(result) => {
            // Even a failed turn leaves the thread usable, so keep it for the next message.
            session.last_answer = Some(turn.answer_id.clone());
            session.since = Instant::now();
            keep(turn.conversation_id.clone(), session);
            result
        }
        None if cancel.is_stopped() => Err("Stopped".into()),
        None => Err("Codex stopped without answering".into()),
    }
}

fn keep(conversation_id: String, session: Session) {
    live(|l| {
        l.insert(conversation_id, session);
        if l.len() > MAX_LIVE
            && let Some(oldest) = l.iter().min_by_key(|(_, s)| s.since).map(|(id, _)| id.clone())
        {
            l.remove(&oldest);
        }
    });
}

pub enum Parsed {
    Update(Update),
    /// The turn is over: Ok, or Codex's error.
    End(Result<(), String>),
}

/// Reads the server's notifications for one turn.
pub struct Parser {
    turn_id: String,
    wrote_text: bool,
    gap: bool,
    tools: HashSet<String>,
    /// The last error Codex won't retry, for when the turn fails without one.
    error: Option<String>,
}

impl Parser {
    pub fn new(turn_id: String) -> Self {
        Parser { turn_id, wrote_text: false, gap: false, tools: HashSet::new(), error: None }
    }

    pub fn message(&mut self, message: &Value) -> Vec<Parsed> {
        let params = &message["params"];
        let turn_id = params["turnId"].as_str().or_else(|| params["turn"]["id"].as_str());
        if turn_id.is_some_and(|id| id != self.turn_id) {
            return Vec::new();
        }
        let item = &params["item"];
        match message["method"].as_str().unwrap_or_default() {
            "item/started" => match item["type"].as_str() {
                Some("reasoning") => vec![Parsed::Update(Update::Thinking)],
                Some("agentMessage") => {
                    self.gap = self.wrote_text;
                    Vec::new()
                }
                _ => Vec::new(),
            },
            "item/reasoning/summaryPartAdded" => vec![Parsed::Update(Update::Thinking)],
            "item/agentMessage/delta" => {
                let delta = params["delta"].as_str().unwrap_or_default();
                if delta.is_empty() {
                    return Vec::new();
                }
                let mut out = Vec::new();
                if std::mem::take(&mut self.gap) {
                    out.push(Parsed::Update(Update::Text("\n\n".into())));
                }
                self.wrote_text = true;
                out.push(Parsed::Update(Update::Text(delta.into())));
                out
            }
            // A search's query is only known once it's done.
            "item/completed" if item["type"] == "webSearch" => {
                let id = item["id"].as_str().unwrap_or_default().to_string();
                if !self.tools.insert(id) {
                    return Vec::new();
                }
                vec![Parsed::Update(Update::Tool(web_search(item)))]
            }
            "error" if params["willRetry"] != true => {
                let error = &params["error"];
                self.error = Some(readable_error(error["message"].as_str().unwrap_or_default(), error["codexErrorInfo"].as_str()));
                Vec::new()
            }
            "turn/completed" => {
                let turn = &params["turn"];
                let result = match turn["status"].as_str() {
                    Some("failed") => {
                        let error = &turn["error"];
                        let message = error["message"].as_str().filter(|m| !m.is_empty());
                        Err(match message {
                            Some(message) => readable_error(message, error["codexErrorInfo"].as_str()),
                            None => self.error.clone().unwrap_or_else(|| "Codex couldn't answer".into()),
                        })
                    }
                    _ => Ok(()),
                };
                vec![Parsed::End(result)]
            }
            _ => Vec::new(),
        }
    }
}

fn web_search(item: &Value) -> ToolUse {
    let action = &item["action"];
    let page = |url: &Value| {
        let host = url.as_str().map(host).unwrap_or_default();
        let label = if host.is_empty() { "Reading a page".into() } else { format!("Reading {host}") };
        ToolUse { kind: ToolKind::Fetch, label }
    };
    match action["type"].as_str() {
        Some("openPage" | "findInPage") => page(&action["url"]),
        _ => {
            let query = action["query"]
                .as_str()
                .or_else(|| action["queries"][0].as_str())
                .or_else(|| item["query"].as_str())
                .unwrap_or_default()
                .trim();
            let label = if query.is_empty() { "Searching the web".into() } else { format!("Searching for “{query}”") };
            ToolUse { kind: ToolKind::Search, label }
        }
    }
}

/// "https://www.example.com/a/b" → "example.com".
fn host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    host.rsplit('@').next().unwrap_or_default().trim_start_matches("www.").to_string()
}

/// Codex's error text, shortened to something worth showing.
fn readable_error(message: &str, info: Option<&str>) -> String {
    let lower = message.to_lowercase();
    if info == Some("usageLimitExceeded") || lower.contains("usage limit") {
        let when = message
            .split_once("try again at ")
            .map(|(_, when)| when.trim().trim_end_matches('.').to_string())
            .filter(|when| !when.is_empty());
        return match when {
            Some(when) => format!("You've hit your Codex usage limit. Try again at {when}."),
            None => "You've hit your Codex usage limit.".into(),
        };
    }
    if lower.contains("not logged in") || lower.contains("login") && lower.contains("required") || info == Some("unauthorized") {
        return "Codex isn't signed in. Run `codex login` in a terminal to sign in.".into();
    }
    let line = message.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Codex couldn't answer");
    if line.chars().count() > 240 {
        return format!("{}…", line.chars().take(239).collect::<String>());
    }
    line.to_string()
}

/// How long the saved model list is trusted before it's refreshed in the background.
const MODELS_FRESH: Duration = Duration::from_secs(24 * 60 * 60);

fn models_cache() -> std::path::PathBuf {
    crate::settings::data_dir().join("codex-models.json")
}

/// Blocking. Codex's model list. Cheap after the first time ever: it comes from memory or a
/// saved copy (refreshed in the background once a day), so the page can ask at startup.
pub fn models() -> Result<Vec<ModelOption>, String> {
    if let Some(models) = MODELS.lock().unwrap().clone() {
        return Ok(models);
    }
    let path = models_cache();
    let saved = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Vec<ModelOption>>(&bytes).ok()).filter(|m| !m.is_empty());
    if let Some(models) = saved {
        *MODELS.lock().unwrap() = Some(models.clone());
        let age = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
        if age.is_none_or(|age| age > MODELS_FRESH) {
            thread::spawn(fetch_models);
        }
        return Ok(models);
    }
    fetch_models()
}

fn fetch_models() -> Result<Vec<ModelOption>, String> {
    let server = server()?;
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..5 {
        let mut params = json!({ "includeHidden": false });
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let page = server.request("model/list", params).map_err(|e| readable_error(&e, None))?;
        models.extend(page["data"].as_array().into_iter().flatten().filter(|m| m["hidden"] != true).map(model_option));
        cursor = page["nextCursor"].as_str().map(String::from);
        if cursor.is_none() {
            break;
        }
    }
    if !models.is_empty() {
        *MODELS.lock().unwrap() = Some(models.clone());
        if let Ok(json) = serde_json::to_vec(&models) {
            let _ = crate::store::write_atomic(&models_cache(), &json);
        }
    }
    Ok(models)
}

fn model_option(model: &Value) -> ModelOption {
    let id = model["model"].as_str().or_else(|| model["id"].as_str()).unwrap_or_default().to_string();
    ModelOption {
        label: model["displayName"].as_str().filter(|l| !l.is_empty()).unwrap_or(&id).to_string(),
        description: model["description"].as_str().filter(|d| !d.is_empty()).map(String::from),
        is_default: model["isDefault"] == true,
        id,
    }
}

/// Blocking: whether Codex is installed and signed in.
pub fn status() -> ProviderStatus {
    let not = |detail: &str| ProviderStatus { id: Provider::Codex, ready: false, detail: detail.into() };
    let Ok(mut command) = cli::command("codex", "") else { return not("Not installed") };
    let Ok(output) = command.args(["login", "status"]).output() else { return not("Not installed") };
    if !output.status.success() {
        return not("Run `codex login` in a terminal to sign in");
    }
    let text = [output.stdout, output.stderr].concat();
    let detail = cli::last_line(&String::from_utf8_lossy(&text)).unwrap_or_else(|| "Signed in".into());
    ProviderStatus { id: Provider::Codex, ready: true, detail }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(parser: &mut Parser, messages: &[Value]) -> (Vec<Update>, Option<Result<(), String>>) {
        let (mut out, mut end) = (Vec::new(), None);
        for message in messages {
            for parsed in parser.message(message) {
                match parsed {
                    Parsed::Update(u) => out.push(u),
                    Parsed::End(r) => end = Some(r),
                }
            }
        }
        (out, end)
    }

    fn note(method: &str, params: Value) -> Value {
        json!({ "method": method, "params": params })
    }

    fn delta(text: &str) -> Value {
        note("item/agentMessage/delta", json!({ "threadId": "th", "turnId": "t1", "itemId": "msg", "delta": text }))
    }

    fn started(kind: &str) -> Value {
        note("item/started", json!({ "threadId": "th", "turnId": "t1", "item": { "type": kind, "id": "x" } }))
    }

    fn completed(status: &str, error: Value) -> Value {
        note("turn/completed", json!({ "threadId": "th", "turn": { "id": "t1", "status": status, "error": error } }))
    }

    #[test]
    fn streams_deltas_with_thinking_tools_and_gaps() {
        let mut parser = Parser::new("t1".into());
        let search = note(
            "item/completed",
            json!({ "threadId": "th", "turnId": "t1", "item": { "type": "webSearch", "id": "ws1", "query": "", "action": { "type": "search", "query": "rust 1.99", "queries": null } } }),
        );
        let open = note(
            "item/completed",
            json!({ "threadId": "th", "turnId": "t1", "item": { "type": "webSearch", "id": "ws2", "query": "", "action": { "type": "openPage", "url": "https://www.blog.rust-lang.org/x" } } }),
        );
        let other_turn = note("item/agentMessage/delta", json!({ "threadId": "th", "turnId": "t0", "delta": "late" }));
        let (out, end) = run(
            &mut parser,
            &[started("reasoning"), started("agentMessage"), delta("Let me look."), other_turn, search.clone(), search, open, started("agentMessage"), delta("It's 1.99."), completed("completed", Value::Null)],
        );
        assert_eq!(
            out,
            [
                Update::Thinking,
                Update::Text("Let me look.".into()),
                Update::Tool(ToolUse { kind: ToolKind::Search, label: "Searching for “rust 1.99”".into() }),
                Update::Tool(ToolUse { kind: ToolKind::Fetch, label: "Reading blog.rust-lang.org".into() }),
                Update::Text("\n\n".into()),
                Update::Text("It's 1.99.".into()),
            ]
        );
        assert_eq!(end, Some(Ok(())));
    }

    #[test]
    fn interrupted_ends_ok_and_failed_ends_readably() {
        let mut parser = Parser::new("t1".into());
        assert_eq!(run(&mut parser, &[completed("interrupted", Value::Null)]).1, Some(Ok(())));
        let limit = json!({ "message": "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 10th, 2026 12:13 AM.", "codexErrorInfo": "usageLimitExceeded" });
        let (_, end) = run(&mut parser, &[completed("failed", limit)]);
        assert_eq!(end, Some(Err("You've hit your Codex usage limit. Try again at Nov 10th, 2026 12:13 AM.".into())));
    }

    #[test]
    fn retried_errors_are_ignored_and_final_ones_kept() {
        let mut parser = Parser::new("t1".into());
        let retry = note("error", json!({ "threadId": "th", "turnId": "t1", "willRetry": true, "error": { "message": "Reconnecting... 2/5" } }));
        let fatal = note("error", json!({ "threadId": "th", "turnId": "t1", "willRetry": false, "error": { "message": "stream disconnected before completion" } }));
        let (out, end) = run(&mut parser, &[retry, fatal, completed("failed", json!({ "message": "" }))]);
        assert!(out.is_empty());
        assert_eq!(end, Some(Err("stream disconnected before completion".into())));
    }

    #[test]
    fn input_puts_text_first_then_images_as_data_urls() {
        let image = crate::store::OutgoingImage { data_base64: "AAAA".into(), mime: "image/png".into(), width: 1, height: 1 };
        let input = input("What's this?", &[image]);
        assert_eq!(input[0]["type"], "text");
        assert_eq!(input[1]["url"], "data:image/png;base64,AAAA");
        assert_eq!(super::input(" ", &[]).as_array().unwrap().len(), 0);
    }

    #[test]
    fn models_map_to_options() {
        let model = json!({ "id": "gpt-6.1-sol", "model": "gpt-6.1-sol", "displayName": "GPT-6.1-Sol", "description": "Workhorse.", "hidden": false, "isDefault": true });
        assert_eq!(model_option(&model), ModelOption { id: "gpt-6.1-sol".into(), label: "GPT-6.1-Sol".into(), description: Some("Workhorse.".into()), is_default: true });
        let json = serde_json::to_value(model_option(&json!({ "id": "m", "description": "" }))).unwrap();
        assert_eq!(json, json!({ "id": "m", "label": "m" }));
    }

    /// Real Codex: deltas arrive, a second turn on the same thread remembers the first, and
    /// stopping interrupts. Run with `cargo test -- --ignored codex_smoke --nocapture`.
    /// If the account is over its usage limit, this shows that error cleanly and stops there.
    #[test]
    #[ignore]
    fn codex_smoke() {
        use crate::store::{AssistantMessage, Status, UserMessage};
        let model = std::env::var("ASIDE_CODEX_MODEL").unwrap_or_default();
        let settings = Settings { web_search: false, codex_model: model, ..Settings::default() };
        let started = Instant::now();
        let models = models().unwrap();
        println!("{} models in {:?}, default {:?}", models.len(), started.elapsed(), models.iter().find(|m| m.is_default).map(|m| &m.id));
        warm(&settings);
        let conversation_id = format!("smoke-{}", crate::store::random_hex(6));
        let ask = |earlier: Vec<Message>, text: &str, answer_id: &str| {
            let turn = Turn { conversation_id: conversation_id.clone(), answer_id: answer_id.into(), earlier, text: text.into(), images: vec![], settings: settings.clone() };
            let (mut text_out, mut first) = (String::new(), None);
            let started = Instant::now();
            let result = stream(&turn, &Cancel::default(), &mut |u| {
                if let Update::Text(t) = u {
                    first.get_or_insert(started.elapsed());
                    text_out.push_str(&t);
                }
            });
            println!("{text:?} -> {text_out:?} {result:?}, first text after {first:?}");
            (result, text_out)
        };
        let (result, first) = ask(vec![], "My name is Zed. Reply with just: Hi Zed", "a1");
        if let Err(error) = &result {
            assert!(error.starts_with("You've hit your Codex usage limit"), "{error}");
            shutdown();
            return;
        }
        assert!(first.contains("Zed"), "{first}");
        let thread = live(|l| l.get(&conversation_id).map(|s| s.thread_id.clone()));
        let earlier = vec![
            Message::User(UserMessage { id: "u1".into(), text: "My name is Zed.".into(), images: vec![], at: 0 }),
            Message::Assistant(AssistantMessage { id: "a1".into(), text: first, provider: Provider::Codex, model: String::new(), status: Status::Done, error: None, tools: vec![], at: 0 }),
        ];
        let (result, second) = ask(earlier, "What's my name? One word.", "a2");
        assert_eq!(result, Ok(()));
        assert!(second.contains("Zed"), "{second}");
        assert_eq!(thread, live(|l| l.get(&conversation_id).map(|s| s.thread_id.clone())), "same thread");

        let cancel = Cancel::default();
        let turn = Turn { conversation_id: "smoke-stop".into(), answer_id: "s1".into(), earlier: vec![], text: "Write the numbers from 1 to 300 as English words, comma separated.".into(), images: vec![], settings: settings.clone() };
        let (mut got, mut stopped_at) = (0, None);
        let result = stream(&turn, &cancel, &mut |_| {
            got += 1;
            if got == 3 {
                stopped_at = Some(Instant::now());
                cancel.stop();
            }
        });
        println!("stopped after {got} updates, ended {:?} after stop: {result:?}", stopped_at.map(|at| at.elapsed()));
        assert!(cancel.is_stopped() && stopped_at.is_some_and(|at| at.elapsed() < STOP_GRACE));
        shutdown();
    }
}
