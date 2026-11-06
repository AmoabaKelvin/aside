import type { Provider, Settings } from './types'

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const full = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "Today 9:02 AM", "Yesterday 4:10 PM", "Mon 3:15 PM", "Oct 12", "Oct 12, 2024". */
export function when(ms: number, now = new Date()) {
  const d = new Date(ms)
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days <= 0) return `Today ${time.format(d)}`
  if (days === 1) return `Yesterday ${time.format(d)}`
  if (days < 7) return `${weekday.format(d)} ${time.format(d)}`
  return d.getFullYear() === now.getFullYear() ? monthDay.format(d) : full.format(d)
}

export const TEXT_SIZE = { min: 12, max: 20, default: 15 }

/** The conversation's reading size, as `--text-size` on the root. Chrome doesn't use it. */
export function applyTextSize(px: number | undefined) {
  const size = Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, Math.round(px || TEXT_SIZE.default)))
  document.documentElement.style.setProperty('--text-size', `${size}px`)
}

export const providerName = (p: Provider) => (p === 'claude' ? 'Claude' : 'Codex')

const CLAUDE_MODELS: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

export function modelName(provider: Provider, settings: Settings | undefined, codexLabel?: string) {
  if (!settings) return ''
  if (provider === 'claude') return CLAUDE_MODELS[settings.claudeModel] ?? settings.claudeModel
  return codexLabel || settings.codexModel || 'Default'
}
