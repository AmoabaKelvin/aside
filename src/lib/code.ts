// What a code block shows, line by line: highlighted code, or a diff with +/− gutters and line
// backgrounds. Used by the React `CodeBlock` and by code nested inside lists (rendered as HTML).

import { langForPath, langLabel, nestedTokens, resolveLang, type Tokens, type WireLine } from './highlight'

export type RowKind = 'add' | 'del' | 'ctx' | 'hunk' | 'file' | 'meta'
export type Row = { kind?: RowKind; html: string }

type DiffRow = { kind: RowKind; text: string }

/** Everything about a block that doesn't depend on tokens. `text` is what gets highlighted. */
export type CodeDescription = { label: string; lang: string | null; text: string } & ({ diff: false } | { diff: true; rows: DiffRow[] })

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const lineHtmlCache = new WeakMap<WireLine, string>()

/** One line's tokens as HTML. Each token carries its light and dark colour; CSS picks one. */
function lineHtml(tokens: WireLine) {
  let html = lineHtmlCache.get(tokens)
  if (html !== undefined) return html
  html = ''
  for (const [content, light, dark] of tokens) {
    html += light ? `<span style="--l:${light};--d:${dark || light}">${escapeHtml(content)}</span>` : escapeHtml(content)
  }
  lineHtmlCache.set(tokens, html)
  return html
}

// Diffs

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

/** A unified diff in a block with no language. */
export function looksLikeDiff(code: string) {
  if (/^diff --git /m.test(code)) return true
  const lines = code.split('\n')
  if (!lines.some((l) => HUNK.test(l))) return /^--- .+\n\+\+\+ .+/m.test(code)
  return lines.some((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
}

const HEADER_NOISE = /^(index |new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|old mode|new mode)/

const cleanPath = (p: string) => p.replace(/^[ab]\//, '').replace(/\t.*$/, '').trim()

function parseDiff(code: string): DiffRow[] {
  const lines = code.split('\n')
  const rows: DiffRow[] = []
  let inHunk = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const next = lines[i + 1] ?? ''
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line)
      rows.push({ kind: 'file', text: m ? m[1] : line.slice(11) })
      inHunk = false
      continue
    }
    if (!inHunk && HEADER_NOISE.test(line)) continue
    if (line.startsWith('--- ') && next.startsWith('+++ ') && (!inHunk || HUNK.test(lines[i + 2] ?? ''))) {
      const to = cleanPath(next.slice(4))
      const path = to === '/dev/null' ? cleanPath(line.slice(4)) : to
      if (rows.at(-1)?.kind !== 'file') rows.push({ kind: 'file', text: path })
      inHunk = false
      i++
      continue
    }
    if (HUNK.test(line)) {
      rows.push({ kind: 'hunk', text: line })
      inHunk = true
      continue
    }
    const c = line[0]
    if (c === '+') rows.push({ kind: 'add', text: line.slice(1) })
    else if (c === '-') rows.push({ kind: 'del', text: line.slice(1) })
    else if (c === ' ') rows.push({ kind: 'ctx', text: line.slice(1) })
    else if (c === '\\') rows.push({ kind: 'meta', text: line })
    else rows.push({ kind: 'ctx', text: line })
  }
  return rows
}

const isContent = (r: DiffRow) => r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx'

/** `info` is the fence's info string: "ts", "diff", "diff ts", or empty. */
export function describeCode(code: string, info: string | undefined): CodeDescription {
  const words = (info ?? '').trim().split(/\s+/)
  const first = words[0]?.toLowerCase() ?? ''
  if (resolveLang(first) === 'diff' || (!first && looksLikeDiff(code))) {
    const rows = parseDiff(code)
    const firstFile = rows.find((r) => r.kind === 'file')?.text
    // The code inside is highlighted too: language from "diff ts", else the first file's extension.
    const lang = resolveLang(words[1]) ?? (firstFile ? langForPath(firstFile) : null)
    // As one stream, in order, so the grammar keeps its state across lines.
    const text = rows.filter(isContent).map((r) => r.text).join('\n')
    return { label: 'Diff', diff: true, rows, lang, text }
  }
  return { label: langLabel(first), diff: false, lang: resolveLang(first), text: code }
}

const FILE_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 1.75h5.25L12.5 5v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z"/><path d="M9 1.75V5h3.5"/></svg>'

const GUTTER: Partial<Record<RowKind, string>> = { add: '+', del: '−', ctx: ' ' }

/**
 * The rows to show. With tokens, only lines that have them: streaming code is never shown uncoloured,
 * it just trails by a frame. Without (plain), every line.
 */
export function codeRows(desc: CodeDescription, tokens: Tokens): Row[] {
  const lines = desc.text.split('\n')
  if (!desc.diff) {
    if (!tokens) return lines.map((line) => ({ html: escapeHtml(line) }))
    // The worker may cover a newline that marked has just trimmed: never show more lines than the text has.
    return tokens.lines.slice(0, lines.length).map((t) => ({ html: lineHtml(t) }))
  }
  const rows: Row[] = []
  let n = 0
  for (const r of desc.rows) {
    if (r.kind === 'file') rows.push({ kind: 'file', html: `${FILE_ICON}<span>${escapeHtml(r.text)}</span>` })
    else if (r.kind === 'hunk' || r.kind === 'meta') rows.push({ kind: r.kind, html: escapeHtml(r.text) })
    else {
      const t = tokens?.lines[n]
      if (tokens && !t) break
      rows.push({ kind: r.kind, html: `<span class="g">${GUTTER[r.kind]}</span>${t ? lineHtml(t) : escapeHtml(r.text)}` })
      n++
    }
  }
  return rows
}

const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="2"/><path d="M10.75 3.25A1.5 1.5 0 0 0 9.25 2H4a2 2 0 0 0-2 2v5.25a1.5 1.5 0 0 0 1.25 1.48"/></svg>'

/** The same markup as `CodeBlock`, for code inside lists and quotes. The raw code rides along for Copy. */
export function codeHtml(code: string, info: string | undefined, live: boolean) {
  const desc = describeCode(code, info)
  const rows = codeRows(desc, nestedTokens(desc.lang, desc.text, live))
    .map((r) => `<span class="line"${r.kind ? ` data-kind="${r.kind}"` : ''}>${r.html}</span>`)
    .join('')
  return `<div class="code"${desc.diff ? ' data-diff' : ''}><div class="code-head"><span class="code-lang">${escapeHtml(desc.label)}</span><button class="code-copy" type="button" data-copy>${COPY_ICON}<span>Copy</span></button></div><pre><code>${rows}</code></pre><template data-raw>${escapeHtml(code)}</template></div>`
}
