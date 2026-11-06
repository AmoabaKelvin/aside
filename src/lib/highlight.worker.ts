// The highlighting worker: Shiki (TextMate grammars on the JavaScript regex engine) off the main thread.
// A grammar costs tens of milliseconds, sometimes over 100, the first time each construct is tokenized,
// while JavaScriptCore compiles its regexes. Here that never costs a frame.
//
// Each block has a tokenizer that works a line at a time: finished lines keep their tokens and the
// grammar state after them, so each update tokenizes only what's new. Replies carry only the lines that
// changed since the last reply for that block.

import { createHighlighterCore, type GrammarState, type HighlighterCore, type LanguageRegistration } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { FromWorker, ToWorker, WireLine } from './highlight-protocol'

type Loader = () => Promise<{ default: LanguageRegistration[] }>

const LOADERS: Record<string, Loader> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  nix: () => import('shiki/langs/nix.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  nginx: () => import('shiki/langs/nginx.mjs'),
  regexp: () => import('shiki/langs/regexp.mjs'),
}

const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const

let booting: Promise<HighlighterCore> | null = null
const loading = new Map<string, Promise<boolean>>()

function boot() {
  booting ??= Promise.all([import('shiki/themes/github-light-default.mjs'), import('shiki/themes/github-dark-default.mjs')]).then(([light, dark]) =>
    createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }),
  )
  booting.catch(() => {
    booting = null
  })
  return booting
}

const post = (message: FromWorker) => postMessage(message)

/** Resolves true once the grammar is loaded (and announced), false if it can't be. */
function load(lang: string) {
  let promise = loading.get(lang)
  if (!promise) {
    const loader = LOADERS[lang]
    promise = loader
      ? boot()
          .then(async (h) => {
            await h.loadLanguage(...(await loader()).default)
            post({ t: 'ready', lang })
            warm(lang)
            return true
          })
          .catch(() => {
            loading.delete(lang)
            return false
          })
      : Promise.resolve(false)
    loading.set(lang, promise)
  }
  return promise
}

function tokenizeRaw(h: HighlighterCore, code: string, lang: string, grammarState?: GrammarState) {
  return h.codeToTokens(code, { lang, themes: THEMES, defaultColor: false, grammarState, tokenizeMaxLineLength: 2000 })
}

function wire(lines: ReturnType<typeof tokenizeRaw>['tokens']): WireLine[] {
  return lines.map((line) =>
    line.map((t) => {
      const style = t.htmlStyle as Record<string, string> | undefined
      return [t.content, style?.['--shiki-light'] ?? '', style?.['--shiki-dark'] ?? ''] as [string, string, string]
    }),
  )
}

/** Tokenizes a growing text a line at a time, keeping finished lines and the grammar state after them. */
class LineTokenizer {
  done = ''
  lines: WireLine[] = []
  state: GrammarState | undefined
  /** Finished lines already sent to the page. */
  sent = 0
  readonly lang: string

  constructor(lang: string) {
    this.lang = lang
  }

  update(h: HighlighterCore, code: string): { from: number; lines: WireLine[] } {
    if (!code.startsWith(this.done)) {
      // marked drops a trailing newline, so between a line ending and the next character the text is
      // briefly a line-boundary prefix of what's done: nothing new to send.
      if (this.done.startsWith(code) && this.done[code.length] === '\n') return { from: this.sent, lines: [] }
      this.done = ''
      this.lines = []
      this.state = undefined
      this.sent = 0
    }
    const rest = code.slice(this.done.length)
    const nl = rest.lastIndexOf('\n')
    if (nl >= 0) {
      const finished = rest.slice(0, nl)
      const result = tokenizeRaw(h, finished, this.lang, this.state)
      this.lines.push(...wire(result.tokens))
      this.state = result.grammarState
      this.done += finished + '\n'
    }
    const tail = rest.slice(nl + 1)
    // The last line may still be growing: tokenize it from the saved state, but don't keep it.
    const tailLine = tail ? (wire(tokenizeRaw(h, tail, this.lang, this.state).tokens)[0] ?? []) : []
    const from = this.sent
    this.sent = this.lines.length
    return { from, lines: [...this.lines.slice(from), tailLine] }
  }
}

const tokenizers = new Map<string, LineTokenizer>()

async function tokenize(key: string, lang: string, text: string) {
  try {
    if (!(await load(lang))) throw new Error('no grammar')
    const h = await boot()
    let tokenizer = tokenizers.get(key)
    if (!tokenizer || tokenizer.lang !== lang) tokenizers.set(key, (tokenizer = new LineTokenizer(lang)))
    const { from, lines } = tokenizer.update(h, text)
    post({ t: 'tok', key, lang, text, from, lines })
  } catch {
    // Always answer, so the page never waits on this block.
    tokenizers.delete(key)
    post({ t: 'fail', key, lang })
  }
}

// Warming: once a grammar loads, run a realistic sample through it, twice, line by line, in slices
// between requests, so the first answer in that language doesn't wait on regex compilation.

const warmQueue: string[] = []
let warming = false
let samples: Promise<Record<string, string>> | null = null

function warm(lang: string) {
  warmQueue.push(lang)
  if (warming) return
  warming = true
  samples ??= import('./highlight-samples').then((m) => m.SAMPLES)
  Promise.all([samples, boot()]).then(([all, h]) => {
    const jobs: Array<{ lang: string; lines: string[] }> = []
    const next = () => {
      while (warmQueue.length) {
        const id = warmQueue.shift()!
        const sample = all[id]
        if (sample) for (let pass = 0; pass < 2; pass++) jobs.push({ lang: id, lines: sample.split('\n') })
      }
      return jobs[0]
    }
    let state: GrammarState | undefined
    let line = 0
    const slice = () => {
      const started = performance.now()
      let job = next()
      while (job && performance.now() - started < 8) {
        try {
          state = tokenizeRaw(h, job.lines[line], job.lang, state).grammarState
        } catch {
          line = job.lines.length
        }
        if (++line >= job.lines.length) {
          jobs.shift()
          state = undefined
          line = 0
          job = next()
        }
      }
      // Yield so real requests go first.
      if (job) setTimeout(slice, 0)
      else warming = false
    }
    setTimeout(slice, 0)
  })
}

onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data
  if (message.t === 'load') load(message.lang)
  else if (message.t === 'tok') tokenize(message.key, message.lang, message.text)
  else if (message.t === 'drop') tokenizers.delete(message.key)
}
