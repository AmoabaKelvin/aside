import { memo, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import { codeRows, describeCode } from '../lib/code'
import { useHighlightVersion, useTokens } from '../lib/highlight'
import { blockHtml, fenceClosed, hasCode, lex } from '../lib/markdown'
import { copyText, openLink } from '../lib/platform'
import type { Token, Tokens } from 'marked'
import { CheckIcon, CopyIcon } from './Icons'

/** While streaming, a fence that's still being typed ("`", "``", "```ts") waits until its first line. */
const PARTIAL_FENCE = /(^|\n) {0,3}(`{1,3}|~{1,3})[\w+#.-]*$/

/**
 * An answer's markdown. `live` = the text is still growing: only the last block re-renders. Code is
 * highlighted as it streams, a line at a time.
 */
export const Markdown = memo(function Markdown({ text, live }: { text: string; live: boolean }) {
  const tokens = useMemo(() => lex(live ? text.replace(PARTIAL_FENCE, '$1') : text), [text, live])
  // Bumps when a grammar finishes loading; only blocks with code re-render for it.
  const version = useHighlightVersion()
  const last = tokens.length - 1
  return (
    <div className="prose" onClick={onProseClick}>
      {tokens.map((token, i) => (
        <Block key={i} token={token} version={version} live={live && i === last && !(token.type === 'code' && fenceClosed(token.raw))} />
      ))}
    </div>
  )
})

const Block = memo(
  function Block({ token, live, version }: { token: Token; live: boolean; version: number }) {
    if (token.type === 'code') {
      const code = token as Tokens.Code
      // Until the fence line ends, the info string may still be half typed.
      const info = live && !code.raw.includes('\n') ? '' : code.lang
      return <CodeBlock code={code.text} info={info} live={live} />
    }
    const kind = token.type === 'heading' ? `md-block md-h${(token as Tokens.Heading).depth}` : `md-block md-${token.type}`
    return <div className={kind} dangerouslySetInnerHTML={{ __html: blockHtml(token, live, version) }} />
  },
  (a, b) => a.token.raw === b.token.raw && a.live === b.live && (a.version === b.version || !hasCode(a.token.raw)),
)

export function CodeBlock({ code, info, live }: { code: string; info: string | undefined; live: boolean }) {
  const [copied, setCopied] = useState(false)
  const key = useId()
  const desc = useMemo(() => describeCode(code, info), [code, info])
  // Colour comes from the highlighting worker; this re-renders when it answers.
  const tokens = useTokens(key, desc.lang, desc.text, live)
  const rows = codeRows(desc, tokens)
  const pre = useOverflowMark()

  async function copy() {
    if (await copyText(code)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }

  return (
    <div className="md-block code" data-diff={desc.diff || undefined}>
      <div className="code-head">
        <span className="code-lang">{desc.label}</span>
        <button className="code-copy" type="button" onClick={copy} onMouseDown={(e) => e.preventDefault()} data-copied={copied || undefined}>
          <span className="swap">
            <CopyIcon size={13} className="swap-a" />
            <CheckIcon size={13} className="swap-b" />
          </span>
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre ref={pre}>
        <code>
          {rows.map((row, i) => (
            <CodeLine key={i} kind={row.kind} html={row.html} />
          ))}
        </code>
      </pre>
    </div>
  )
}

/**
 * Marks a block whose lines scroll sideways, so its bottom padding makes room for the scrollbar instead
 * of adding to it. Watched with a ResizeObserver (content, text size), never read per render.
 */
function useOverflowMark() {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const pre = ref.current
    const code = pre?.firstElementChild
    if (!pre || !code) return
    const pending = { frame: 0 }
    // Applied on the next frame and only on a change: the mark changes the padding, which resizes what
    // is being observed, and doing that inside the callback would loop.
    const check = () => {
      cancelAnimationFrame(pending.frame)
      pending.frame = requestAnimationFrame(() => {
        const overflow = pre.scrollWidth > pre.clientWidth + 1
        if (overflow !== pre.hasAttribute('data-overflow')) pre.toggleAttribute('data-overflow', overflow)
      })
    }
    const observer = new ResizeObserver(check)
    observer.observe(pre)
    observer.observe(code)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(pending.frame)
    }
  }, [])
  return ref
}

/** One line. Finished lines keep the same HTML string, so only the growing last line re-renders. */
const CodeLine = memo(function CodeLine({ kind, html }: { kind?: string; html: string }) {
  return <span className="line" data-kind={kind} dangerouslySetInnerHTML={{ __html: html }} />
})

/** Links open in the browser; copy buttons inside nested code blocks copy their block. */
function onProseClick(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement
  const link = target.closest('a')
  if (link) {
    event.preventDefault()
    const href = link.getAttribute('href')
    if (href) openLink(href)
    return
  }
  const copy = target.closest<HTMLButtonElement>('[data-copy]')
  if (copy) {
    // The raw code (a diff keeps its +/- and headers), not the rendered rows.
    const code = copy.closest('.code')?.querySelector<HTMLTemplateElement>('template[data-raw]')?.content.textContent ?? ''
    copyText(code).then((ok) => {
      if (!ok) return
      copy.dataset.copied = 'true'
      const label = copy.querySelector('span')
      if (label) label.textContent = 'Copied'
      setTimeout(() => {
        delete copy.dataset.copied
        if (label) label.textContent = 'Copy'
      }, 1400)
    })
  }
}
