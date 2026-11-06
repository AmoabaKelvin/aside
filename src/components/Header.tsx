import { memo } from 'react'
import { when } from '../lib/format'
import { ComposeIcon, GearIcon, PinIcon } from './Icons'

type Props = {
  title: string | null
  /** 1-based position in history, newest first. */
  position: number
  total: number
  at: number | null
  pinned: boolean
  /** ⌘⌫ was pressed once: the meta line asks before deleting. */
  confirmingDelete: boolean
  onPin: () => void
  onNew: () => void
  onSettings: () => void
}

export const Header = memo(function Header({ title, position, total, at, pinned, confirmingDelete, onPin, onNew, onSettings }: Props) {
  return (
    <header className="header" data-tauri-drag-region>
      <div className="header-text" data-tauri-drag-region>
        <div className="header-title" data-tauri-drag-region>
          {title ?? 'New chat'}
        </div>
        {title &&
          (confirmingDelete ? (
            <div className="header-meta header-confirm" role="alert" data-tauri-drag-region>
              Delete this chat? <kbd>↵</kbd>
            </div>
          ) : (
            <div className="header-meta" data-tauri-drag-region>
              {position > 0 && `${position} of ${total}`}
              {position > 0 && at !== null && ' · '}
              {at !== null && when(at)}
            </div>
          ))}
      </div>
      <div className="header-actions">
        <button
          type="button"
          className="icon-button"
          data-on={pinned || undefined}
          onClick={onPin}
          onMouseDown={(e) => e.preventDefault()}
          aria-pressed={pinned}
          aria-label="Pin"
          title={pinned ? 'Unpin  ⌘P' : 'Keep open  ⌘P'}
        >
          <PinIcon filled={pinned} />
        </button>
        <button type="button" className="icon-button" onClick={onNew} onMouseDown={(e) => e.preventDefault()} aria-label="New chat" title="New chat  ⌘N">
          <ComposeIcon />
        </button>
        <button type="button" className="icon-button" onClick={onSettings} onMouseDown={(e) => e.preventDefault()} aria-label="Settings" title="Settings  ⌘,">
          <GearIcon />
        </button>
      </div>
    </header>
  )
})
