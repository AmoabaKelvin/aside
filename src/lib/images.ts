// Attachments: everything is downscaled here, in the page, before it's sent.

import type { OutgoingImage, RawImage } from './types'

export type Attachment = { id: string; url: string; out: OutgoingImage }

export const MAX_IMAGES = 8
const LONG_EDGE = 1568
/** Above this a PNG is re-encoded as JPEG. */
const PNG_LIMIT = 1.5 * 1024 * 1024
/** Files at or under this, and already small enough, go as they are. */
const PASSTHROUGH_LIMIT = 3.5 * 1024 * 1024
const SENDABLE = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

let seq = 0

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality))
}

function base64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function fromBlob(blob: Blob): Promise<Attachment> {
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap
  const scale = Math.min(1, LONG_EDGE / Math.max(width, height))
  let out = blob
  let w = width
  let h = height

  if (scale < 1 || !SENDABLE.includes(blob.type) || blob.size > PASSTHROUGH_LIMIT) {
    w = Math.max(1, Math.round(width * scale))
    h = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d')!
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, w, h)
    const png = blob.type === 'image/jpeg' ? null : await toBlob(canvas, 'image/png')
    out = png && png.size <= PNG_LIMIT ? png : await toBlob(canvas, 'image/jpeg', 0.88)
  }
  bitmap.close()

  return {
    id: `img-${++seq}`,
    url: URL.createObjectURL(out),
    out: { dataBase64: await base64(out), mime: out.type, width: w, height: h },
  }
}

export async function fromRaw(raw: RawImage) {
  const blob = await (await fetch(`data:${raw.mime};base64,${raw.dataBase64}`)).blob()
  return fromBlob(blob)
}

export const isImageFile = (file: File) => file.type.startsWith('image/')
