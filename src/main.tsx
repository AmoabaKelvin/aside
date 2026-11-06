import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { isNative, onStream } from './lib/native'
import { preloadHighlighting } from './lib/highlight'
import { handleStream } from './lib/store'
import './styles.css'

// Subscribed before anything renders, so no event is missed. Lives as long as the page.
onStream(handleStream)
// Shiki and the common grammars, in the background once the page is idle.
preloadHighlighting()

if (!isNative) {
  // In a plain browser, draw a stand-in desktop behind the transparent window. `?theme=dark|light` forces one.
  document.documentElement.dataset.browser = ''
  const theme = new URLSearchParams(location.search).get('theme')
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme
}

// Scrollbar thumbs show while an element is scrolling (and on hover, in CSS). An attribute on the
// scrolled element only: no React, nothing else restyled.
const scrollTimers = new WeakMap<Element, number>()
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target
    if (!(el instanceof Element)) return
    if (!scrollTimers.has(el)) el.setAttribute('data-scrolling', '')
    clearTimeout(scrollTimers.get(el))
    scrollTimers.set(
      el,
      window.setTimeout(() => {
        el.removeAttribute('data-scrolling')
        scrollTimers.delete(el)
      }, 900),
    )
  },
  { capture: true, passive: true },
)

// The window has no context menu of its own; keep the browser's out of the way except in text.
document.addEventListener('contextmenu', (e) => {
  const target = e.target as HTMLElement
  if (isNative && !target.closest('textarea, input, .prose, .bubble')) e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
