//! Answers with the user's own Claude Code login, through `claude -p` in stream-json mode.
//!
//! Each chat keeps its own process alive, so a follow-up sends only the new message. One spare
//! process is started ahead of time so a new chat doesn't wait ~1s for startup. Processes nobody
//! has used for a while are killed. `--no-session-persistence` keeps these chats out of the
//! user's Claude Code history.

use crate::chat::{self, Cancel, Turn, Update};
use crate::cli;
use crate::settings::{Provider, ProviderStatus, Settings};
use crate::store::{Message, ToolKind, ToolUse};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Kill processes nobody has used for this long.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// Each live process is a Node runtime, so keep only the most recent few chats warm.
const MAX_LIVE: usize = 3;
const SEARCH_TOOLS: &str = "WebSearch,WebFetch";

/// What a process was started with. A chat can only reuse a process started the same way.
#[derive(Clone, PartialEq, Debug)]
struct Key {
    model: String,
    effort: String,
    web_search: bool,
    system: String,
}

impl Key {
    fn new(settings: &Settings) -> Self {
        Key {
            model: settings.claude_model.clone(),
            effort: settings.claude_effort.clone(),
            web_search: settings.web_search,
            system: chat::system_prompt(settings),
        }
    }
}

struct Process {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: JoinHandle<String>,
}

/// A process waiting for its next message.
struct Session {
    key: Key,
    process: Process,
    /// The answer it gave last, so a chat only reuses a process that saw everything before.
    last_answer: Option<String>,
    since: Instant,
}

impl Session {
    fn alive(&self) -> bool {
        matches!(self.process.child.lock().unwrap().try_wait(), Ok(None))
    }

    fn kill(self) {
        kill(&self.process.child);
    }
}

fn kill(child: &Mutex<Child>) {
    let mut child = child.lock().unwrap();
    let _ = child.kill();
    let _ = child.wait();
}

static WARM: Mutex<Option<Session>> = Mutex::new(None);
/// Live processes by conversation id.
static LIVE: Mutex<Option<HashMap<String, Session>>> = Mutex::new(None);
static REAPER: OnceLock<()> = OnceLock::new();

fn live<T>(f: impl FnOnce(&mut HashMap<String, Session>) -> T) -> T {
    f(LIVE.lock().unwrap().get_or_insert_with(HashMap::new))
}

/// Starts a spare process for the current settings, so the next new chat answers sooner.
pub fn warm(settings: &Settings) {
    warm_key(Key::new(settings));
}

fn warm_key(key: Key) {
    let mut warm = WARM.lock().unwrap();
    if warm.as_ref().is_some_and(|w| w.key == key && w.alive()) {
        return;
    }
    if let Some(old) = warm.take() {
        old.kill();
    }
    *warm = spawn(&key).ok().map(|process| Session { key, process, last_answer: None, since: Instant::now() });
    start_reaper();
}

fn start_reaper() {
    REAPER.get_or_init(|| {
        thread::spawn(reap);
    });
}

/// Kills every process, e.g. on quit.
pub fn shutdown() {
    if let Some(warm) = WARM.lock().unwrap().take() {
        warm.kill();
    }
    for (_, session) in live(std::mem::take) {
        session.kill();
    }
}

fn reap() {
    loop {
        thread::sleep(Duration::from_secs(30));
        let mut warm = WARM.lock().unwrap();
        if warm.as_ref().is_some_and(|w| w.since.elapsed() > IDLE) {
            warm.take().unwrap().kill();
        }
        drop(warm);
        let idle: Vec<Session> = live(|l| {
            let ids: Vec<String> = l.iter().filter(|(_, s)| s.since.elapsed() > IDLE).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| l.remove(id)).collect()
        });
        idle.into_iter().for_each(Session::kill);
    }
}

fn spawn(key: &Key) -> Result<Process, String> {
    let mut command = cli::command("claude", "Claude Code isn't installed. Install it, then sign in with `claude`.")?;
    command.arg("-p");
    if key.web_search {
        command.args(["--tools", SEARCH_TOOLS, "--allowedTools", SEARCH_TOOLS]);
    } else {
        command.args(["--tools", ""]);
    }
    command.args(["--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"]);
    command.args(["--model", &key.model]);
    if !key.effort.is_empty() {
        command.args(["--effort", &key.effort]);
    }
    command.args(["--system-prompt", &key.system]);
    command.args(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
    Ok(Process {
        stdin: child.stdin.take().unwrap(),
        stdout: BufReader::new(child.stdout.take().unwrap()),
        stderr: cli::collect(child.stderr.take().unwrap()),
        child: Arc::new(Mutex::new(child)),
    })
}

/// The process already holding this chat, or else the spare one, or else a new one.
/// The bool says whether the spare was used, so another can be started.
fn session(conversation_id: &str, key: &Key, earlier: &[Message]) -> Result<(Session, bool), String> {
    let previous = earlier.last().map(|m| m.id().to_string());
    if let Some(session) = live(|l| l.remove(conversation_id)) {
        if &session.key == key && session.last_answer.is_some() && session.last_answer == previous && session.alive() {
            return Ok((session, false));
        }
        session.kill();
    }
    if let Some(warm) = WARM.lock().unwrap().take() {
        if &warm.key == key && warm.alive() {
            return Ok((warm, true));
        }
        warm.kill();
    }
    Ok((Session { process: spawn(key)?, key: key.clone(), last_answer: None, since: Instant::now() }, false))
}

/// The JSON line that sends one user turn.
fn user_line(text: &str, images: &[crate::store::OutgoingImage]) -> String {
    let mut content: Vec<serde_json::Value> = images
        .iter()
        .map(|image| {
            let mime = if image.mime == "image/jpg" { "image/jpeg" } else { image.mime.as_str() };
            serde_json::json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": image.data_base64 } })
        })
        .collect();
    if !text.trim().is_empty() {
        content.push(serde_json::json!({ "type": "text", "text": text }));
    }
    serde_json::json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string()
}

/// Blocking. Streams one answer through `on`; Ok when Claude says the turn is over.
pub fn stream(turn: &Turn, cancel: &Cancel, on: &mut dyn FnMut(Update)) -> Result<(), String> {
    let key = Key::new(&turn.settings);
    let (mut session, used_warm) = session(&turn.conversation_id, &key, &turn.earlier)?;
    let text = if session.last_answer.is_some() { turn.text.clone() } else { chat::with_transcript(&turn.earlier, &turn.text) };
    let child = session.process.child.clone();
    cancel.on_stop(move || kill(&child));

    let written = writeln!(session.process.stdin, "{}", user_line(&text, &turn.images)).and_then(|_| session.process.stdin.flush());
    let mut parser = Parser::default();
    let mut line = String::new();
    let ended = 'read: loop {
        line.clear();
        if written.is_err() || !matches!(session.process.stdout.read_line(&mut line), Ok(1..)) || cancel.is_stopped() {
            break None;
        }
        for parsed in parser.line(&line) {
            match parsed {
                Parsed::Update(update) => on(update),
                Parsed::End(result) => break 'read Some(result),
            }
        }
    };
    if used_warm {
        // Started now, it's ready by the time the user starts another chat.
        let key = key.clone();
        thread::spawn(move || warm_key(key));
    }

    match ended {
        Some(Ok(())) if !cancel.is_stopped() => {
            session.last_answer = Some(turn.answer_id.clone());
            session.since = Instant::now();
            keep(turn.conversation_id.clone(), session);
            Ok(())
        }
        Some(result) => {
            session.kill();
            result
        }
        None => {
            let Process { child, stderr, .. } = session.process;
            kill(&child);
            if cancel.is_stopped() {
                return Err("Stopped".into());
            }
            let detail = cli::last_line(&stderr.join().unwrap_or_default());
            let status = child.lock().unwrap().try_wait().ok().flatten();
            Err(detail.map(|d| readable_error(&d)).unwrap_or_else(|| match status {
                Some(status) => format!("Claude Code stopped without answering ({status})"),
                None => "Claude Code stopped without answering".into(),
            }))
        }
    }
}

/// Keeps a process for the chat's next message, making room if too many are kept.
fn keep(conversation_id: String, session: Session) {
    start_reaper();
    let evicted = live(|l| {
        l.insert(conversation_id, session);
        if l.len() <= MAX_LIVE {
            return None;
        }
        let oldest = l.iter().min_by_key(|(_, s)| s.since).map(|(id, _)| id.clone())?;
        l.remove(&oldest)
    });
    if let Some(session) = evicted {
        session.kill();
    }
}

/// Turns Claude Code's error text into something worth showing.
fn readable_error(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("/login") || lower.contains("not logged in") || lower.contains("invalid api key") {
        return "Claude Code isn't signed in. Run `claude` in a terminal to sign in.".into();
    }
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(text);
    if line.chars().count() > 240 {
        return format!("{}…", line.chars().take(239).collect::<String>());
    }
    line.to_string()
}

pub enum Parsed {
    Update(Update),
    /// The turn is over: Ok, or Claude's error.
    End(Result<(), String>),
}

/// Reads Claude's stream-json output, one line at a time.
#[derive(Default)]
pub struct Parser {
    /// Some answer text has gone out, so a later text block needs a gap before it.
    wrote_text: bool,
    /// The next text delta starts a new block after earlier text.
    gap: bool,
    tools: HashSet<String>,
}

impl Parser {
    pub fn line(&mut self, line: &str) -> Vec<Parsed> {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { return Vec::new() };
        match event["type"].as_str() {
            Some("stream_event") => self.stream_event(&event["event"]),
            Some("assistant") => self.assistant(&event["message"]),
            Some("result") => vec![Parsed::End(result(&event))],
            _ => Vec::new(),
        }
    }

    fn stream_event(&mut self, event: &serde_json::Value) -> Vec<Parsed> {
        match event["type"].as_str() {
            Some("content_block_start") => match event["content_block"]["type"].as_str() {
                Some("thinking" | "redacted_thinking") => vec![Parsed::Update(Update::Thinking)],
                Some("text") => {
                    self.gap = self.wrote_text;
                    Vec::new()
                }
                _ => Vec::new(),
            },
            Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                let text = event["delta"]["text"].as_str().unwrap_or_default();
                if text.is_empty() {
                    return Vec::new();
                }
                let mut out = Vec::new();
                if std::mem::take(&mut self.gap) {
                    out.push(Parsed::Update(Update::Text("\n\n".into())));
                }
                self.wrote_text = true;
                out.push(Parsed::Update(Update::Text(text.into())));
                out
            }
            _ => Vec::new(),
        }
    }

    /// A finished message: tool calls show up here with their whole input.
    fn assistant(&mut self, message: &serde_json::Value) -> Vec<Parsed> {
        let Some(blocks) = message["content"].as_array() else { return Vec::new() };
        blocks
            .iter()
            .filter(|b| b["type"] == "tool_use")
            .filter(|b| self.tools.insert(b["id"].as_str().unwrap_or_default().to_string()) || b["id"].is_null())
            .map(|b| Parsed::Update(Update::Tool(tool(b["name"].as_str().unwrap_or_default(), &b["input"]))))
            .collect()
    }
}

fn result(event: &serde_json::Value) -> Result<(), String> {
    if event["is_error"] != true {
        return Ok(());
    }
    let text = event["result"].as_str().map(str::trim).filter(|t| !t.is_empty());
    let subtype = event["subtype"].as_str().unwrap_or("error");
    Err(text.map(readable_error).unwrap_or_else(|| format!("Claude stopped early ({subtype})")))
}

fn tool(name: &str, input: &serde_json::Value) -> ToolUse {
    match name {
        "WebSearch" => {
            let query = input["query"].as_str().unwrap_or_default().trim();
            let label = if query.is_empty() { "Searching the web".into() } else { format!("Searching for “{query}”") };
            ToolUse { kind: ToolKind::Search, label }
        }
        "WebFetch" => {
            let host = input["url"].as_str().map(host).unwrap_or_default();
            let label = if host.is_empty() { "Reading a page".into() } else { format!("Reading {host}") };
            ToolUse { kind: ToolKind::Fetch, label }
        }
        other => ToolUse { kind: ToolKind::Other, label: format!("Using {other}") },
    }
}

/// "https://www.example.com/a/b" → "example.com".
fn host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.rsplit('@').next().unwrap_or_default();
    host.trim_start_matches("www.").to_string()
}

/// Blocking: whether Claude Code is installed and signed in.
pub fn status() -> ProviderStatus {
    let not = |detail: &str| ProviderStatus { id: Provider::Claude, ready: false, detail: detail.into() };
    let Ok(mut command) = cli::command("claude", "") else { return not("Not installed") };
    let Ok(output) = command.args(["auth", "status"]).output() else { return not("Not installed") };
    let auth: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    if auth["loggedIn"] != true {
        return not("Run `claude` in a terminal to sign in");
    }
    let detail = match auth["authMethod"].as_str() {
        Some("claude.ai") => "Signed in with Claude.ai".to_string(),
        Some(method) => format!("Signed in ({method})"),
        None => "Signed in".to_string(),
    };
    ProviderStatus { id: Provider::Claude, ready: true, detail }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn updates(parser: &mut Parser, lines: &[&str]) -> (Vec<Update>, Option<Result<(), String>>) {
        let mut out = Vec::new();
        let mut end = None;
        for line in lines {
            for parsed in parser.line(line) {
                match parsed {
                    Parsed::Update(u) => out.push(u),
                    Parsed::End(r) => end = Some(r),
                }
            }
        }
        (out, end)
    }

    // Lines as Claude Code 2.1.318 writes them, trimmed of fields we don't read.
    const TEXT_START: &str = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#;
    const THINKING_START: &str = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}"#;
    const THINKING_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"","estimated_tokens":50}}}"#;
    const TOOL_START: &str = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"WebSearch","input":{}}}}"#;
    const TOOL_INPUT: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\": \"latest"}}}"#;
    const TOOL_DONE: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"WebSearch","input":{"query":"latest Rust release","mode":"standard"}}]}}"#;
    const FETCH_DONE: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"WebFetch","input":{"url":"https://www.blog.rust-lang.org/2026/x","prompt":"?"}}]}}"#;
    const RESULT_OK: &str = r#"{"duration_api_ms":1290,"stop_reason":"end_turn","is_error":false,"num_turns":1,"subtype":"success","result":"Hi there, Zed!","type":"result"}"#;

    fn delta(text: &str) -> String {
        serde_json::json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } } }).to_string()
    }

    #[test]
    fn streams_text_deltas_and_ends_on_result() {
        let mut parser = Parser::default();
        let (a, b) = (delta("Hi there"), delta(", Zed!"));
        let init = r#"{"type":"system","subtype":"init","tools":[]}"#;
        let full = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there, Zed!"}]}}"#;
        let (out, end) = updates(&mut parser, &[init, TEXT_START, &a, &b, full, RESULT_OK]);
        assert_eq!(out, [Update::Text("Hi there".into()), Update::Text(", Zed!".into())]);
        assert_eq!(end, Some(Ok(())));
    }

    #[test]
    fn search_rounds_show_tools_thinking_and_a_gap_between_texts() {
        let mut parser = Parser::default();
        let (first, second) = (delta("Let me check."), delta("It's 1.99."));
        let (out, _) = updates(&mut parser, &[TEXT_START, &first, TOOL_START, TOOL_INPUT, TOOL_DONE, TOOL_DONE, THINKING_START, THINKING_DELTA, FETCH_DONE, TEXT_START, &second]);
        assert_eq!(
            out,
            [
                Update::Text("Let me check.".into()),
                Update::Tool(ToolUse { kind: ToolKind::Search, label: "Searching for “latest Rust release”".into() }),
                Update::Thinking,
                Update::Tool(ToolUse { kind: ToolKind::Fetch, label: "Reading blog.rust-lang.org".into() }),
                Update::Text("\n\n".into()),
                Update::Text("It's 1.99.".into()),
            ]
        );
    }

    #[test]
    fn no_gap_before_the_first_text() {
        let mut parser = Parser::default();
        let text = delta("Answer");
        let (out, _) = updates(&mut parser, &[TOOL_DONE, TEXT_START, &text]);
        assert_eq!(out[1], Update::Text("Answer".into()));
    }

    #[test]
    fn errors_end_the_turn_readably() {
        let mut parser = Parser::default();
        let login = r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login","subtype":"success"}"#;
        let (_, end) = updates(&mut parser, &[login]);
        assert_eq!(end, Some(Err("Claude Code isn't signed in. Run `claude` in a terminal to sign in.".into())));
        let bare = r#"{"type":"result","is_error":true,"subtype":"error_max_turns"}"#;
        let (_, end) = updates(&mut parser, &[bare]);
        assert_eq!(end, Some(Err("Claude stopped early (error_max_turns)".into())));
        assert!(parser.line("not json").is_empty());
    }

    #[test]
    fn user_line_puts_images_before_text() {
        let image = crate::store::OutgoingImage { data_base64: "AAAA".into(), mime: "image/jpg".into(), width: 1, height: 1 };
        let line: serde_json::Value = serde_json::from_str(&user_line("What's this?", &[image])).unwrap();
        let content = &line["message"]["content"];
        assert_eq!(content[0]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[1]["text"], "What's this?");
        let line: serde_json::Value = serde_json::from_str(&user_line("  ", &[])).unwrap();
        assert_eq!(line["message"]["content"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn hosts_from_urls() {
        assert_eq!(host("https://www.example.com/a?b"), "example.com");
        assert_eq!(host("http://user@docs.rs#x"), "docs.rs");
        assert_eq!(host("example.org/path"), "example.org");
    }

    /// Real Claude Code, cheap model: deltas arrive, and a second turn on the same process
    /// remembers the first. Run with `cargo test -- --ignored claude_smoke --nocapture`.
    #[test]
    #[ignore]
    fn claude_smoke() {
        use crate::store::{AssistantMessage, Status, UserMessage};
        let settings = Settings { claude_model: "haiku".into(), web_search: false, ..Settings::default() };
        let conversation_id = format!("smoke-{}", crate::store::random_hex(6));
        let ask = |earlier: Vec<Message>, text: &str, answer_id: &str| {
            let turn = Turn { conversation_id: conversation_id.clone(), answer_id: answer_id.into(), earlier, text: text.into(), images: vec![], settings: settings.clone() };
            let mut deltas = Vec::new();
            let started = Instant::now();
            let result = stream(&turn, &Cancel::default(), &mut |u| {
                if let Update::Text(t) = u {
                    deltas.push(t);
                }
            });
            println!("{text:?} -> {deltas:?} in {:?}", started.elapsed());
            (result, deltas.concat(), deltas.len())
        };
        let (result, first, count) = ask(vec![], "My name is Zed. Reply with just: Hi Zed", "a1");
        assert_eq!(result, Ok(()));
        assert!(count >= 1 && first.contains("Zed"), "{first}");
        let earlier = vec![
            Message::User(UserMessage { id: "u1".into(), text: "My name is Zed.".into(), images: vec![], at: 0 }),
            Message::Assistant(AssistantMessage { id: "a1".into(), text: first, provider: Provider::Claude, model: "haiku".into(), status: Status::Done, error: None, tools: vec![], at: 0 }),
        ];
        let pid = live(|l| l.get(&conversation_id).map(|s| s.process.child.lock().unwrap().id()));
        assert!(pid.is_some(), "kept alive for the next message");
        // Only the new question goes to the process, so remembering proves it's the same one.
        let (result, second, _) = ask(earlier, "What's my name? One word.", "a2");
        assert_eq!(result, Ok(()));
        assert!(second.contains("Zed"), "{second}");
        assert_eq!(pid, live(|l| l.get(&conversation_id).map(|s| s.process.child.lock().unwrap().id())));

        // A chat with no process (e.g. reopened later) gets the transcript replayed, on the spare.
        warm(&settings);
        thread::sleep(Duration::from_secs(3));
        let earlier = vec![
            Message::User(UserMessage { id: "u1".into(), text: "My favourite colour is teal.".into(), images: vec![], at: 0 }),
            Message::Assistant(AssistantMessage { id: "old".into(), text: "Noted.".into(), provider: Provider::Claude, model: "haiku".into(), status: Status::Done, error: None, tools: vec![], at: 0 }),
        ];
        let turn = Turn { conversation_id: "smoke-replay".into(), answer_id: "r1".into(), earlier, text: "What's my favourite colour? One word.".into(), images: vec![], settings: settings.clone() };
        let started = Instant::now();
        let mut first = None;
        let mut text = String::new();
        let result = stream(&turn, &Cancel::default(), &mut |u| {
            if let Update::Text(t) = u {
                first.get_or_insert(started.elapsed());
                text.push_str(&t);
            }
        });
        println!("replayed on the spare: {text:?}, first text after {first:?}");
        assert_eq!(result, Ok(()));
        assert!(text.to_lowercase().contains("teal"), "{text}");

        // Stopping mid-answer kills the process and ends the stream right away.
        let cancel = Cancel::default();
        let turn = Turn { conversation_id: "smoke-stop".into(), answer_id: "s1".into(), earlier: vec![], text: "Count from 1 to 300, one number per line.".into(), images: vec![], settings: settings.clone() };
        let mut got = 0;
        let mut stopped_at = None;
        let result = stream(&turn, &cancel, &mut |_| {
            got += 1;
            if got == 3 {
                stopped_at = Some(Instant::now());
                cancel.stop();
            }
        });
        let ended_after = stopped_at.map(|at| at.elapsed());
        println!("stopped after {got} updates, stream ended {ended_after:?} after stop: {result:?}");
        assert!(cancel.is_stopped() && ended_after.is_some_and(|d| d < Duration::from_millis(500)));
        assert!(live(|l| !l.contains_key("smoke-stop")));
        shutdown();
    }
}
