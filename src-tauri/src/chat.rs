//! Sending a message: save it, answer on a background thread with the provider the chat uses,
//! stream what arrives to the page, and save the answer when it ends. Several chats can stream
//! at once, each with its own way to stop.

use crate::settings::{self, Provider, Settings};
use crate::store::{self, AssistantMessage, Conversation, Message, OutgoingImage, Status, Store, ToolUse, UserMessage};
use crate::{claude, codex};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

pub const STREAM_EVENT: &str = "aside://stream";

/// Something that arrived while answering.
#[derive(Clone, PartialEq, Debug)]
pub enum Update {
    Text(String),
    Thinking,
    Tool(ToolUse),
}

/// One question for a provider, with what it needs to answer it in context.
pub struct Turn {
    pub conversation_id: String,
    /// The id of the assistant message this turn answers into.
    pub answer_id: String,
    /// The conversation before this question.
    pub earlier: Vec<Message>,
    pub text: String,
    pub images: Vec<OutgoingImage>,
    pub settings: Settings,
}

/// Stops one answer. A provider registers how to stop its process; `stop` runs that.
#[derive(Default)]
pub struct Cancel {
    stopped: AtomicBool,
    kill: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Cancel {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(kill) = self.kill.lock().unwrap().take() {
            kill();
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Runs `kill` on stop, or right away if stop already happened.
    pub fn on_stop(&self, kill: impl FnOnce() + Send + 'static) {
        let mut slot = self.kill.lock().unwrap();
        if self.is_stopped() {
            drop(slot);
            return kill();
        }
        *slot = Some(Box::new(kill));
    }

    /// The answer ended, so stopping has nothing left to do.
    pub fn clear(&self) {
        self.kill.lock().unwrap().take();
    }
}

static STREAMS: Mutex<Option<HashMap<String, Arc<Cancel>>>> = Mutex::new(None);
static LAST_FINISHED: Mutex<Option<Instant>> = Mutex::new(None);

fn streams<T>(f: impl FnOnce(&mut HashMap<String, Arc<Cancel>>) -> T) -> T {
    f(STREAMS.lock().unwrap().get_or_insert_with(HashMap::new))
}

pub fn is_streaming() -> bool {
    streams(|s| !s.is_empty())
}

pub fn is_streaming_in(conversation_id: &str) -> bool {
    streams(|s| s.contains_key(conversation_id))
}

/// When the last answer finished, for the panel's idle rule.
pub fn last_finished() -> Option<Instant> {
    *LAST_FINISHED.lock().unwrap()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub conversation_id: Option<String>,
    pub text: String,
    #[serde(default)]
    pub images: Vec<OutgoingImage>,
    pub provider: Provider,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub conversation_id: String,
    /// Both go out as `Message`, so they carry their `role` like everywhere else.
    pub user: Message,
    pub assistant: Message,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StreamKind {
    Text { text: String },
    Thinking,
    Tool { tool: ToolUse },
    /// Always a `Message::Assistant`, so it carries `role`.
    Done { message: Message },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub conversation_id: String,
    pub message_id: String,
    #[serde(flatten)]
    pub event: StreamKind,
}

/// Saves the question and an empty answer, then answers on a background thread.
pub fn send(app: &AppHandle, store: &Store, request: SendRequest) -> Result<SendResult, String> {
    let app = app.clone();
    start(store, request, move |event| {
        let _ = app.emit_to(crate::panel::LABEL, STREAM_EVENT, event);
    })
}

/// `send`, with the events going wherever `emit` sends them (tests collect them).
fn start(store: &Store, request: SendRequest, emit: impl Fn(StreamEvent) + Send + 'static) -> Result<SendResult, String> {
    let text = request.text.trim().to_string();
    if text.is_empty() && request.images.is_empty() {
        return Err("Type something to ask".into());
    }
    let settings = settings::load();
    let now = store::now_ms();
    let mut conversation = match &request.conversation_id {
        Some(id) => store.load(id)?,
        None => Conversation {
            id: store::new_conversation_id(),
            created_at: now,
            updated_at: now,
            title: String::new(),
            provider: request.provider,
            messages: Vec::new(),
        },
    };
    let images = request.images.iter().map(|image| store.save_image(image)).collect::<Result<Vec<_>, _>>()?;
    let user = UserMessage { id: store::new_message_id(), text: text.clone(), images, at: now };
    let model = match request.provider {
        Provider::Claude => settings.claude_model.clone(),
        Provider::Codex => settings.codex_model.clone(),
    };
    let assistant = AssistantMessage {
        id: store::new_message_id(),
        text: String::new(),
        provider: request.provider,
        model,
        status: Status::Streaming,
        error: None,
        tools: Vec::new(),
        at: now,
    };

    let cancel = Arc::new(Cancel::default());
    let busy = streams(|s| {
        if s.contains_key(&conversation.id) {
            return true;
        }
        s.insert(conversation.id.clone(), cancel.clone());
        false
    });
    if busy {
        return Err("Aside is still answering in this chat. Stop it first.".into());
    }

    let earlier = conversation.messages.clone();
    if conversation.title.is_empty() {
        conversation.title = if text.is_empty() { "Image".into() } else { store::title(&text) };
    }
    conversation.provider = request.provider;
    conversation.updated_at = now;
    conversation.messages.push(Message::User(user.clone()));
    conversation.messages.push(Message::Assistant(assistant.clone()));
    if let Err(error) = store.save(&conversation) {
        streams(|s| s.remove(&conversation.id));
        return Err(error);
    }

    let turn = Turn {
        conversation_id: conversation.id.clone(),
        answer_id: assistant.id.clone(),
        earlier,
        text,
        images: request.images,
        settings,
    };
    let (store, answer) = (store.clone(), assistant.clone());
    std::thread::spawn(move || run(&emit, &store, turn, answer, &cancel));
    Ok(SendResult { conversation_id: conversation.id, user: Message::User(user), assistant: Message::Assistant(assistant) })
}

/// Streams the answer to the page, then saves it however it ended.
fn run(sink: &impl Fn(StreamEvent), store: &Store, turn: Turn, mut answer: AssistantMessage, cancel: &Cancel) {
    let emit = |event: StreamKind| sink(StreamEvent { conversation_id: turn.conversation_id.clone(), message_id: turn.answer_id.clone(), event });
    let mut on = |update: Update| match update {
        Update::Text(text) => {
            answer.text.push_str(&text);
            emit(StreamKind::Text { text });
        }
        Update::Thinking => emit(StreamKind::Thinking),
        Update::Tool(tool) => {
            answer.tools.push(tool.clone());
            emit(StreamKind::Tool { tool });
        }
    };
    let result = match answer.provider {
        Provider::Claude => claude::stream(&turn, cancel, &mut on),
        Provider::Codex => codex::stream(&turn, cancel, &mut on),
    };
    cancel.clear();
    finish(&mut answer, result, cancel.is_stopped());

    // If it was deleted while answering, there's nothing to save into.
    if let Ok(mut conversation) = store.load(&turn.conversation_id) {
        if let Some(Message::Assistant(saved)) = conversation.messages.iter_mut().find(|m| m.id() == answer.id) {
            *saved = answer.clone();
        }
        conversation.updated_at = store::now_ms();
        if let Err(error) = store.save(&conversation) {
            answer.status = Status::Error;
            answer.error = Some(error);
        }
    }
    streams(|s| s.remove(&turn.conversation_id));
    *LAST_FINISHED.lock().unwrap() = Some(Instant::now());
    emit(StreamKind::Done { message: Message::Assistant(answer) });
}

/// The status and error an answer ends with.
fn finish(answer: &mut AssistantMessage, result: Result<(), String>, stopped: bool) {
    answer.text = answer.text.trim_end().to_string();
    (answer.status, answer.error) = match result {
        _ if stopped => (Status::Stopped, None),
        Ok(()) if answer.text.is_empty() => (Status::Error, Some("No answer came back. Try again.".into())),
        Ok(()) => (Status::Done, None),
        Err(error) => (Status::Error, Some(error)),
    };
}

/// Stops the answer streaming in this chat, if there is one.
pub fn stop(conversation_id: &str) {
    if let Some(cancel) = streams(|s| s.get(conversation_id).cloned()) {
        cancel.stop();
    }
}

/// On quit: stop every answer so no CLI process outlives the app.
pub fn stop_all() {
    for cancel in streams(|s| s.values().cloned().collect::<Vec<_>>()) {
        cancel.stop();
    }
}

/// An answer still marked streaming that nothing is streaming into was cut off (e.g. the app
/// quit mid-answer), so show it as stopped.
pub fn settle(mut conversation: Conversation) -> Conversation {
    if is_streaming_in(&conversation.id) {
        return conversation;
    }
    for message in &mut conversation.messages {
        if let Message::Assistant(a) = message
            && a.status == Status::Streaming
        {
            a.status = Status::Stopped;
        }
    }
    conversation
}

/// The system prompt both providers get.
pub fn system_prompt(settings: &Settings) -> String {
    let today = chrono::Local::now().format("%A, %-d %B %Y");
    let mut prompt = format!(
        "You are Aside, a quick assistant the user pops up over whatever they're doing on their Mac. \
         Answer directly and briefly unless they ask for depth. Use Markdown, and fenced code blocks \
         with a language. Today is {today}."
    );
    let instructions = settings.instructions.trim();
    if !instructions.is_empty() {
        prompt.push_str("\n\nThe user's own instructions:\n");
        prompt.push_str(instructions);
    }
    prompt
}

/// The conversation so far as text, for a model that hasn't seen it, followed by the new
/// question. Earlier images become a note; the new question's images go as images.
pub fn with_transcript(earlier: &[Message], text: &str) -> String {
    let mut parts = Vec::new();
    for message in earlier {
        match message {
            Message::User(u) => {
                let mut body = u.text.clone();
                for _ in &u.images {
                    body.push_str("\n[image]");
                }
                parts.push(format!("<user>\n{}\n</user>", body.trim()));
            }
            Message::Assistant(a) if !a.text.trim().is_empty() => parts.push(format!("<assistant>\n{}\n</assistant>", a.text.trim())),
            Message::Assistant(_) => {}
        }
    }
    if parts.is_empty() {
        return text.to_string();
    }
    format!("This continues our earlier conversation:\n\n{}\n\nMy new message:\n\n{text}", parts.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ImageRef, ToolKind};

    fn assistant(text: &str) -> AssistantMessage {
        AssistantMessage { id: "a".into(), text: text.into(), provider: Provider::Claude, model: String::new(), status: Status::Streaming, error: None, tools: vec![], at: 0 }
    }

    #[test]
    fn stream_events_flatten_both_ids() {
        let event = StreamEvent { conversation_id: "c".into(), message_id: "m".into(), event: StreamKind::Text { text: "hi".into() } };
        assert_eq!(serde_json::to_value(&event).unwrap(), serde_json::json!({ "conversationId": "c", "messageId": "m", "kind": "text", "text": "hi" }));
        let event = StreamEvent { conversation_id: "c".into(), message_id: "m".into(), event: StreamKind::Thinking };
        assert_eq!(serde_json::to_value(&event).unwrap(), serde_json::json!({ "conversationId": "c", "messageId": "m", "kind": "thinking" }));
        let tool = ToolUse { kind: ToolKind::Fetch, label: "Reading x.com".into() };
        let event = StreamEvent { conversation_id: "c".into(), message_id: "m".into(), event: StreamKind::Tool { tool } };
        assert_eq!(serde_json::to_value(&event).unwrap()["tool"]["kind"], "fetch");
        let event = StreamEvent { conversation_id: "c".into(), message_id: "m".into(), event: StreamKind::Done { message: Message::Assistant(assistant("x")) } };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["kind"], "done");
        assert_eq!(json["message"]["role"], "assistant");
        assert_eq!(json["message"]["status"], "streaming");
    }

    #[test]
    fn finishing_picks_the_status() {
        let mut a = assistant("Hello  \n");
        finish(&mut a, Ok(()), false);
        assert_eq!((a.status, a.text.as_str(), a.error.clone()), (Status::Done, "Hello", None));
        let mut a = assistant("Half");
        finish(&mut a, Err("Killed".into()), true);
        assert_eq!((a.status, a.text.as_str(), a.error.clone()), (Status::Stopped, "Half", None));
        let mut a = assistant("");
        finish(&mut a, Err("Not signed in".into()), false);
        assert_eq!((a.status, a.error.as_deref()), (Status::Error, Some("Not signed in")));
        let mut a = assistant("");
        finish(&mut a, Ok(()), false);
        assert_eq!(a.status, Status::Error);
    }

    #[test]
    fn transcript_wraps_earlier_turns() {
        assert_eq!(with_transcript(&[], "Hi"), "Hi");
        let image = ImageRef { file: "a.png".into(), mime: "image/png".into(), width: 1, height: 1 };
        let earlier = vec![
            Message::User(UserMessage { id: "u".into(), text: "What's this?".into(), images: vec![image], at: 0 }),
            Message::Assistant(assistant("A cat.")),
            Message::Assistant(assistant("")),
        ];
        let text = with_transcript(&earlier, "Its name?");
        assert!(text.contains("<user>\nWhat's this?\n[image]\n</user>"));
        assert!(text.contains("<assistant>\nA cat.\n</assistant>"));
        assert!(text.ends_with("My new message:\n\nIts name?"));
        assert_eq!(text.matches("<assistant>").count(), 1);
    }

    #[test]
    fn settle_marks_cut_off_answers_stopped() {
        let conversation = Conversation {
            id: "never-streamed".into(),
            created_at: 0,
            updated_at: 0,
            title: String::new(),
            provider: Provider::Claude,
            messages: vec![Message::Assistant(assistant("half"))],
        };
        let Message::Assistant(a) = &settle(conversation).messages[0] else { panic!() };
        assert_eq!(a.status, Status::Stopped);
    }

    #[test]
    fn cancel_runs_kill_once_even_if_registered_late() {
        use std::sync::atomic::AtomicUsize;
        let count = Arc::new(AtomicUsize::new(0));
        let cancel = Cancel::default();
        let c = count.clone();
        cancel.on_stop(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        cancel.stop();
        cancel.stop();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let late = Cancel::default();
        late.stop();
        let c = count.clone();
        late.on_stop(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    /// The whole path for real: send, stream, stop mid-answer, and what's saved on disk.
    /// `ASIDE_CHAT_PROVIDER=codex` (with `ASIDE_CODEX_ARGS`) tries Codex; the default is Claude
    /// on haiku. Run with `cargo test -- --ignored chat_end_to_end --nocapture`.
    #[test]
    #[ignore]
    fn chat_end_to_end() {
        use std::sync::mpsc;
        use std::time::Duration;
        let provider = if std::env::var("ASIDE_CHAT_PROVIDER").as_deref() == Ok("codex") { Provider::Codex } else { Provider::Claude };
        settings::use_for_test(Settings { claude_model: "haiku".into(), web_search: false, ..Settings::default() });
        let store = Store::new(std::env::temp_dir().join(format!("aside-e2e-{}", store::random_hex(8))));
        let (tx, rx) = mpsc::channel::<StreamEvent>();
        let sink = move |tx: mpsc::Sender<StreamEvent>| move |event| {
            let _ = tx.send(event);
        };
        let done = |rx: &mpsc::Receiver<StreamEvent>, stop_after: Option<usize>| {
            let (mut text, mut deltas) = (String::new(), 0);
            loop {
                let event = rx.recv_timeout(Duration::from_secs(90)).expect("no done event");
                match event.event {
                    StreamKind::Text { text: t } => {
                        text.push_str(&t);
                        deltas += 1;
                        if stop_after == Some(deltas) {
                            stop(&event.conversation_id);
                        }
                    }
                    StreamKind::Done { message: Message::Assistant(a) } => return (text, a),
                    _ => {}
                }
            }
        };

        let request = SendRequest { conversation_id: None, text: "Reply with just: Hi there".into(), images: vec![], provider };
        let sent = start(&store, request, sink(tx.clone())).unwrap();
        assert!(is_streaming_in(&sent.conversation_id));
        let (text, answer) = done(&rx, None);
        println!("first: {text:?} -> {:?} {:?}", answer.status, answer.error);
        let conversation = store.load(&sent.conversation_id).unwrap();
        assert_eq!(conversation.title, "Reply with just: Hi there");
        let Message::Assistant(saved) = &conversation.messages[1] else { panic!() };
        assert_eq!(saved, &answer, "done carries the saved message");
        if answer.status == Status::Error {
            println!("ended with an error, as saved: {:?}", answer.error);
            claude::shutdown();
            return codex::shutdown();
        }
        assert_eq!(answer.status, Status::Done);

        let request = SendRequest { conversation_id: Some(sent.conversation_id.clone()), text: "Now count from 1 to 300, one number per line.".into(), images: vec![], provider };
        start(&store, request, sink(tx)).unwrap();
        let (partial, answer) = done(&rx, Some(5));
        println!("stopped: {} chars streamed, saved {:?} with {} chars", partial.len(), answer.status, answer.text.len());
        assert_eq!(answer.status, Status::Stopped);
        assert!(!answer.text.is_empty() && partial.trim_end().starts_with(&answer.text));
        let conversation = store.load(&sent.conversation_id).unwrap();
        assert_eq!(conversation.messages.len(), 4);
        assert_eq!(conversation.messages[3], Message::Assistant(answer));
        assert!(!is_streaming_in(&sent.conversation_id));
        claude::shutdown();
        codex::shutdown();
        let _ = std::fs::remove_dir_all(&store.root);
    }

}
