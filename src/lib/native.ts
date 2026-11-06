// Every call into the Rust side, and every event out of it. Outside the app (plain `pnpm dev` in a
// browser) these fall back to `mock.ts`, so the UI can be worked on without Tauri.

import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  Conversation,
  ConversationSummary,
  ModelOption,
  OpenEvent,
  RawImage,
  SendRequest,
  SendResult,
  Settings,
  SettingsInfo,
  StreamEvent,
} from './types'

export const isNative = '__TAURI_INTERNALS__' in window

type Mock = typeof import('./mock')
let mockModule: Promise<Mock> | null = null
const mock = () => (mockModule ??= import('./mock'))

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isNative) return invoke<T>(command, args)
  return (await mock()).call<T>(command, args)
}

function on<T>(event: string, handle: (payload: T) => void): () => void {
  if (!isNative) {
    let stop = () => {}
    let stopped = false
    mock().then((m) => {
      if (!stopped) stop = m.on(event, handle as (payload: unknown) => void)
    })
    return () => {
      stopped = true
      stop()
    }
  }
  const stop = listen<T>(event, (e) => handle(e.payload))
  return () => {
    stop.then((unlisten) => unlisten())
  }
}

// Commands

export const getSettings = () => call<SettingsInfo>('get_settings')
/** Rejects with a message (and keeps the old shortcut) if the new shortcut can't be registered. */
export const setSettings = (settings: Settings) => call<SettingsInfo>('set_settings', { settings })
/** Codex's model list, from the CLI. Can take a few seconds the first time. */
export const codexModels = () => call<ModelOption[]>('codex_models')

/** Newest first, by creation time. */
export const listConversations = () => call<ConversationSummary[]>('list_conversations')
export const loadConversation = (id: string) => call<Conversation>('load_conversation', { id })
export const deleteConversation = (id: string) => call<void>('delete_conversation', { id })

/** Saves the user message, then streams the answer as `aside://stream` events. */
export const send = (request: SendRequest) => call<SendResult>('send', { request })
export const stop = (conversationId: string) => call<void>('stop', { conversationId })
/** Starts the provider's process ahead of time so the first answer comes quicker. */
export const warm = (provider: SendRequest['provider']) => call<void>('warm', { provider })

/** Call after the closing animation finishes. */
export const hidePanel = () => call<void>('hide_panel')
/** While pinned the panel stays up when you click into another app. */
export const setPinned = (pinned: boolean) => call<void>('set_pinned', { pinned })

/** The image on the clipboard, if there is one (e.g. a screenshot copied with ⌃⇧⌘4). */
export const pasteImage = () => call<RawImage | null>('paste_image')
/** A dropped or picked image file. */
export const readImage = (path: string) => call<RawImage>('read_image', { path })

export const revealTranscripts = () => call<void>('reveal_transcripts')

/** A URL the webview can load for a saved image. */
export function imageUrl(imagesDir: string, file: string) {
  return isNative ? convertFileSrc(`${imagesDir}/${file}`) : `${imagesDir}/${file}`
}

// Events

/** The panel was shown (shortcut or menu bar). */
export const onOpen = (handle: (event: OpenEvent) => void) => on<OpenEvent>('aside://open', handle)
/** The panel should go away: it lost focus, or the shortcut was pressed again. Animate out, then `hidePanel()`. */
export const onClose = (handle: () => void) => on<null>('aside://close', () => handle())
/** The menu bar's Settings… item. Arrives right after `aside://open`. */
export const onOpenSettings = (handle: () => void) => on<null>('aside://settings', () => handle())
export const onStream = (handle: (event: StreamEvent) => void) => on<StreamEvent>('aside://stream', handle)
/** Files dragged onto the panel. Tauri's own drag-drop event, already resolved to paths. */
export function onDropPaths(handle: (paths: string[]) => void, hover?: (over: boolean) => void) {
  if (!isNative) return () => {}
  let unlisten: (() => void) | null = null
  let stopped = false
  import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'enter' || p.type === 'over') hover?.(true)
        else if (p.type === 'leave') hover?.(false)
        else if (p.type === 'drop') {
          hover?.(false)
          handle(p.paths)
        }
      })
      .then((u) => (stopped ? u() : (unlisten = u))),
  )
  return () => {
    stopped = true
    unlisten?.()
  }
}
