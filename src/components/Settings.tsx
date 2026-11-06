import { motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { acceleratorKeys, fromKeyboardEvent } from '../lib/accelerator'
import { TEXT_SIZE, applyTextSize, providerName } from '../lib/format'
import { codexModels as loadCodexModels, revealTranscripts, setSettings } from '../lib/native'
import { autostartEnabled, setAutostart } from '../lib/platform'
import { errorText } from '../lib/store'
import type { ClaudeEffort, CodexEffort, ModelOption, Settings as SettingsShape, SettingsInfo } from '../lib/types'
import { ChevronDownIcon, ChevronLeftIcon, FolderIcon } from './Icons'

type Props = {
  info: SettingsInfo
  onInfo: (info: SettingsInfo) => void
  onClose: () => void
  codexModels: ModelOption[] | null
  onCodexModels: (models: ModelOption[]) => void
}

const CLAUDE_EFFORTS: Array<[ClaudeEffort, string]> = [
  ['', 'Default'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
]

const CODEX_EFFORTS: Array<[CodexEffort, string]> = [
  ['', 'Default'],
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
]

const FRESH_AFTER: Array<[number, string]> = [
  [0, 'Never'],
  [1, '1 minute'],
  [5, '5 minutes'],
  [10, '10 minutes'],
  [15, '15 minutes'],
  [30, '30 minutes'],
  [60, '1 hour'],
]

export function Settings({ info, onInfo, onClose, codexModels, onCodexModels }: Props) {
  const [settings, setLocal] = useState(info.settings)
  const [shortcutError, setShortcutError] = useState<string | null>(info.shortcutError)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [autostart, setAutostartState] = useState<boolean | null>(null)
  const latest = useRef(info.settings)
  const saveSeq = useRef(0)
  const instructionsTimer = useRef(0)

  useEffect(() => {
    autostartEnabled().then(setAutostartState, () => setAutostartState(false))
  }, [])

  useEffect(() => {
    if (!codexModels) loadCodexModels().then(onCodexModels, () => onCodexModels([]))
  }, [codexModels, onCodexModels])

  async function save(patch: Partial<SettingsShape>) {
    const previous = latest.current
    const next = { ...previous, ...patch }
    latest.current = next
    setLocal(next)
    // Saves can finish out of order (two quick clicks): only the newest one's answer counts, since it
    // carries every change so far. An older answer arriving late would undo the newer change.
    const seq = ++saveSeq.current
    try {
      const result = await setSettings(next)
      if (seq !== saveSeq.current) return true
      onInfo(result)
      setSaveError(null)
      if ('shortcut' in patch) setShortcutError(result.shortcutError)
      return true
    } catch (error) {
      if (seq !== saveSeq.current && !('shortcut' in patch)) return false
      // The Rust side keeps the old value, so the page does too.
      latest.current = { ...latest.current, ...pick(previous, patch) }
      setLocal(latest.current)
      if ('textSize' in patch) applyTextSize(previous.textSize)
      if ('shortcut' in patch) setShortcutError(errorText(error))
      else setSaveError(errorText(error))
      return false
    }
  }

  function onInstructions(value: string) {
    latest.current = { ...latest.current, instructions: value }
    setLocal(latest.current)
    clearTimeout(instructionsTimer.current)
    instructionsTimer.current = window.setTimeout(() => save({ instructions: value }), 450)
  }

  const claude = info.providers.find((p) => p.id === 'claude')
  const codex = info.providers.find((p) => p.id === 'codex')

  return (
    <motion.div
      className="settings"
      initial={{ transform: 'translateX(100%)' }}
      animate={{ transform: 'translateX(0%)', transitionEnd: { transform: 'none' } }}
      exit={{ transform: ['translateX(0%)', 'translateX(100%)'], transition: { duration: 0.2, ease: [0.32, 0.72, 0, 1] } }}
      transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
    >
      <header className="header settings-header" data-tauri-drag-region>
        <button type="button" className="back" onClick={onClose} aria-label="Back">
          <ChevronLeftIcon />
          <span>Back</span>
        </button>
        <div className="header-title settings-title" data-tauri-drag-region>
          Settings
        </div>
        <kbd className="settings-esc">esc</kbd>
      </header>

      <div className="settings-body">
        <Section title="General">
          <Row label="Shortcut" hint="Opens and closes Aside from any app." error={shortcutError}>
            <ShortcutRecorder value={settings.shortcut} onChange={(shortcut) => save({ shortcut })} />
          </Row>
          <Row label="Text size" hint="For the conversation. Everything else stays put.">
            <TextSize
              value={settings.textSize || TEXT_SIZE.default}
              onChange={(textSize) => {
                applyTextSize(textSize)
                save({ textSize })
              }}
            />
          </Row>
          <Row label="Position">
            <Segmented
              value={settings.position}
              options={[
                ['center', 'Center'],
                ['right', 'Right'],
              ]}
              onChange={(position) => save({ position })}
            />
          </Row>
          <Row label="Hide when clicking elsewhere" hint="Pin with ⌘P to keep it up for a while.">
            <Switch checked={settings.hideOnBlur} onChange={(hideOnBlur) => save({ hideOnBlur })} />
          </Row>
          <Row label="Start a new chat after" hint="Of being away. Earlier chats stay one ⌘[ away.">
            <Select value={String(settings.freshAfterMinutes)} onChange={(v) => save({ freshAfterMinutes: Number(v) })}>
              {FRESH_AFTER.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Launch at login">
            <Switch
              checked={!!autostart}
              disabled={autostart === null}
              onChange={(on) => {
                setAutostartState(on)
                setAutostart(on).catch(() => setAutostartState(!on))
              }}
            />
          </Row>
        </Section>

        <Section title="Answers">
          <Row label="Default for new chats">
            <Segmented
              value={settings.provider}
              options={[
                ['claude', 'Claude'],
                ['codex', 'Codex'],
              ]}
              onChange={(provider) => save({ provider })}
            />
          </Row>
          <Row label="Web search" hint="Let the model search and read pages when it helps.">
            <Switch checked={settings.webSearch} onChange={(webSearch) => save({ webSearch })} />
          </Row>
          <div className="row row-stack">
            <label className="row-label" htmlFor="instructions">
              Custom instructions
            </label>
            <textarea
              id="instructions"
              className="instructions"
              value={settings.instructions}
              placeholder="e.g. Be brief. I use TypeScript and macOS."
              onChange={(e) => onInstructions(e.target.value)}
              onBlur={(e) => {
                clearTimeout(instructionsTimer.current)
                if (e.target.value !== info.settings.instructions) save({ instructions: e.target.value })
              }}
              rows={3}
            />
          </div>
          {saveError && <div className="row-error">{saveError}</div>}
        </Section>

        <Section title="Claude" status={claude}>
          <Row label="Model">
            <Segmented
              value={settings.claudeModel}
              options={[
                ['opus', 'Opus'],
                ['sonnet', 'Sonnet'],
                ['haiku', 'Haiku'],
              ]}
              onChange={(claudeModel) => save({ claudeModel })}
            />
          </Row>
          <Row label="Effort">
            <Select value={settings.claudeEffort} onChange={(v) => save({ claudeEffort: v as ClaudeEffort })}>
              {CLAUDE_EFFORTS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Row>
        </Section>

        <Section title="Codex" status={codex}>
          <Row label="Model">
            <Select value={settings.codexModel} onChange={(codexModel) => save({ codexModel })} disabled={!codexModels}>
              <option value="">{codexModels ? 'Default' : 'Loading…'}</option>
              {(codexModels ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.isDefault ? ' (default)' : ''}
                </option>
              ))}
              {settings.codexModel && codexModels && !codexModels.some((m) => m.id === settings.codexModel) && (
                <option value={settings.codexModel}>{settings.codexModel}</option>
              )}
            </Select>
          </Row>
          <Row label="Effort">
            <Select value={settings.codexEffort} onChange={(v) => save({ codexEffort: v as CodexEffort })}>
              {CODEX_EFFORTS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Row>
        </Section>

        <Section title="Transcripts">
          <div className="row row-stack">
            <div className="path" title={info.transcriptsDir}>
              {info.transcriptsDir}
            </div>
            <div className="row-hint">Every chat is saved here as JSON, separate from Claude Code’s and Codex’s own history.</div>
          </div>
          <div className="row">
            <span />
            <button type="button" className="button" onClick={() => revealTranscripts()}>
              <FolderIcon size={14} />
              Reveal in Finder
            </button>
          </div>
        </Section>
      </div>
    </motion.div>
  )
}

function pick<T extends object>(from: T, keysOf: Partial<T>): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(keysOf) as Array<keyof T>) out[key] = from[key]
  return out
}

function Section({ title, status, children }: { title: string; status?: { ready: boolean; detail: string; id: string }; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
        {status && (
          <span className="provider-status" data-ready={status.ready || undefined} title={status.detail}>
            <span className="status-dot" />
            {status.ready ? 'Ready' : `${providerName(status.id as 'claude' | 'codex')} isn’t ready`}
          </span>
        )}
      </div>
      {status && <div className="section-detail">{status.detail}</div>}
      <div className="section-rows">{children}</div>
    </section>
  )
}

function Row({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-label">{label}</div>
        {error ? <div className="row-error">{error}</div> : hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  )
}

function TextSize({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  return (
    <div className="stepper" role="group" aria-label="Text size">
      <button type="button" aria-label="Smaller" disabled={value <= TEXT_SIZE.min} onClick={() => onChange(value - 1)}>
        <span className="stepper-a small">A</span>
      </button>
      <span className="stepper-value">{value}</span>
      <button type="button" aria-label="Larger" disabled={value >= TEXT_SIZE.max} onClick={() => onChange(value + 1)}>
        <span className="stepper-a large">A</span>
      </button>
    </div>
  )
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  )
}

/** Equal-width segments, so the selection pill moves with a transform alone. */
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  const index = Math.max(0, options.findIndex(([v]) => v === value))
  const n = options.length
  return (
    <div className="segmented" role="radiogroup">
      <span
        className="segmented-pill"
        style={{ width: `calc((100% - 4px - ${(n - 1) * 2}px) / ${n})`, transform: `translateX(calc(${index} * (100% + 2px)))` }}
      />
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => value !== v && onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function Select({ value, onChange, disabled, children }: { value: string; onChange: (value: string) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <div className="select">
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {children}
      </select>
      <ChevronDownIcon size={12} />
    </div>
  )
}

/**
 * Click, then press the keys. While recording, a window-level capture listener takes every key, so it
 * works without the button having focus (WebKit doesn't focus a button on click) and nothing reaches the panel.
 */
function ShortcutRecorder({ value, onChange }: { value: string | null; onChange: (accelerator: string | null) => Promise<boolean> }) {
  const [recording, setRecording] = useState(false)
  const [held, setHeld] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    if (!recording) return
    const stop = () => {
      setRecording(false)
      setHeld('')
    }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      if (plain && event.key === 'Escape') return stop()
      if (plain && (event.key === 'Backspace' || event.key === 'Delete')) {
        stop()
        onChangeRef.current(null)
        return
      }
      // By physical key (e.code), so ⌥Space is "Alt+Space" even though e.key is a non-breaking space.
      const recorded = fromKeyboardEvent(event)
      if (!recorded) return
      if ('pending' in recorded) return setHeld(recorded.pending)
      const accelerator = recorded.accelerator
      const hasModifier = /(^|\+)(Cmd|Ctrl|Alt)\+/.test(accelerator) || /(^|\+)F\d{1,2}$/.test(accelerator)
      if (!hasModifier) {
        setHeld('')
        return
      }
      stop()
      onChangeRef.current(accelerator)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      event.stopPropagation()
      // Letting go of the modifiers without a key clears the hint.
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) setHeld('')
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node)) stop()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', stop)
    }
  }, [recording])

  const keys = recording ? (held ? acceleratorKeys(held) : []) : value ? acceleratorKeys(value) : []

  return (
    <button
      ref={button}
      type="button"
      className="recorder"
      data-recording={recording || undefined}
      onClick={() => {
        setHeld('')
        setRecording((r) => !r)
      }}
    >
      {keys.length > 0 ? keys.map((k, i) => <kbd key={i}>{k}</kbd>) : <span className="recorder-empty">{recording ? 'Press keys…' : 'None'}</span>}
    </button>
  )
}
