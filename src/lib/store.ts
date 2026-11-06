// Conversations and live streams, kept outside React so a token never re-renders more than the one
// message it belongs to. Components subscribe by conversation id or by message id.

import { useSyncExternalStore } from 'react'
import * as native from './native'
import type { Attachment } from './images'
import { prefetchCode } from './markdown'
import type { AssistantMessage, Conversation, ConversationSummary, Provider, StreamEvent, ToolUse, UserMessage } from './types'

type Listener = () => void

function subscribeTo(map: Map<string, Set<Listener>>, key: string, listener: Listener) {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (!set.size) map.delete(key)
  }
}

function notify(map: Map<string, Set<Listener>>, key: string) {
  for (const listener of map.get(key) ?? []) listener()
}

const noop = () => () => {}

// Conversations

const conversations = new Map<string, Conversation>()
const conversationSubs = new Map<string, Set<Listener>>()
const loading = new Map<string, Promise<Conversation | undefined>>()

function putConversation(conversation: Conversation) {
  conversations.set(conversation.id, conversation)
  notify(conversationSubs, conversation.id)
}

export function getConversation(id: string) {
  return conversations.get(id)
}

/** Loads a conversation once and keeps it. Streams that ran while it wasn't loaded are already saved on disk. */
export function ensureConversation(id: string) {
  const cached = conversations.get(id)
  if (cached) return Promise.resolve(cached)
  let promise = loading.get(id)
  if (!promise) {
    promise = native
      .loadConversation(id)
      .then((conversation) => {
        // Colour its code now, so going there shows it coloured from the first frame.
        for (const m of conversation.messages) if (m.role === 'assistant' && m.text) prefetchCode(m.text)
        // A send may have touched it while it loaded; that copy is newer.
        if (!conversations.has(id)) putConversation(applyFinished(conversation))
        return conversations.get(id)
      })
      .catch(() => undefined)
      .finally(() => loading.delete(id))
    loading.set(id, promise)
  }
  return promise
}

export function useConversation(id: string | null) {
  return useSyncExternalStore(
    id ? (listener) => subscribeTo(conversationSubs, id, listener) : noop,
    () => (id ? conversations.get(id) : undefined),
  )
}

// Summaries (the history list, newest first)

let summaries: ConversationSummary[] = []
const summarySubs = new Set<Listener>()

function setSummaries(next: ConversationSummary[]) {
  summaries = next
  for (const listener of summarySubs) listener()
}

export function getSummaries() {
  return summaries
}

export async function refreshSummaries() {
  try {
    const list = await native.listConversations()
    // Keep a conversation that was just created but isn't on disk yet.
    const known = new Set(list.map((s) => s.id))
    setSummaries([...summaries.filter((s) => !known.has(s.id) && s.createdAt > (list[0]?.createdAt ?? 0)), ...list])
  } catch {
    // Keep what we have.
  }
}

/** Drops a deleted conversation from the cache and the history list. */
export function removeConversation(id: string) {
  conversations.delete(id)
  notify(conversationSubs, id)
  setSummaries(summaries.filter((s) => s.id !== id))
}

export function useSummaries() {
  return useSyncExternalStore(
    (listener) => {
      summarySubs.add(listener)
      return () => summarySubs.delete(listener)
    },
    () => summaries,
  )
}

// Live streams

export type Live = { text: string; thinking: boolean; tools: ToolUse[] }

const live = new Map<string, Live>()
const liveSubs = new Map<string, Set<Listener>>()
const buffered = new Map<string, string>()
/** `done` that arrived before `send` returned its messages. */
const finished = new Map<string, AssistantMessage>()
let frame = 0

const emptyLive: Live = { text: '', thinking: false, tools: [] }

function updateLive(messageId: string, change: (current: Live) => Live) {
  live.set(messageId, change(live.get(messageId) ?? emptyLive))
  notify(liveSubs, messageId)
}

/** Text deltas are buffered and applied once per frame, however many arrive in between. */
function flush() {
  frame = 0
  const pending = [...buffered]
  buffered.clear()
  for (const [messageId, text] of pending) updateLive(messageId, (l) => ({ ...l, text: l.text + text }))
}

export function useLive(messageId: string | null) {
  return useSyncExternalStore(
    messageId ? (listener) => subscribeTo(liveSubs, messageId, listener) : noop,
    () => (messageId ? live.get(messageId) : undefined),
  )
}

function applyFinished(conversation: Conversation): Conversation {
  if (!finished.size) return conversation
  let changed = false
  const messages = conversation.messages.map((m) => {
    const done = finished.get(m.id)
    if (!done) return m
    finished.delete(m.id)
    changed = true
    return done
  })
  return changed ? { ...conversation, messages } : conversation
}

function finish(conversationId: string, message: AssistantMessage) {
  if (frame) {
    cancelAnimationFrame(frame)
    flush()
  }
  const conversation = conversations.get(conversationId)
  if (conversation?.messages.some((m) => m.id === message.id)) {
    putConversation({
      ...conversation,
      updatedAt: Math.max(conversation.updatedAt, message.at),
      messages: conversation.messages.map((m) => (m.id === message.id ? message : m)),
    })
  } else {
    finished.set(message.id, message)
  }
  live.delete(message.id)
  notify(liveSubs, message.id)
}

export function handleStream(event: StreamEvent) {
  const { messageId } = event
  switch (event.kind) {
    case 'text':
      buffered.set(messageId, (buffered.get(messageId) ?? '') + event.text)
      if (!frame) frame = requestAnimationFrame(flush)
      break
    case 'thinking':
      if (!live.get(messageId)?.thinking) updateLive(messageId, (l) => ({ ...l, thinking: true }))
      break
    case 'tool':
      updateLive(messageId, (l) => ({ ...l, tools: [...l.tools, event.tool] }))
      break
    case 'done':
      finish(event.conversationId, event.message)
      break
  }
}

// Whether a conversation has an answer streaming, for the send/stop button.

/** Answering, or about to: a question that hasn't got its answer message yet counts too. */
function isStreaming(conversation: Conversation | undefined) {
  const last = conversation?.messages.at(-1)
  if (!last) return false
  return last.role === 'user' ? last.id.startsWith('local-') : last.status === 'streaming'
}

export function useStreaming(id: string | null) {
  const conversation = useConversation(id)
  return isStreaming(conversation)
}

// Sending

let localSeq = 0
/** Saved image files that came from this session's attachments, shown from memory so they never flicker. */
const localImages = new Map<string, string>()

export function imageSrc(imagesDir: string, file: string) {
  if (file.startsWith('blob:') || file.startsWith('data:')) return file
  return localImages.get(file) ?? native.imageUrl(imagesDir, file)
}

/** A key for a conversation that exists only on screen until `send` returns its real id. */
export const isDraftId = (id: string) => id.startsWith('draft:')

/**
 * Shows the question at once, then sends it. Returns the conversation's real id.
 * `onCreated` runs when a new conversation gets its real id, before anything else renders it.
 */
export async function sendMessage(options: {
  conversationId: string | null
  text: string
  attachments: Attachment[]
  provider: Provider
  /** Runs at once with the key the conversation is shown under (a draft key for a new one). */
  onStart: (key: string) => void
  onCreated: (draftId: string, realId: string) => void
}) {
  const { conversationId, text, attachments, provider } = options
  const n = ++localSeq
  const userId = `local-${n}`
  const now = Date.now()
  const key = conversationId ?? `draft:${n}`

  const optimistic: UserMessage = {
    id: userId,
    role: 'user',
    text,
    images: attachments.map((a) => ({ file: a.url, mime: a.out.mime, width: a.out.width, height: a.out.height })),
    at: now,
  }
  const existing = conversations.get(key)
  putConversation(
    existing
      ? { ...existing, messages: [...existing.messages, optimistic] }
      : { id: key, createdAt: now, updatedAt: now, title: text.split('\n')[0].slice(0, 80) || 'Image', provider, messages: [optimistic] },
  )
  options.onStart(key)

  try {
    const result = await native.send({ conversationId, text, images: attachments.map((a) => a.out), provider })
    result.user.images.forEach((image, i) => attachments[i] && localImages.set(image.file, attachments[i].url))
    // Keep the optimistic id so the bubble isn't remounted.
    const userMessage: UserMessage = { ...result.user, id: userId }
    const assistant = finished.get(result.assistant.id) ?? result.assistant
    finished.delete(result.assistant.id)

    const current = conversations.get(key)!
    const next: Conversation = {
      ...current,
      id: result.conversationId,
      provider,
      updatedAt: Date.now(),
      messages: [...current.messages.map((m) => (m.id === userId ? userMessage : m)), assistant],
    }
    if (key !== result.conversationId) {
      conversations.delete(key)
      conversations.set(result.conversationId, next)
      setSummaries([
        { id: next.id, createdAt: next.createdAt, updatedAt: next.updatedAt, title: next.title, provider, count: next.messages.length },
        ...summaries.filter((s) => s.id !== next.id),
      ])
      options.onCreated(key, result.conversationId)
      notify(conversationSubs, result.conversationId)
    } else {
      putConversation(next)
      setSummaries(summaries.map((s) => (s.id === next.id ? { ...s, provider, updatedAt: next.updatedAt, count: next.messages.length } : s)))
    }
    return result.conversationId
  } catch (error) {
    const current = conversations.get(key)!
    const failed: AssistantMessage = {
      id: `local-error-${n}`,
      role: 'assistant',
      text: '',
      provider,
      model: '',
      status: 'error',
      error: errorText(error),
      tools: [],
      at: Date.now(),
    }
    putConversation({ ...current, messages: [...current.messages, failed] })
    return key
  }
}

export function errorText(error: unknown) {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

/** The last finished answer in a conversation, for ⌘⇧C. */
export function lastAnswer(id: string | null) {
  const conversation = id ? conversations.get(id) : undefined
  if (!conversation) return ''
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const m = conversation.messages[i]
    if (m.role === 'assistant' && m.text) return m.text
  }
  return ''
}

export function streamingIn(id: string | null) {
  return id ? isStreaming(conversations.get(id)) : false
}
