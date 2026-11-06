// A fake backend for `pnpm dev` in a plain browser. `native.ts` loads this when Tauri isn't there.
// It behaves like the Rust side: same commands, same events, believable timing.

import type {
  AssistantMessage,
  Conversation,
  ConversationSummary,
  ModelOption,
  Provider,
  SendRequest,
  SendResult,
  Settings,
  SettingsInfo,
  StreamEvent,
  ToolUse,
  UserMessage,
} from './types'

// Events

type Handler = (payload: unknown) => void
const handlers = new Map<string, Set<Handler>>()

export function on(event: string, handler: Handler): () => void {
  let set = handlers.get(event)
  if (!set) handlers.set(event, (set = new Set()))
  set.add(handler)
  return () => set.delete(handler)
}

function emit(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(payload)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const rand = (min: number, max: number) => min + Math.random() * (max - min)

// Images: saved images are blob URLs, so `imageUrl(imagesDir, file)` = `blob:<origin>/<uuid>` loads them.

const imagesDir = `blob:${location.origin}`

function saveBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  return url.slice(imagesDir.length + 1)
}

function screenshotSvg() {
  const bars = [62, 88, 74, 120, 96, 142, 128, 168, 150, 186, 172, 210]
  const barSvg = bars
    .map((h, i) => `<rect x="${92 + i * 82}" y="${600 - h * 2}" width="46" height="${h * 2}" rx="6" fill="${i === 9 ? '#2f6fed' : '#c9d6f5'}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
  <rect width="1200" height="760" fill="#f6f6f4"/>
  <rect x="0" y="0" width="1200" height="64" fill="#ffffff"/>
  <circle cx="34" cy="32" r="7" fill="#ff5f57"/><circle cx="58" cy="32" r="7" fill="#febc2e"/><circle cx="82" cy="32" r="7" fill="#28c840"/>
  <text x="600" y="38" font-family="-apple-system,Helvetica" font-size="17" fill="#555" text-anchor="middle">Revenue — last 12 months</text>
  <rect x="48" y="96" width="1104" height="600" rx="16" fill="#ffffff" stroke="#e6e6e2"/>
  <text x="92" y="150" font-family="-apple-system,Helvetica" font-size="30" font-weight="600" fill="#1d1d1b">$184,920</text>
  <text x="92" y="182" font-family="-apple-system,Helvetica" font-size="16" fill="#1f883d">▲ 18.4% vs last year</text>
  <line x1="80" y1="600" x2="1120" y2="600" stroke="#e6e6e2" stroke-width="2"/>
  ${barSvg}
</svg>`
}

// Settings

let settings: Settings = {
  shortcut: 'Cmd+Shift+Space',
  provider: 'claude',
  claudeModel: 'sonnet',
  claudeEffort: '',
  codexModel: '',
  codexEffort: '',
  webSearch: true,
  freshAfterMinutes: 10,
  hideOnBlur: true,
  position: 'center',
  instructions: '',
  textSize: 15,
}

const info = (): SettingsInfo => ({
  settings: { ...settings },
  shortcutError: null,
  providers: [
    { id: 'claude', ready: true, detail: 'Claude Code 2.1.9 · signed in' },
    { id: 'codex', ready: true, detail: 'codex-cli 0.98.0 · ChatGPT login' },
  ],
  transcriptsDir: '/Users/you/Library/Application Support/com.kelvinamoaba.aside/conversations',
  imagesDir,
})

const codexModelList: ModelOption[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Flagship model for coding and reasoning', isDefault: true },
  { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini', description: 'Faster and cheaper' },
  { id: 'gpt-5.4-codex', label: 'GPT-5.4 Codex', description: 'Tuned for agentic coding' },
]

// Conversations

let seq = 0
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`

function conversationId(at: number) {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${hex}`
}

const conversations = new Map<string, Conversation>()

function user(text: string, at: number, images: UserMessage['images'] = []): UserMessage {
  return { id: id('u'), role: 'user', text, images, at }
}

function answer(text: string, at: number, provider: Provider, model: string, tools: ToolUse[] = []): AssistantMessage {
  return { id: id('a'), role: 'assistant', text, provider, model, status: 'done', tools, at }
}

function seed() {
  const now = Date.now()
  const minute = 60_000
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(16, 10, 0, 0)

  const file = saveBlob(new Blob([screenshotSvg()], { type: 'image/svg+xml' }))

  const list: Array<Omit<Conversation, 'id'>> = [
    {
      createdAt: now - 9 * 24 * 60 * minute,
      updatedAt: now - 9 * 24 * 60 * minute,
      title: 'SQLite WAL vs rollback journal',
      provider: 'claude',
      messages: [
        user('SQLite WAL vs rollback journal, which one should a desktop app use?', now - 9 * 24 * 60 * minute),
        answer(ANSWERS.sqlite, now - 9 * 24 * 60 * minute + 9000, 'claude', 'sonnet'),
      ],
    },
    {
      createdAt: now - 3 * 24 * 60 * minute,
      updatedAt: now - 3 * 24 * 60 * minute + 4 * minute,
      title: 'Regex for ISO dates',
      provider: 'codex',
      messages: [
        user('Write a regex for ISO 8601 dates', now - 3 * 24 * 60 * minute),
        answer(ANSWERS.regex, now - 3 * 24 * 60 * minute + 7000, 'codex', 'gpt-5.5'),
        user('Does it reject 2024-02-30?', now - 3 * 24 * 60 * minute + 3 * minute),
        answer(ANSWERS.regexFollowUp, now - 3 * 24 * 60 * minute + 3 * minute + 6000, 'codex', 'gpt-5.5'),
      ],
    },
    {
      createdAt: yesterday.getTime(),
      updatedAt: yesterday.getTime() + 12000,
      title: "What's the trend in this chart?",
      provider: 'claude',
      messages: [
        user("What's the trend in this chart?", yesterday.getTime(), [{ file, mime: 'image/svg+xml', width: 1200, height: 760 }]),
        answer(ANSWERS.chart, yesterday.getTime() + 12000, 'claude', 'sonnet'),
      ],
    },
    {
      createdAt: now - 25 * minute,
      updatedAt: now - 24 * minute,
      title: 'Center a div vertically in a flex container',
      provider: 'claude',
      messages: [
        user('How do I center a div vertically in a flex container?', now - 25 * minute),
        answer(ANSWERS.center, now - 24 * minute, 'claude', 'sonnet', [{ kind: 'search', label: 'css flexbox align-items center' }]),
      ],
    },
  ]
  for (const c of list) {
    const cid = conversationId(c.createdAt)
    conversations.set(cid, { ...c, id: cid })
  }
}

function summaries(): ConversationSummary[] {
  return [...conversations.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((c) => ({ id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, title: c.title, provider: c.provider, count: c.messages.length }))
}

// Streaming

const running = new Map<string, { timers: number[]; message: AssistantMessage; text: string; conversationId: string }>()

function streamEvent(event: StreamEvent) {
  emit('aside://stream', event)
}

function finish(conversationId: string, status: AssistantMessage['status'], error?: string) {
  const run = running.get(conversationId)
  if (!run) return
  for (const t of run.timers) clearTimeout(t)
  running.delete(conversationId)
  const message: AssistantMessage = { ...run.message, text: run.text, status, ...(error ? { error } : {}) }
  const conversation = conversations.get(conversationId)
  if (conversation) {
    conversation.messages = conversation.messages.map((m) => (m.id === message.id ? message : m))
    conversation.updatedAt = Date.now()
  }
  streamEvent({ conversationId, messageId: message.id, kind: 'done', message })
}

function startStream(conversationId: string, message: AssistantMessage, prompt: string) {
  const run = { timers: [] as number[], message, text: '', conversationId }
  running.set(conversationId, run)
  const at = (ms: number, fn: () => void) => run.timers.push(window.setTimeout(fn, ms))
  const base = { conversationId, messageId: message.id }

  const text = pickAnswer(prompt)
  const fails = /\berror\b|\bfail/i.test(prompt)
  let t = rand(180, 420)

  if (Math.random() < 0.65) {
    at(t, () => streamEvent({ ...base, kind: 'thinking' }))
    t += rand(500, 1100)
  }
  if (settings.webSearch && (Math.random() < 0.5 || /latest|news|search|today/i.test(prompt))) {
    const query = prompt.replace(/\s+/g, ' ').trim().slice(0, 48)
    const tool: ToolUse = { kind: 'search', label: query }
    at(t, () => {
      run.message = { ...run.message, tools: [...run.message.tools, tool] }
      streamEvent({ ...base, kind: 'tool', tool })
    })
    t += rand(700, 1400)
  }

  // Irregular chunks at irregular intervals, with the odd burst, like a real token stream over a pipe.
  // Long answers come in proportionally bigger chunks, as a fast model would send them.
  const end = fails ? Math.floor(text.length * 0.3) : text.length
  const scale = Math.max(1, text.length / 1800)
  let i = 0
  while (i < end) {
    const burst = Math.random() < 0.12
    const size = Math.ceil((burst ? rand(18, 60) : rand(1, 9)) * scale)
    const chunk = text.slice(i, Math.min(end, i + size))
    i += chunk.length
    at(t, () => {
      run.text += chunk
      streamEvent({ ...base, kind: 'text', text: chunk })
    })
    t += burst ? rand(2, 15) : rand(15, 120)
  }
  at(t + rand(60, 200), () =>
    fails
      ? finish(conversationId, 'error', 'Claude Code stopped unexpectedly (exit code 1). Check that you’re still signed in with `claude login`.')
      : finish(conversationId, 'done'),
  )
}

function pickAnswer(prompt: string) {
  const p = prompt.toLowerCase()
  if (/backoff/.test(p)) return ANSWERS.backoff
  if (/\blong\b|whole|full module|150/.test(p)) return ANSWERS.longTs
  if (/git|commit|undo/.test(p)) return ANSWERS.git
  if (/\bdiff\b|patch|change/.test(p)) return ANSWERS.diff
  if (/debounce|throttle/.test(p)) return ANSWERS.debounce
  if (/sql|database|table|compare/.test(p)) return ANSWERS.sqlite
  if (/python|script|file/.test(p)) return ANSWERS.python
  if (/regex|date/.test(p)) return ANSWERS.regex
  const pool = [ANSWERS.debounce, ANSWERS.git, ANSWERS.python]
  return pool[Math.floor(Math.random() * pool.length)]
}

async function send(request: SendRequest): Promise<SendResult> {
  await wait(rand(30, 70))
  const now = Date.now()
  let conversation = request.conversationId ? conversations.get(request.conversationId) : undefined
  if (!conversation) {
    const cid = conversationId(now)
    const title = (request.text.split('\n')[0] || 'Image').trim().slice(0, 80)
    conversation = { id: cid, createdAt: now, updatedAt: now, title, provider: request.provider, messages: [] }
    conversations.set(cid, conversation)
  }
  const images = await Promise.all(
    request.images.map(async (image) => {
      const blob = await (await fetch(`data:${image.mime};base64,${image.dataBase64}`)).blob()
      return { file: saveBlob(blob), mime: image.mime, width: image.width, height: image.height }
    }),
  )
  const model = request.provider === 'claude' ? settings.claudeModel : settings.codexModel
  const userMessage = user(request.text, now, images)
  const assistant: AssistantMessage = { id: id('a'), role: 'assistant', text: '', provider: request.provider, model, status: 'streaming', tools: [], at: now }
  conversation.messages.push(userMessage, assistant)
  conversation.provider = request.provider
  conversation.updatedAt = now
  startStream(conversation.id, assistant, request.text)
  return { conversationId: conversation.id, user: userMessage, assistant }
}

// Commands

export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(command, args)
  return result as T
}

async function dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case 'get_settings':
      await wait(20)
      return info()
    case 'set_settings': {
      await wait(rand(20, 60))
      const next = args.settings as Settings
      if (next.shortcut && !/(Cmd|Ctrl|Alt|Option|Command|Control|Super)/.test(next.shortcut) && !/F\d+$/.test(next.shortcut))
        throw 'A shortcut needs ⌘, ⌃ or ⌥.'
      if (next.shortcut === 'Cmd+Q' || next.shortcut === 'Cmd+Space')
        throw `${next.shortcut.replace('Cmd', '⌘').replace('+', '')} is already used by macOS.`
      settings = { ...next }
      return info()
    }
    case 'codex_models':
      await wait(rand(500, 900))
      return codexModelList
    case 'list_conversations':
      await wait(15)
      return summaries()
    case 'load_conversation': {
      await wait(rand(25, 70))
      const c = conversations.get(args.id as string)
      if (!c) throw 'Conversation not found.'
      return structuredClone(c)
    }
    case 'delete_conversation':
      conversations.delete(args.id as string)
      return null
    case 'send':
      return send(args.request as SendRequest)
    case 'stop':
      await wait(40)
      finish(args.conversationId as string, 'stopped')
      return null
    case 'warm':
    case 'set_pinned':
      return null
    case 'hide_panel':
      hidden = true
      return null
    case 'paste_image':
      return null
    case 'read_image':
      throw 'Reading files by path needs the app.'
    case 'reveal_transcripts':
      console.info('[mock] reveal', info().transcriptsDir)
      return null
    default:
      throw `Unknown command: ${command}`
  }
}

// Browser conveniences: open once on load, reopen with ⌃Space or a double-click, and a handle for scripts.

let hidden = true

function open(fresh = false) {
  hidden = false
  emit('aside://open', { fresh })
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.code === 'Space') {
    e.preventDefault()
    if (hidden) open(false)
    else emit('aside://close', null)
  }
})
window.addEventListener('dblclick', () => hidden && open(false))

declare global {
  interface Window {
    __aside?: { open: (fresh?: boolean) => void; close: () => void; settings: () => void }
  }
}
window.__aside = {
  open,
  close: () => emit('aside://close', null),
  settings: () => emit('aside://settings', null),
}

// Canned answers

const FENCE = '```'

/** A realistic ~150-line TypeScript module, for the long-code streaming case. */
function longModule() {
  const parts: string[] = [
    `/**`,
    ` * A small job queue with retries, backoff and cancellation.`,
    ` * Jobs run with bounded concurrency; failures retry with exponential backoff.`,
    ` */`,
    `import { EventEmitter } from 'node:events'`,
    ``,
    `export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'`,
    ``,
  ]
  const entities = ['Job', 'Batch', 'Upload', 'Report', 'Sync']
  for (const [i, name] of entities.entries()) {
    const lower = name.toLowerCase()
    parts.push(
      `export interface ${name}Options {`,
      `  /** How many times to try before giving up. */`,
      `  attempts?: number`,
      `  timeoutMs?: number`,
      `  signal?: AbortSignal`,
      `}`,
      ``,
      `export class ${name}Queue extends EventEmitter {`,
      `  private readonly pending = new Map<string, ${name}Options>()`,
      `  private running = 0`,
      ``,
      `  constructor(private readonly concurrency = ${i + 2}) {`,
      `    super()`,
      `  }`,
      ``,
      `  async add(id: string, run: () => Promise<void>, options: ${name}Options = {}): Promise<JobState> {`,
      `    const { attempts = 3, timeoutMs = 10_000, signal } = options`,
      `    this.pending.set(id, options)`,
      `    for (let attempt = 0; attempt < attempts; attempt++) {`,
      `      if (signal?.aborted) return 'cancelled'`,
      `      try {`,
      `        await withTimeout(run(), timeoutMs)`,
      `        this.emit('done', { id, attempt, kind: '${lower}' })`,
      `        return 'done'`,
      `      } catch (error) {`,
      `        /* Back off before the next try: 200ms, 400ms, 800ms…`,
      `           capped at five seconds so a stuck ${lower} can't stall the queue. */`,
      `        const delay = Math.min(5_000, 200 * 2 ** attempt)`,
      `        this.emit('retry', \`\${id} failed (\${String(error)}), retrying in \${delay}ms\`)`,
      `        await sleep(delay)`,
      `      }`,
      `    }`,
      `    return 'failed'`,
      `  }`,
      `}`,
      ``,
    )
  }
  parts.push(
    `const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))`,
    ``,
    `function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {`,
    `  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(\`timed out after \${ms}ms\`)))])`,
    `}`,
  )
  return parts.join('\n')
}

const ANSWERS = {
  backoff: `Add a small retry helper, then use it in \`fetchJson\`:

${FENCE}ts
async function retry<T>(run: () => Promise<T>) {
  for (let i = 0; ; i++) {
    try {
      return await run()
    } catch (error) {
      if (i === 3) throw error
      await sleep(200 * 2 ** i)
    }
  }
}
${FENCE}

${FENCE}diff
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,5 +1,5 @@
 export async function fetchJson(url: string) {
-  const res = await fetch(url)
+  const res = await retry(() => fetch(url))
   if (!res.ok) throw new Error(res.statusText)
   return res.json()
 }
${FENCE}`,

  longTs: `Here's the whole module. It keeps retries and backoff in one place, and each queue type shares the same shape:

${FENCE}ts
${longModule()}
${FENCE}

Every queue emits \`done\` and \`retry\`, so the UI can show progress without polling.`,

  diff: `Two small changes. First, retries now back off instead of hammering the server:

${FENCE}diff
diff --git a/src/lib/retry.ts b/src/lib/retry.ts
index 3f2a1c4..8b9e7d0 100644
--- a/src/lib/retry.ts
+++ b/src/lib/retry.ts
@@ -1,12 +1,17 @@
 export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
-  let lastError: unknown
-  for (let i = 0; i < attempts; i++) {
+  let lastError: unknown = null
+  for (let attempt = 0; attempt < attempts; attempt++) {
     try {
       return await fn()
     } catch (error) {
       lastError = error
+      // Back off: 200ms, 400ms, 800ms…
+      await sleep(200 * 2 ** attempt)
     }
   }
   throw lastError
 }
+
+const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
${FENCE}

The timeout now comes from the environment:

${FENCE}diff ts
-const timeout = 5000
+const timeout = Number(process.env.TIMEOUT ?? 5000)
${FENCE}

And the same fix in the Python fetcher, as a plain patch:

${FENCE}
--- a/scripts/fetch.py
+++ b/scripts/fetch.py
@@ -8,7 +8,9 @@ def fetch(url: str) -> bytes:
     for attempt in range(3):
         try:
-            return urlopen(url, timeout=5).read()
+            with urlopen(url, timeout=5) as response:
+                return response.read()
         except URLError as error:
             last = error
+            time.sleep(0.2 * 2 ** attempt)
     raise last
${FENCE}

Both keep the same signatures, so callers don't change.`,

  center: `Use \`align-items\` on the flex container. It aligns children on the cross axis, which is vertical for a row:

${FENCE}css
.container {
  display: flex;
  align-items: center;     /* vertical */
  justify-content: center; /* horizontal, if you want both */
  min-height: 100vh;
}
${FENCE}

The container needs a height for this to show. If it only wraps its content, there's no extra space to centre within. For a single child, \`margin: auto\` on the child does the same job in both directions.`,

  chart: `Revenue is climbing steadily. It's up **18.4%** year on year, and the last four months are the strongest of the period.

- The growth is uneven: there are small dips in months 3, 5 and 9, each followed by a higher high.
- Month 10 is highlighted and is the peak at roughly 186 on the chart's scale.
- The final two months ease off slightly, but stay well above the first half of the year.

If this is monthly revenue, the shape suggests seasonality on top of a healthy underlying trend. A 3-month moving average would make the trend easier to read than the raw bars.`,

  regex: `Here's a pattern for the common ISO 8601 forms: a date, optionally followed by a time and a zone.

${FENCE}regex
^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])(T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?(Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)?)?$
${FENCE}

It matches \`2024-06-01\`, \`2024-06-01T14:30\` and \`2024-06-01T14:30:05.123+02:00\`.`,

  regexFollowUp: `No. A regex only checks the shape, so \`2024-02-30\` passes. To reject impossible dates, parse it and compare:

${FENCE}ts
function isRealDate(s: string) {
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s)
}
${FENCE}

The round trip catches February 30th, because \`Date\` rolls it over to March 1st and the strings no longer match.`,

  sqlite: `For a desktop app, use **WAL**. Readers don't block the writer, and the writer doesn't block readers, which is what you want when the UI reads while a background task writes.

| | WAL | Rollback journal |
| --- | --- | --- |
| Concurrent reads during a write | Yes | No |
| Writes | Faster, mostly sequential | Slower, two writes per page |
| Files on disk | \`db\`, \`-wal\`, \`-shm\` | \`db\` and a temporary \`-journal\` |
| Network filesystems | Not supported | Works |

Turn it on once; it sticks to the database file:

${FENCE}sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
${FENCE}

The one catch: keep the database on a local disk. WAL relies on shared memory, so it isn't safe on a network share.`,

  debounce: `Here's the short version: **debounce** waits until input stops, while **throttle** lets a call through at most once per interval. For a search box you almost always want debounce.

A few things worth knowing:

- Debounce delays the *first* call too, unless you add a leading edge.
- Throttle keeps firing during continuous input, which suits scroll and resize handlers.
- Both need cleanup on unmount, or a stale timer can fire after the component is gone.

${FENCE}ts
export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
  debounced.cancel = () => clearTimeout(timer)
  return debounced
}
${FENCE}

In React, create it with \`useMemo\` so it survives re-renders, and call \`cancel()\` in the effect cleanup. See the [MDN page on timers](https://developer.mozilla.org/en-US/docs/Web/API/setTimeout) for the details.`,

  git: `### Undo the last commit, keep the changes

Use a soft reset. It moves the branch back one commit and leaves everything staged:

${FENCE}bash
git reset --soft HEAD~1
${FENCE}

1. **Not pushed yet?** The reset above is all you need.
2. **Already pushed?** Use \`git revert HEAD\` instead, so you don't rewrite history others have.
3. **Want the changes unstaged?** Use \`git reset HEAD~1\` (a mixed reset).

If you reset by mistake, \`git reflog\` lists where \`HEAD\` has been, and \`git reset --soft <sha>\` takes you back.`,

  python: `You can do this with the standard library alone. \`pathlib\` handles the walking and \`collections.Counter\` does the tally:

${FENCE}python
from collections import Counter
from pathlib import Path

def count_extensions(root: str) -> Counter[str]:
    counts: Counter[str] = Counter()
    for path in Path(root).rglob("*"):
        if path.is_file():
            counts[path.suffix.lower() or "(none)"] += 1
    return counts

for ext, n in count_extensions(".").most_common(10):
    print(f"{ext:>10}  {n}")
${FENCE}

- \`rglob("*")\` walks every subfolder.
- Hidden folders like \`.git\` are included, so filter on \`path.parts\` if you want to skip them.
- For very large trees, \`os.scandir\` is noticeably faster than \`pathlib\`.`,
}

seed()
setTimeout(() => open(false), 250)
