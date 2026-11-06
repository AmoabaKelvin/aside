// Turning a keydown into a Tauri accelerator ("Cmd+Shift+Space"), and back into glyphs for display.

const MODIFIER_CODES = new Set(['MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'CapsLock', 'Fn'])

const ARROWS: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }

function keyName(code: string) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  return ARROWS[code] ?? code
}

export type Recorded = { accelerator: string } | { pending: string } | null

/** `pending` while only modifiers are held, `null` when the key can't be a shortcut. */
export function fromKeyboardEvent(e: KeyboardEvent): Recorded {
  const mods: string[] = []
  if (e.metaKey) mods.push('Cmd')
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (MODIFIER_CODES.has(e.code)) return { pending: mods.join('+') }
  const key = keyName(e.code)
  if (!key) return null
  return { accelerator: [...mods, key].join('+') }
}

const GLYPHS: Record<string, string> = {
  Cmd: '⌘',
  Command: '⌘',
  Super: '⌘',
  CommandOrControl: '⌘',
  CmdOrCtrl: '⌘',
  Ctrl: '⌃',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↵',
  Backspace: '⌫',
  Escape: 'Esc',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
}

export function formatAccelerator(accelerator: string) {
  return accelerator
    .split('+')
    .filter(Boolean)
    .map((part) => GLYPHS[part] ?? part)
    .join('')
}

/** Keys as separate caps, for `<kbd>` rendering: "⌘⇧Space" → ["⌘", "⇧", "Space"]. */
export function acceleratorKeys(accelerator: string) {
  return accelerator
    .split('+')
    .filter(Boolean)
    .map((part) => GLYPHS[part] ?? part)
}
