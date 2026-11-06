// Messages between the page and the highlighting worker.

/** One token: its text and its light and dark colours ('' = the default text colour). */
export type WireToken = [content: string, light: string, dark: string]
export type WireLine = WireToken[]

export type ToWorker =
  | { t: 'load'; lang: string }
  /** Tokenize `text` for block `key`. The reply covers exactly this text. */
  | { t: 'tok'; key: string; lang: string; text: string }
  | { t: 'drop'; key: string }

export type FromWorker =
  | { t: 'ready'; lang: string }
  /** Lines from index `from` on (earlier lines are unchanged); the last line may be partial. */
  | { t: 'tok'; key: string; lang: string; text: string; from: number; lines: WireLine[] }
  /** The block can't be highlighted (grammar failed to load, or tokenizing threw): show it plain. */
  | { t: 'fail'; key: string; lang: string }
