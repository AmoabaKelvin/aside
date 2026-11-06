import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { imageSrc } from '../lib/store'
import type { Conversation, UserMessage } from '../lib/types'
import { Answer } from './Answer'
import { ArrowDownIcon } from './Icons'

type Props = {
  conversation: Conversation | undefined
  imagesDir: string
  onOpenImage: (src: string) => void
}

/** How close to the bottom still counts as "at the bottom". */
const STICK = 40

export const Thread = memo(function Thread({ conversation, imagesDir, onOpenImage }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const jumping = useRef(false)
  const [away, setAway] = useState(false)
  const mountedAt = useRef(Date.now())
  const count = conversation?.messages.length ?? 0
  const lastMessage = conversation?.messages.at(-1)
  const lastAt = lastMessage?.at ?? 0
  // A question just asked, or the answer to it just starting.
  const arriving = lastMessage?.role === 'user' || (lastMessage?.role === 'assistant' && lastMessage.status === 'streaming')

  // Follow the bottom as content grows, before paint, so it never visibly lags.
  useLayoutEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const follow = () => {
      if (jumping.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      else if (stuck.current) el.scrollTop = el.scrollHeight
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(inner)
    // The composer growing shrinks the scroller; keep the bottom where it was.
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A new question always brings you back down.
  useLayoutEffect(() => {
    if (!arriving || lastAt < mountedAt.current) return
    stuck.current = true
    setAway(false)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, arriving, lastAt])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    // The header gets a hairline once anything sits under it. Set on the DOM: no re-render per scroll.
    const card = el.closest('.card')
    // Only the user unpins: a scroll right after their wheel, touch, keys or scrollbar drag. Anything
    // else that moves the position while pinned (WebKit restoring an older offset as the scroller
    // resizes under a growing composer) is put straight back.
    let userUntil = 0
    let dragging = false
    const byUser = () => dragging || performance.now() < userUntil
    const markUser = () => {
      userUntil = performance.now() + 300
    }
    const onScroll = () => {
      card?.toggleAttribute('data-scrolled', el.scrollTop > 1)
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      if (jumping.current) {
        if (distance < 2) jumping.current = false
        else if (byUser()) jumping.current = false
        else return
      }
      if (distance <= STICK) stuck.current = true
      else if (byUser()) stuck.current = false
      else if (stuck.current) {
        el.scrollTop = el.scrollHeight
        return
      }
      setAway(!stuck.current && distance > STICK * 3)
    }
    const onWheel = (e: WheelEvent) => {
      markUser()
      if (e.deltaY < 0) {
        jumping.current = false
        stuck.current = false
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) markUser()
    }
    // A press past the content box is on the scrollbar.
    const onPointerDown = (e: PointerEvent) => {
      if (e.offsetX >= el.clientWidth) dragging = true
    }
    const onTouchStart = () => {
      dragging = true
    }
    const onRelease = () => {
      if (!dragging) return
      dragging = false
      markUser()
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('pointerup', onRelease)
    window.addEventListener('touchend', onRelease)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('pointerup', onRelease)
      window.removeEventListener('touchend', onRelease)
      card?.removeAttribute('data-scrolled')
    }
  }, [])

  function jump() {
    const el = scroller.current
    if (!el) return
    stuck.current = true
    jumping.current = true
    setAway(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  return (
    <>
      <div ref={scroller} className="thread" tabIndex={-1}>
        <div ref={content} className="thread-inner">
          {conversation?.messages.map((m) =>
            m.role === 'user' ? (
              <UserTurn key={m.id} message={m} imagesDir={imagesDir} onOpenImage={onOpenImage} enter={m.at >= mountedAt.current} />
            ) : (
              <Answer key={m.id} message={m} />
            ),
          )}
        </div>
      </div>
      <button type="button" className="jump" data-show={away || undefined} onClick={jump} onMouseDown={(e) => e.preventDefault()} tabIndex={-1}>
        <ArrowDownIcon size={12} />
        Jump to latest
      </button>
    </>
  )
})

const UserTurn = memo(function UserTurn({
  message,
  imagesDir,
  onOpenImage,
  enter,
}: {
  message: UserMessage
  imagesDir: string
  onOpenImage: (src: string) => void
  enter: boolean
}) {
  return (
    <div className={enter ? 'user enter' : 'user'}>
      {message.images.length > 0 && (
        <div className="user-images">
          {message.images.map((image, i) => {
            const src = imageSrc(imagesDir, image.file)
            // A fixed height and the real aspect ratio, so nothing shifts when it loads.
            const height = 88
            const width = Math.round(Math.min(220, Math.max(48, (image.width / Math.max(1, image.height)) * height)))
            return (
              <button key={i} type="button" className="thumb" onClick={() => onOpenImage(src)} onMouseDown={(e) => e.preventDefault()}>
                <img src={src} width={width} height={height} alt="" draggable={false} decoding="async" />
              </button>
            )
          })}
        </div>
      )}
      {message.text && <div className="bubble">{message.text}</div>}
    </div>
  )
})
