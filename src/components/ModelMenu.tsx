import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { providerName } from '../lib/format'
import type { Provider } from '../lib/types'
import { CheckIcon, ChevronDownIcon } from './Icons'

type Props = {
  provider: Provider
  model: string
  /** Each provider's model, as the menu shows it. */
  models: Record<Provider, string>
  open: boolean
  onOpen: (open: boolean) => void
  onPick: (provider: Provider) => void
}

const PROVIDERS: Provider[] = ['claude', 'codex']

/** The provider pill, and the small menu above it. */
export function ModelMenu({ provider, model, models, open, onOpen, onPick }: Props) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, onOpen])

  return (
    <div className="model" ref={root}>
      <button
        type="button"
        className="model-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onOpen(!open)}
        title="Switch model  ⌘/"
      >
        <span className="provider-dot" data-provider={provider} />
        <span className="model-name">{providerName(provider)}</span>
        {model && <span className="model-detail">{model}</span>}
        <ChevronDownIcon size={12} className="model-chevron" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="menu"
            role="menu"
            initial={{ opacity: 0, transform: 'translateY(4px) scale(0.97)' }}
            animate={{ opacity: 1, transform: 'translateY(0px) scale(1)', transitionEnd: { transform: 'none' } }}
            exit={{ opacity: 0, transform: ['translateY(0px) scale(1)', 'translateY(2px) scale(0.98)'], transition: { duration: 0.1 } }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="menu-label">This chat</div>
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={provider === p}
                className="menu-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(p)
                  onOpen(false)
                }}
              >
                <span className="provider-dot" data-provider={p} />
                <span className="menu-item-text">
                  <span>{providerName(p)}</span>
                  <span className="menu-item-detail">{models[p]}</span>
                </span>
                {provider === p && <CheckIcon size={14} className="menu-check" />}
              </button>
            ))}
            <div className="menu-foot">
              <kbd>⌘/</kbd> switch
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
