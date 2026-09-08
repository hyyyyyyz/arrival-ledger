import { isPlausibleTrackingNo } from '@/utils/tracking'
import type { BarcodeWorkerRequest, BarcodeWorkerResponse } from './barcode.worker'

export const BARCODE_RECOGNITION_TIMEOUT_MS = 5_000
const MAX_DECODE_DIMENSION = 2_400
const MAX_DECODE_PIXELS = 3_000_000

// Only image loading and one bounded canvas copy happen on the UI thread.
// Decoder loops run in a disposable worker, so even a synchronous WASM/ZXing
// stall can be terminated without blocking photo staging or queue progress.
export async function recognizeTrackingNo(photo: Blob): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof Worker === 'undefined') return null

  return new Promise((resolve) => {
    let worker: Worker | null = null
    let image: HTMLImageElement | null = null
    let canvas: HTMLCanvasElement | null = null
    let imageUrl: string | null = null
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker?.terminate()
      if (image) {
        image.onload = null
        image.onerror = null
        image.removeAttribute('src')
      }
      if (imageUrl) URL.revokeObjectURL(imageUrl)
      if (canvas) { canvas.width = 1; canvas.height = 1 }
      resolve(value)
    }
    // Includes worker-script/WASM fetching and a stalled browser image load.
    const timer = setTimeout(() => finish(null), BARCODE_RECOGNITION_TIMEOUT_MS)

    try {
      worker = new Worker(new URL('./barcode.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<BarcodeWorkerResponse>) => {
        const value = event.data?.trackingNo
        finish(typeof value === 'string' && /^[A-Z0-9]{8,32}$/.test(value)
          && !/^(?:86)?1[3-9]\d{9}$/.test(value) && isPlausibleTrackingNo(value) ? value : null)
      }
      worker.onerror = () => finish(null)
      worker.onmessageerror = () => finish(null)

      image = new Image()
      image.onload = () => {
        if (settled || !image || !worker) return
        try {
          const width = image.naturalWidth
          const height = image.naturalHeight
          if (!width || !height) { finish(null); return }
          const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(width, height), Math.sqrt(MAX_DECODE_PIXELS / (width * height)))
          canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.floor(width * scale))
          canvas.height = Math.max(1, Math.floor(height * scale))
          const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
          if (!context) { finish(null); return }
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
          const buffer = pixels.data.buffer as ArrayBuffer
          const request: BarcodeWorkerRequest = { width: canvas.width, height: canvas.height, buffer }
          worker.postMessage(request, [buffer])
          // Decoding no longer needs the original image or the canvas backing store.
          image.onload = null
          image.onerror = null
          image.removeAttribute('src')
          if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null }
          canvas.width = 1; canvas.height = 1
        } catch { finish(null) }
      }
      image.onerror = () => finish(null)
      imageUrl = URL.createObjectURL(photo)
      image.src = imageUrl
    } catch { finish(null) }
  })
}
