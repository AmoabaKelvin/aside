// The page side of syntax highlighting. Tokenizing happens in a worker (see highlight.worker.ts), so a
// grammar compiling its regexes never costs a frame. Each code block asks for tokens under a key; at most
// one request per block is in flight, and the newest text wins. Replies carry only the lines that changed.
//
// What a block shows:
// - a language we don't highlight, or a grammar still loading: plain text, upgraded in place later;
// - otherwise only lines the worker has coloured, so streaming code never flashes from plain to colour.
//   The newest characters can trail the text by a frame; while a grammar is cold, a little longer.

import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import { CORE_LANGUAGES } from './highlight-langs'
import type { FromWorker, ToWorker, WireLine } from './highlight-protocol'

export { langForPath, langLabel, resolveLang } from './highlight-langs'
export type { WireLine } from './highlight-protocol'

/** null = render plain. Otherwise the coloured lines to show (possibly fewer than the text has). */
export type Tokens = { lines: WireLine[] } | null

let worker: Worker | null = null
let broken = false
const ready = new Set<string>()

function getWorker() {
  if (worker || broken) return worker
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<FromWorker>) => receive(event.data)
    worker.onerror = () => {
      // Highlighting is a nicety: without the worker everything stays plain.
      broken = true
      worker = null
      for (const [key, entry] of entries) settle(key, entry, { failed: true })
    }
  } catch {
    broken = true
  }
  return worker
}

const send = (message: ToWorker) => getWorker()?.postMessage(message)

/** Starts the worker and the common grammars in the background, so the first answer is already in colour. */
export function preloadHighlighting() {
  setTimeout(() => CORE_LANGUAGES.forEach((lang) => send({ t: 'load', lang })), 300)
}

// One entry per block.

type Entry = {
  lang: string
  /** The text `lines` cover. */
  got: string
  lines: WireLine[]
  failed: boolean
  inflight: boolean
  /** Text waiting to be sent when the in-flight reply arrives. */
  want: string | null
  /** The final text, once the block stops growing: its tokens are cached for good. */
  final: string | null
  view: { lines: WireLine[]; failed: boolean }
  subscribers: Set<() => void>
}

const entries = new Map<string, Entry>()
const ENTRY_LIMIT = 400

function entryFor(key: string, lang: string) {
  let entry = entries.get(key)
  if (!entry || entry.lang !== lang) {
    const subscribers = entry?.subscribers ?? new Set<() => void>()
    entry = { lang, got: '', lines: [], failed: false, inflight: false, want: null, final: null, view: { lines: [], failed: false }, subscribers }
    entries.set(key, entry)
    if (entries.size > ENTRY_LIMIT) {
      const oldest = entries.keys().next().value!
      if (!entries.get(oldest)?.subscribers.size) drop(oldest)
    }
  }
  return entry
}

/** Finished blocks' tokens, by language and text, so a block seen again is coloured at once. */
const finished = new Map<string, WireLine[]>()
const FINISHED_LIMIT = 300
const finishedKey = (lang: string, text: string) => `${lang}\u0000${text}`

function remember(lang: string, text: string, lines: WireLine[]) {
  if (finished.size >= FINISHED_LIMIT) finished.delete(finished.keys().next().value!)
  finished.set(finishedKey(lang, text), lines)
}

function request(key: string, lang: string, text: string, live: boolean) {
  if (broken || finished.has(finishedKey(lang, text))) return
  const entry = entryFor(key, lang)
  if (entry.failed) return
  if (!live) entry.final = text
  if (entry.got === text && !entry.inflight) {
    if (!live) remember(lang, text, entry.lines)
    return
  }
  if (entry.inflight) {
    entry.want = text
    return
  }
  entry.inflight = true
  entry.want = null
  send({ t: 'tok', key, lang, text })
}

function settle(key: string, entry: Entry, change: Partial<Entry>) {
  Object.assign(entry, change)
  entry.view = { lines: entry.lines, failed: entry.failed }
  for (const s of entry.subscribers) s()
  if (key.startsWith('nested:')) bump()
}

function receive(message: FromWorker) {
  if (message.t === 'ready') {
    ready.add(message.lang)
    return
  }
  const entry = entries.get(message.key)
  if (!entry || entry.lang !== message.lang) return
  if (message.t === 'fail') {
    settle(message.key, entry, { failed: true, inflight: false })
    return
  }
  const lines = entry.lines.slice(0, message.from).concat(message.lines)
  settle(message.key, entry, { lines, got: message.text, inflight: false })
  if (entry.final === message.text) remember(entry.lang, message.text, lines)
  if (entry.want !== null && entry.want !== entry.got) {
    const want = entry.want
    entry.want = null
    entry.inflight = true
    send({ t: 'tok', key: message.key, lang: entry.lang, text: want })
  }
}

function drop(key: string) {
  entries.delete(key)
  send({ t: 'drop', key })
}

/** What to show for `text` right now. */
function view(key: string, lang: string | null, text: string, live: boolean): Tokens {
  if (!lang || broken) return null
  const cached = finished.get(finishedKey(lang, text))
  if (cached) return { lines: cached }
  const entry = entries.get(key)
  if (entry && entry.lang === lang && !entry.failed && entry.got) {
    // The coloured part so far; marked may briefly trim a trailing newline, so `got` can be a bit longer.
    if (text.startsWith(entry.got) || entry.got.startsWith(text)) return { lines: entry.lines }
  }
  if (entry?.failed) return null
  // A ready grammar while streaming: wait a frame for colour rather than show plain text.
  if (live && ready.has(lang)) return { lines: [] }
  // A first look at a finished block, or a grammar still loading: plain, upgraded in place.
  return null
}

const noop = () => () => {}

/** Tokens for one code block. `key` is stable for the block's life on screen. */
export function useTokens(key: string, lang: string | null, text: string, live: boolean): Tokens {
  useSyncExternalStore(
    lang
      ? (listener) => {
          const entry = entryFor(key, lang)
          entry.subscribers.add(listener)
          return () => entry.subscribers.delete(listener)
        }
      : noop,
    () => (lang ? entries.get(key)?.view : undefined),
  )
  useLayoutEffect(() => {
    if (lang) request(key, lang, text, live)
  }, [key, lang, text, live])
  useEffect(() => () => drop(key), [key])
  return view(key, lang, text, live)
}

/** Colours a finished block ahead of time (a conversation about to be shown), so it never shows plain. */
export function prefetchTokens(lang: string, text: string) {
  request(`pre:${lang}:${text.length}:${text.slice(0, 64)}`, lang, text, false)
}

/** Tokens for code nested in a list or quote, rendered as HTML outside React. */
export function nestedTokens(lang: string | null, text: string, live: boolean): Tokens {
  if (!lang) return null
  // Stable while the block grows: its language and how it starts.
  const key = `nested:${lang}:${text.slice(0, 64)}`
  request(key, lang, text, live)
  return view(key, lang, text, live)
}

// A version that bumps when nested blocks get colour, so markdown re-renders the blocks with code.

let version = 0
let bumpQueued = false
const versionSubscribers = new Set<() => void>()

function bump() {
  if (bumpQueued) return
  bumpQueued = true
  requestAnimationFrame(() => {
    bumpQueued = false
    version++
    for (const s of versionSubscribers) s()
  })
}

export function useHighlightVersion() {
  return useSyncExternalStore(
    (s) => {
      versionSubscribers.add(s)
      return () => versionSubscribers.delete(s)
    },
    () => version,
  )
}
