import type { UploadQueueItem } from '@/types'
import { compressImage } from './image'
import { recognizeTrackingNo } from './barcode'

export const PHOTO_PREPARATION_TIMEOUT_MS = 20_000

// Late browser callbacks return values only; they cannot overwrite queue state.
export async function preparePhoto(item: UploadQueueItem): Promise<UploadQueueItem> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fallback: UploadQueueItem = { ...item, needsPreparation: false, readyToUpload: true,
    barcodeState: item.trackingNo ? item.barcodeState : 'NOT_FOUND' }
  const work = async (): Promise<UploadQueueItem> => {
    let compressed
    try { compressed = await compressImage(item.photo) } catch { return fallback }
    let trackingNo = item.trackingNo
    if (!trackingNo) {
      try { trackingNo = await recognizeTrackingNo(item.photo) } catch { /* server can recognize the saved photo */ }
    }
    return { ...fallback, photo: compressed.blob, fileName: `arrival-${item.clientEventId}.jpg`,
      trackingNo, barcodeState: trackingNo ? (item.trackingNo ? item.barcodeState : 'FOUND') : 'NOT_FOUND' }
  }
  try {
    return await Promise.race([work(), new Promise<UploadQueueItem>((resolve) => {
      timer = setTimeout(() => resolve(fallback), PHOTO_PREPARATION_TIMEOUT_MS)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
