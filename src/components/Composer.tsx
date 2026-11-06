import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref } from 'react'
import { MAX_IMAGES, fromBlob, fromRaw, isImageFile, type Attachment } from '../lib/images'
import { isNative, pasteImage, readImage } from '../lib/native'
import { pickImagePaths } from '../lib/platform'
import type { Provider, RawImage } from '../lib/types'
import { ArrowUpIcon, CloseIcon, ImageIcon, StopIcon } from './Icons'
import { ModelMenu } from './ModelMenu'

export type ComposerHandle = {
  focus: () => void
  /** Empties the draft (text and images). */
  clear: () => void
  addBlobs: (blobs: Blob[]) => void
  addRaw: (images: RawImage[]) => void
  /** No text and no images. */
  isEmpty: () => boolean
}

type Props = {
  ref: Ref<ComposerHandle>
  streaming: boolean
  provider: Provider
  model: string
  models: Record<Provider, string>
  menuOpen: boolean
  onMenuOpen: (open: boolean) => void
  onProvider: (provider: Provider) => void
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  onOpenImage: (src: string) => void
}

const ease = [0.22, 1, 0.36, 1] as const

export function Composer({ ref, streaming, provider, model, models, menuOpen, onMenuOpen, onProvider, onSend, onStop, onOpenImage }: Props) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const count = useRef(0)
  useEffect(() => {
    count.current = images.length
  }, [images])

  // Grow with the text, measured before paint so it never jumps. CSS caps it.
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  function add(makers: Array<() => Promise<Attachment>>) {
    const room = MAX_IMAGES - count.current
    if (room <= 0) return
    for (const make of makers.slice(0, room)) {
      make()
        .then((attachment) =>
          setImages((list) => {
            if (list.length >= MAX_IMAGES) {
              URL.revokeObjectURL(attachment.url)
              return list
            }
            return [...list, attachment]
          }),
        )
        .catch(() => {})
    }
    textarea.current?.focus({ preventScroll: true })
  }

  function addBlobs(blobs: Blob[]) {
    add(blobs.map((blob) => () => fromBlob(blob)))
  }

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus({ preventScroll: true }),
    clear: () => {
      setText('')
      setImages((list) => {
        list.forEach((a) => URL.revokeObjectURL(a.url))
        return []
      })
    },
    addBlobs,
    addRaw: (raws) => add(raws.map((raw) => () => fromRaw(raw))),
    isEmpty: () => !text.trim() && images.length === 0,
  }))

  function remove(id: string) {
    setImages((list) => {
      const gone = list.find((a) => a.id === id)
      if (gone) setTimeout(() => URL.revokeObjectURL(gone.url), 400)
      return list.filter((a) => a.id !== id)
    })
    textarea.current?.focus({ preventScroll: true })
  }

  const canSend = !streaming && (text.trim().length > 0 || images.length > 0)

  function send() {
    if (!canSend) return
    onSend(text.trim(), images)
    setText('')
    setImages([])
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter(isImageFile)
    if (files.length) {
      event.preventDefault()
      addBlobs(files)
      return
    }
    // A screenshot copied with ⌃⇧⌘4 isn't always visible to the page. Ask the app for it.
    if (!event.clipboardData.getData('text/plain')) {
      event.preventDefault()
      pasteImage()
        .then((raw) => raw && add([() => fromRaw(raw)]))
        .catch(() => {})
    }
  }

  async function attach() {
    if (!isNative) {
      fileInput.current?.click()
      return
    }
    const paths = await pickImagePaths().catch(() => [])
    add(paths.map((path) => () => readImage(path).then(fromRaw)))
  }

  return (
    <div className="composer" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <AnimatePresence initial={false}>
        {images.length > 0 && (
          <motion.div
            className="attachments-wrap"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.14, ease } }}
            transition={{ type: 'spring', stiffness: 520, damping: 40 }}
          >
            <div className="attachments">
              <AnimatePresence initial={false} mode="popLayout">
                {images.map((image) => (
                  <motion.div
                    key={image.id}
                    layout
                    className="attachment"
                    initial={{ opacity: 0, transform: 'scale(0.9)' }}
                    animate={{ opacity: 1, transform: 'scale(1)', transitionEnd: { transform: 'none' } }}
                    exit={{ opacity: 0, transform: ['scale(1)', 'scale(0.9)'], transition: { duration: 0.12, ease } }}
                    transition={{ type: 'spring', stiffness: 520, damping: 34 }}
                  >
                    <button type="button" className="attachment-image" onClick={() => onOpenImage(image.url)} onMouseDown={(e) => e.preventDefault()}>
                      <img src={image.url} alt="" draggable={false} />
                    </button>
                    <button
                      type="button"
                      className="attachment-remove"
                      aria-label="Remove image"
                      onClick={() => remove(image.id)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <CloseIcon size={10} />
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <textarea
        ref={textarea}
        className="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={streaming ? 'Answering…' : 'Ask anything'}
        rows={1}
        spellCheck
        autoFocus
      />

      <div className="composer-footer">
        <ModelMenu provider={provider} model={model} models={models} open={menuOpen} onOpen={onMenuOpen} onPick={onProvider} />
        <div className="composer-actions">
          <button type="button" className="icon-button" onClick={attach} onMouseDown={(e) => e.preventDefault()} aria-label="Attach images" title="Attach images">
            <ImageIcon />
          </button>
          <button
            type="button"
            className="send"
            data-state={streaming ? 'stop' : canSend ? 'ready' : 'idle'}
            onClick={streaming ? onStop : send}
            onMouseDown={(e) => e.preventDefault()}
            aria-label={streaming ? 'Stop (⌘.)' : 'Send (↵)'}
            title={streaming ? 'Stop  ⌘.' : 'Send  ↵'}
          >
            <span className="swap">
              <ArrowUpIcon size={15} className="swap-a" />
              <StopIcon size={15} className="swap-b" />
            </span>
          </button>
        </div>
      </div>

      {!isNative && (
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addBlobs([...(e.target.files ?? [])].filter(isImageFile))
            e.target.value = ''
          }}
        />
      )}
    </div>
  )
}
