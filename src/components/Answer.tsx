import { memo, useEffect, useRef, useState } from 'react'
import { copyText, reducedMotion } from '../lib/platform'
import { useLive } from '../lib/store'
import type { AssistantMessage, ToolUse } from '../lib/types'
import { AlertIcon, CheckIcon, CopyIcon, GlobeIcon, SearchIcon } from './Icons'
import { Markdown } from './Markdown'

/**
 * Text arrives in bursts. Rather than jumping by each burst, the shown text drains the backlog over a
 * few frames: a big burst moves quickly, a trickle moves a character or so per frame. When the answer
 * is done it catches up within a couple of frames.
 */
function useReveal(target: string, streaming: boolean) {
  // Text that's already there when this mounts (e.g. coming back to a conversation) shows at once.
  const [shown, setShown] = useState(target.length)
  const shownRef = useRef(target.length)
  const targetRef = useRef(target)
  const streamingRef = useRef(streaming)
  const frame = useRef(0)

  useEffect(() => {
    targetRef.current = target
    streamingRef.current = streaming
    if (shownRef.current > target.length || reducedMotion()) {
      shownRef.current = target.length
      setShown(target.length)
      return
    }
    if (frame.current || shownRef.current === target.length) return

    let last = performance.now()
    const tick = (now: number) => {
      const goal = targetRef.current.length
      const backlog = goal - shownRef.current
      if (backlog <= 0) {
        frame.current = 0
        return
      }
      const frames = Math.min(4, (now - last) / 16.7 || 1)
      last = now
      // Drain over ~7 frames while streaming, ~2 once done.
      const drain = streamingRef.current ? 7 : 2
      let next = Math.min(goal, shownRef.current + Math.max(1, Math.ceil((backlog / drain) * frames)))
      // Finish the word we're in, so half-words and half-markers (`**bo`) don't flash.
      const text = targetRef.current
      for (let i = next; i < Math.min(goal, next + 12); i++) {
        if (/\s/.test(text[i])) {
          next = i
          break
        }
      }
      shownRef.current = next
      setShown(next)
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [target, streaming])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  return target.slice(0, shown)
}

export const Answer = memo(function Answer({ message }: { message: AssistantMessage }) {
  const streaming = message.status === 'streaming'
  const live = useLive(streaming ? message.id : null)
  const target = streaming ? (live?.text ?? '') : message.text
  const text = useReveal(target, streaming)
  const revealing = streaming || text.length < target.length
  const tools = streaming ? (live?.tools ?? []) : message.tools
  const waiting = streaming && !target

  return (
    <div className="answer">
      {tools.length > 0 && (
        <div className="tools">
          {tools.map((tool, i) => (
            <ToolLine key={i} tool={tool} active={waiting && i === tools.length - 1} />
          ))}
        </div>
      )}
      {waiting && tools.length === 0 && <div className="status shimmer">Thinking…</div>}
      {text && <Markdown text={text} live={revealing} />}
      {message.status === 'error' && (
        <div className="answer-error" role="alert">
          <AlertIcon size={14} />
          <span>{message.error || 'Something went wrong.'}</span>
        </div>
      )}
      {message.status === 'stopped' && <div className="answer-note">Stopped</div>}
      {!revealing && message.text && <AnswerActions text={message.text} />}
    </div>
  )
})

function ToolLine({ tool, active }: { tool: ToolUse; active: boolean }) {
  const label =
    tool.kind === 'search'
      ? `${active ? 'Searching for' : 'Searched for'} “${tool.label}”`
      : tool.kind === 'fetch'
        ? `${active ? 'Reading' : 'Read'} ${tool.label}`
        : tool.label
  return (
    <div className={active ? 'status tool shimmer' : 'status tool'}>
      {tool.kind === 'search' ? <SearchIcon size={12} /> : <GlobeIcon size={12} />}
      <span>{label}</span>
    </div>
  )
}

function AnswerActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="answer-actions">
      <button
        type="button"
        className="ghost-button"
        data-copied={copied || undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={async () => {
          if (await copyText(text)) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          }
        }}
        aria-label="Copy answer"
      >
        <span className="swap">
          <CopyIcon size={13} className="swap-a" />
          <CheckIcon size={13} className="swap-b" />
        </span>
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}
