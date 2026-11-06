// The shapes shared with the Rust side (src-tauri). Field names here are the JSON field names.

export type Provider = 'claude' | 'codex'

/** An image saved with a conversation. `file` is a name inside `SettingsInfo.imagesDir`. */
export type ImageRef = { file: string; mime: string; width: number; height: number }

/** An image ready to send: already downscaled by the page. Base64 without the `data:` prefix. */
export type OutgoingImage = { dataBase64: string; mime: string; width: number; height: number }

/** Raw bytes read from the clipboard or a dropped file, before the page downscales them. */
export type RawImage = { dataBase64: string; mime: string }

/** Something the model did on the way to its answer, e.g. a web search. */
export type ToolUse = { kind: 'search' | 'fetch' | 'other'; label: string }

export type UserMessage = {
  id: string
  role: 'user'
  text: string
  images: ImageRef[]
  /** Unix ms. */
  at: number
}

export type AssistantStatus = 'streaming' | 'done' | 'stopped' | 'error'

export type AssistantMessage = {
  id: string
  role: 'assistant'
  text: string
  provider: Provider
  /** The model as the user picked it, e.g. "sonnet" or "gpt-5.5". Empty = the provider's default. */
  model: string
  status: AssistantStatus
  error?: string
  tools: ToolUse[]
  at: number
}

export type Message = UserMessage | AssistantMessage

export type Conversation = {
  id: string
  createdAt: number
  updatedAt: number
  /** The first user message, trimmed to a line. */
  title: string
  /** The provider the conversation last used. */
  provider: Provider
  messages: Message[]
}

export type ConversationSummary = {
  id: string
  createdAt: number
  updatedAt: number
  title: string
  provider: Provider
  count: number
}

export type ClaudeEffort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CodexEffort = '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type Settings = {
  /** A global-shortcut accelerator like "Cmd+Shift+Space", or null for none. */
  shortcut: string | null
  /** The provider new conversations start with. */
  provider: Provider
  /** "opus" | "sonnet" | "haiku" or a full model id. */
  claudeModel: string
  /** '' = Claude Code's default. */
  claudeEffort: ClaudeEffort
  /** '' = Codex's default. */
  codexModel: string
  codexEffort: CodexEffort
  webSearch: boolean
  /** Opening the panel after this many idle minutes starts a clean slate. 0 = never. */
  freshAfterMinutes: number
  /** Hide the panel when you click into another app (unless pinned). */
  hideOnBlur: boolean
  position: 'center' | 'right'
  /** Extra instructions added to the system prompt. */
  instructions: string
  /** The conversation's text size in px (12–20, default 15). The panel's own chrome stays the same. */
  textSize: number
}

export type ProviderStatus = { id: Provider; ready: boolean; detail: string }

export type ModelOption = { id: string; label: string; description?: string; isDefault?: boolean }

export type SettingsInfo = {
  settings: Settings
  /** Why the saved shortcut couldn't be registered, if it couldn't. */
  shortcutError: string | null
  providers: ProviderStatus[]
  /** Absolute paths. */
  transcriptsDir: string
  imagesDir: string
}

export type SendRequest = {
  /** null starts a new conversation. */
  conversationId: string | null
  text: string
  images: OutgoingImage[]
  provider: Provider
}

/** The user message as saved, and the empty assistant message that will stream into. */
export type SendResult = { conversationId: string; user: UserMessage; assistant: AssistantMessage }

/** `aside://stream` events, for one assistant message. `done` carries the final, saved message. */
export type StreamEvent = { conversationId: string; messageId: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool'; tool: ToolUse }
  | { kind: 'done'; message: AssistantMessage }
)

/** `aside://open`: the panel was just shown. `fresh` = it's been idle long enough to start a clean slate. */
export type OpenEvent = { fresh: boolean }
