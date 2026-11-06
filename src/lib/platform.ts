// Plugin calls that have a browser stand-in, so the page works the same in `pnpm dev`.

import { isNative } from './native'

export async function openLink(url: string) {
  if (!/^(https?:|mailto:)/i.test(url)) return
  if (!isNative) {
    window.open(url, '_blank', 'noopener')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

/** Paths of images picked in the open dialog. Native only. */
export async function pickImagePaths(): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    multiple: true,
    directory: false,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tiff', 'bmp'] }],
  })
  if (!picked) return []
  return Array.isArray(picked) ? picked : [picked]
}

const AUTOSTART_KEY = 'aside.mock.autostart'

export async function autostartEnabled() {
  if (!isNative) return localStorage.getItem(AUTOSTART_KEY) === '1'
  const { isEnabled } = await import('@tauri-apps/plugin-autostart')
  return isEnabled()
}

export async function setAutostart(on: boolean) {
  if (!isNative) {
    localStorage.setItem(AUTOSTART_KEY, on ? '1' : '0')
    return
  }
  const { enable, disable } = await import('@tauri-apps/plugin-autostart')
  await (on ? enable() : disable())
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older webviews: the selection-based copy still works inside a user gesture.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    const focused = document.activeElement as HTMLElement | null
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    focused?.focus({ preventScroll: true })
    return ok
  }
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
