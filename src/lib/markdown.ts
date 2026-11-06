// Markdown for answers. Each top-level block renders on its own and finished blocks are cached by
// their source, so a streaming answer only re-renders its last, growing block.

import { Marked, type Token, type Tokens } from 'marked'
import { codeHtml, describeCode, escapeHtml } from './code'
import { prefetchTokens } from './highlight'

export { escapeHtml }

/** Whether nested code is rendered as still growing (no caching of its tokens). */
let nestedLive = false

const md = new Marked({ gfm: true, breaks: false, async: false })
md.use({
  renderer: {
    // Answers never carry live HTML.
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
    code: ({ text, lang }: Tokens.Code) => codeHtml(text, lang, nestedLive),
    image: ({ href, text }: Tokens.Image) => `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`,
  },
})

/** Top-level blocks, without the blank space between them. */
export function lex(text: string): Token[] {
  return md.lexer(text).filter((t) => t.type !== 'space' && t.type !== 'def')
}

/** Blocks that contain code look different once a grammar loads, so their cache entry is per version. */
export const hasCode = (raw: string) => /```|~~~|^ {4}\S/m.test(raw)

const cache = new Map<string, string>()
const CACHE_LIMIT = 600

export function blockHtml(token: Token, live: boolean, highlightVersion: number) {
  if (live) {
    nestedLive = true
    const html = md.parser([token])
    nestedLive = false
    return html
  }
  const key = hasCode(token.raw) ? `${highlightVersion}\u0000${token.raw}` : token.raw
  let html = cache.get(key)
  if (html === undefined) {
    html = md.parser([token])
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    cache.set(key, html)
  }
  return html
}

/** A fenced block whose closing fence has arrived. */
export const fenceClosed = (raw: string) => /\n {0,3}(`{3,}|~{3,})[ \t]*\n?$/.test(raw)

/** Starts colouring the code blocks in an answer before it's on screen. */
export function prefetchCode(markdown: string) {
  if (!hasCode(markdown)) return
  for (const token of md.lexer(markdown)) {
    if (token.type !== 'code') continue
    const desc = describeCode((token as Tokens.Code).text, (token as Tokens.Code).lang)
    if (desc.lang) prefetchTokens(desc.lang, desc.text)
  }
}
