import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Composer, type ComposerHandle } from './components/Composer'
import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { ImageViewer } from './components/ImageViewer'
import { Settings } from './components/Settings'
import { Thread } from './components/Thread'
import { applyTextSize, modelName } from './lib/format'
import { isImageFile, type Attachment } from './lib/images'
import {
  codexModels as loadCodexModels,
  deleteConversation,
  getSettings,
  hidePanel,
  onClose,
  onDropPaths,
  onOpen,
  onOpenSettings,
  readImage,
  setPinned as setNativePinned,
  stop,
  warm,
} from './lib/native'
import { copyText } from './lib/platform'
import {
  ensureConversation,
  getSummaries,
  isDraftId,
  lastAnswer,
  refreshSummaries,
  removeConversation,
  sendMessage,
  streamingIn,
  useConversation,
  useStreaming,
  useSummaries,
} from './lib/store'
import type { ModelOption, Provider, SettingsInfo } from './lib/types'

const ease = [0.22, 1, 0.36, 1] as const
const NEW = 'new'

function withoutNew(map: Record<string, Provider>) {
  const next = { ...map }
  delete next[NEW]
  return next
}

export function App() {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const openedOnce = useRef(false)
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [codexModels, setCodexModels] = useState<ModelOption[] | null>(null)
  const summaries = useSummaries()

  // Where we are in history. null = the clean slate, "newer than everything".
  const [viewId, setViewId] = useState<string | null>(null)
  const [view, setView] = useState({ key: 0, dir: 0 })
  const conversation = useConversation(viewId)
  const streaming = useStreaming(viewId)

  const [providerFor, setProviderFor] = useState<Record<string, Provider>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [viewer, setViewer] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // ⌘⌫ asks first: the conversation id waiting for a second ⌘⌫ or ↵.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const confirmTimer = useRef(0)
  // Read by the key handler; set at once so a quick ⌘⌫⌘⌫ sees the first press before React renders.
  const confirmRef = useRef<string | null>(null)
  const codexRequested = useRef(false)
  const composer = useRef<ComposerHandle>(null)

  const index = viewId ? summaries.findIndex((s) => s.id === viewId) : -1
  const summary = index >= 0 ? summaries[index] : undefined
  const provider: Provider = providerFor[viewId ?? NEW] ?? conversation?.provider ?? summary?.provider ?? info?.settings.provider ?? 'claude'
  const codexLabel = codexModels?.find((m) => m.id === info?.settings.codexModel)?.label
  const model = modelName(provider, info?.settings, codexLabel)
  const claudeModel = modelName('claude', info?.settings)
  const codexModel = modelName('codex', info?.settings, codexLabel)
  const models = useMemo(() => ({ claude: claudeModel, codex: codexModel }), [claudeModel, codexModel])

  // The latest values, for event handlers registered once.
  const state = useRef({ viewId, provider, settingsOpen, menuOpen, viewer, pinned, streaming })
  useLayoutEffect(() => {
    state.current = { viewId, provider, settingsOpen, menuOpen, viewer, pinned, streaming }
  })

  const focusComposer = useCallback(() => composer.current?.focus(), [])

  // History

  const go = useCallback((target: number, dir: number) => {
    const list = getSummaries()
    if (target >= list.length || target < -1) return
    const id = target < 0 ? null : list[target].id
    setViewId(id)
    setView((v) => ({ key: v.key + 1, dir }))
    setMenuOpen(false)
    // Load this one, and its neighbours so the next step is instant.
    for (const i of [target, target + 1, target - 1]) if (list[i]) ensureConversation(list[i].id)
  }, [])

  const step = useCallback(
    (older: boolean) => {
      const { viewId: current } = state.current
      const list = getSummaries()
      const i = current ? list.findIndex((s) => s.id === current) : -1
      // A draft (just sent, no id yet) sits between the clean slate and the newest.
      const at = current && i < 0 ? -0.5 : i
      const target = older ? Math.floor(at) + 1 : Math.ceil(at) - 1
      if (target === i) return
      go(target, older ? -1 : 1)
    },
    [go],
  )

  const newChat = useCallback(() => {
    if (state.current.viewId !== null) go(-1, 1)
    setSettingsOpen(false)
    focusComposer()
  }, [go, focusComposer])

  // Open and close

  const close = useCallback(() => {
    openRef.current = false
    setOpen(false)
    setMenuOpen(false)
    setViewer(null)
  }, [])

  useEffect(() => {
    getSettings().then(setInfo, () => {})
    refreshSummaries()
    const offOpen = onOpen(({ fresh }) => {
      openRef.current = true
      openedOnce.current = true
      setOpen(true)
      if (fresh) {
        setViewId(null)
        setView((v) => ({ key: v.key + 1, dir: 0 }))
        setSettingsOpen(false)
        setProviderFor(withoutNew)
        composer.current?.clear()
      }
      refreshSummaries()
      getSettings().then(setInfo, () => {})
      warm(state.current.provider).catch(() => {})
      // Once, in the background, so the pill can show Codex's model by name. Rust caches it.
      if (!codexRequested.current) {
        codexRequested.current = true
        loadCodexModels().then(setCodexModels, () => {
          codexRequested.current = false
        })
      }
      composer.current?.focus()
      requestAnimationFrame(() => composer.current?.focus())
    })
    const offClose = onClose(close)
    const offSettings = onOpenSettings(() => setSettingsOpen(true))
    const offDrop = onDropPaths(
      (paths) => {
        Promise.allSettled(paths.map((p) => readImage(p))).then((results) => {
          const raws = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
          if (raws.length) composer.current?.addRaw(raws)
        })
      },
      (over) => setDropping(over),
    )
    return () => {
      offOpen()
      offClose()
      offSettings()
      offDrop()
    }
  }, [close])

  const textSize = info?.settings.textSize
  useEffect(() => applyTextSize(textSize), [textSize])

  useEffect(() => {
    if (!settingsOpen) focusComposer()
  }, [settingsOpen, focusComposer])

  // Sending

  const send = useCallback((text: string, attachments: Attachment[]) => {
    const { viewId: current, provider: chosen } = state.current
    if (current && streamingIn(current)) return
    // A draft whose first send failed starts over as a new conversation.
    const conversationId = current && !isDraftId(current) ? current : null
    if (!conversationId) setProviderFor(withoutNew)
    sendMessage({
      conversationId,
      text,
      attachments,
      provider: chosen,
      onStart: (key) => setViewId(key),
      onCreated: (draft, real) => setViewId((v) => (v === draft ? real : v)),
    })
  }, [])

  const stopAnswer = useCallback(() => {
    const { viewId: current } = state.current
    if (current && !isDraftId(current) && streamingIn(current)) stop(current).catch(() => {})
  }, [])

  const chooseProvider = useCallback((next: Provider) => {
    setProviderFor((p) => ({ ...p, [state.current.viewId ?? NEW]: next }))
    if (next !== state.current.provider) warm(next).catch(() => {})
  }, [])

  const togglePin = useCallback(() => {
    const next = !state.current.pinned
    setPinned(next)
    setNativePinned(next).catch(() => {})
  }, [])

  const showToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 1400)
  }, [])

  // Deleting

  const cancelDelete = useCallback(() => {
    clearTimeout(confirmTimer.current)
    confirmRef.current = null
    setConfirmDelete(null)
  }, [])

  const armDelete = useCallback((id: string) => {
    clearTimeout(confirmTimer.current)
    confirmRef.current = id
    setConfirmDelete(id)
    confirmTimer.current = window.setTimeout(() => {
      confirmRef.current = null
      setConfirmDelete(null)
    }, 2000)
  }, [])

  const deleteCurrent = useCallback(
    (id: string) => {
      cancelDelete()
      const i = getSummaries().findIndex((s) => s.id === id)
      removeConversation(id)
      const after = getSummaries()
      // Slide to the neighbour: the next older one takes its place, else the next newer, else the clean slate.
      if (i >= 0 && after[i]) go(i, -1)
      else go(Math.min(i, after.length) - 1, 1)
      deleteConversation(id).catch(() => {
        refreshSummaries()
        showToast('Couldn’t delete that chat')
      })
    },
    [cancelDelete, go, showToast],
  )

  const openSettings = useCallback(() => setSettingsOpen((o) => !o), [])
  const closeViewer = useCallback(() => setViewer(null), [])

  // Keyboard

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = state.current
      const armed = confirmRef.current
      if (armed) {
        const again = e.code === 'Backspace' && e.metaKey
        if (e.key === 'Enter' || again) {
          e.preventDefault()
          if (armed === s.viewId) deleteCurrent(armed)
          else cancelDelete()
          return
        }
        // Anything else is a no. Pressing ⌘ (or another modifier) on its own isn't.
        if (['Meta', 'Shift', 'Control', 'Alt'].includes(e.key)) return
        cancelDelete()
        if (e.key === 'Escape') {
          e.preventDefault()
          return
        }
      }
      // Typing after a click into the thread (say, to select text) still goes to the composer:
      // focusing it during keydown sends this very character there.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && !s.settingsOpen && !s.viewer) {
        const active = document.activeElement
        if (!active || !active.matches('textarea, input, select, [contenteditable="true"]')) composer.current?.focus()
      }
      if (e.key === 'Escape') {
        if (e.isComposing) return
        e.preventDefault()
        if (s.viewer) setViewer(null)
        else if (s.menuOpen) setMenuOpen(false)
        else if (s.settingsOpen) setSettingsOpen(false)
        else close()
        return
      }
      if (!e.metaKey || e.ctrlKey || e.altKey) return
      const handled = () => e.preventDefault()
      switch (e.code) {
        case 'Comma':
          handled()
          setSettingsOpen((o) => !o)
          return
        case 'KeyP':
          handled()
          togglePin()
          return
      }
      if (s.settingsOpen && e.code !== 'KeyN') return
      switch (e.code) {
        case 'BracketLeft':
          handled()
          step(true)
          break
        case 'BracketRight':
          handled()
          step(false)
          break
        case 'KeyN':
          if (e.shiftKey) return
          handled()
          newChat()
          break
        case 'Period':
          handled()
          stopAnswer()
          break
        case 'Slash':
          handled()
          chooseProvider(s.provider === 'claude' ? 'codex' : 'claude')
          break
        case 'Backspace': {
          // In a draft, ⌘⌫ deletes text as usual. Only an empty composer means "delete this chat".
          const id = s.viewId
          if (!id || isDraftId(id) || streamingIn(id) || !composer.current?.isEmpty()) return
          handled()
          armDelete(id)
          break
        }
        case 'KeyC': {
          if (!e.shiftKey) return
          handled()
          const text = lastAnswer(s.viewId)
          if (text) copyText(text).then((ok) => ok && showToast('Copied the answer'))
          break
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close, step, newChat, stopAnswer, chooseProvider, togglePin, showToast, armDelete, cancelDelete, deleteCurrent])

  // Drag and drop (the browser's; the app's comes from onDropPaths)

  const dragDepth = useRef(0)
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current++
      setDropping(true)
    },
    onDragOver: (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    },
    onDragLeave: () => {
      if (--dragDepth.current <= 0) {
        dragDepth.current = 0
        setDropping(false)
      }
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDropping(false)
      composer.current?.addBlobs([...e.dataTransfer.files].filter(isImageFile))
    },
  }

  const variants: Variants = {
    // At rest the card has no transform at all: WebKit can keep a transformed element as a cached
    // bitmap layer, which softens text. Closing starts from an explicit identity for the same reason.
    open: {
      opacity: 1,
      transform: 'translateY(0px) scale(1)',
      transition: reduce ? { duration: 0.12 } : { type: 'spring', stiffness: 520, damping: 34 },
      transitionEnd: { transform: 'none' },
    },
    closed: {
      opacity: 0,
      transform: reduce ? 'translateY(0px) scale(1)' : ['translateY(0px) scale(1)', 'translateY(-10px) scale(0.97)'],
      transition: { duration: 0.12, ease },
    },
  }

  const imagesDir = info?.imagesDir ?? ''
  const title = viewId ? (conversation?.title ?? summary?.title ?? '') : null

  return (
    <div className="frame" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div
        className="card"
        data-open={open || undefined}
        variants={variants}
        initial="closed"
        animate={open ? 'open' : 'closed'}
        onAnimationComplete={(definition) => {
          if (definition !== 'closed' || openRef.current || !openedOnce.current) return
          hidePanel().catch(() => {})
          setSettingsOpen(false)
        }}
        {...dropHandlers}
      >
        <Header
          title={title}
          position={index + 1}
          total={summaries.length}
          at={conversation?.createdAt ?? summary?.createdAt ?? null}
          pinned={pinned}
          confirmingDelete={confirmDelete !== null && confirmDelete === viewId}
          onPin={togglePin}
          onNew={newChat}
          onSettings={openSettings}
        />

        <div className="body">
          <motion.div
            key={view.key}
            className="pane"
            initial={view.dir ? { opacity: 0, transform: `translateX(${reduce ? 0 : view.dir * 14}px)` } : false}
            animate={view.dir ? { opacity: 1, transform: 'translateX(0px)', transitionEnd: { transform: 'none' } } : undefined}
            transition={{ duration: 0.16, ease }}
          >
            {viewId === null ? (
              <EmptyState provider={provider} model={model} hasHistory={summaries.length > 0} />
            ) : (
              <Thread conversation={conversation} imagesDir={imagesDir} onOpenImage={setViewer} />
            )}
          </motion.div>
          <div className="fade fade-bottom" />
        </div>

        <Composer
          ref={composer}
          streaming={streaming}
          provider={provider}
          model={model}
          models={models}
          menuOpen={menuOpen}
          onMenuOpen={setMenuOpen}
          onProvider={chooseProvider}
          onSend={send}
          onStop={stopAnswer}
          onOpenImage={setViewer}
        />

        <AnimatePresence>
          {toast && (
            <div className="toast-wrap">
              <motion.div
                className="toast"
                initial={{ opacity: 0, transform: 'translateY(4px)' }}
                animate={{ opacity: 1, transform: 'translateY(0px)', transitionEnd: { transform: 'none' } }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={{ duration: 0.18, ease }}
              >
                {toast}
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <div className="drop" data-show={dropping || undefined}>
          <div className="drop-inner">Drop images to attach</div>
        </div>

        <AnimatePresence>
          {settingsOpen && info && (
            <Settings info={info} onInfo={setInfo} onClose={() => setSettingsOpen(false)} codexModels={codexModels} onCodexModels={setCodexModels} />
          )}
        </AnimatePresence>

        <ImageViewer src={viewer} onClose={closeViewer} />
      </motion.div>
    </div>
  )
}
