import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

export async function recognizeTrackingNo(photo: Blob): Promise<string | null> {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType, NotFoundException }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library'),
  ])
  const formats = [
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.CODE_93,
    BarcodeFormat.CODABAR,
    BarcodeFormat.ITF,
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.RSS_14,
    BarcodeFormat.RSS_EXPANDED,
  ]
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats)
  hints.set(DecodeHintType.TRY_HARDER, true)
  const url = URL.createObjectURL(photo)
  const reader = new BrowserMultiFormatReader(hints)

  try {
    const result = await reader.decodeFromImageUrl(url)
    const normalized = normalizeTrackingNo(result.getText())
    return isPlausibleTrackingNo(normalized) ? normalized : null
  } catch (error) {
    if (error instanceof NotFoundException || (error instanceof Error && error.name === 'NotFoundException')) {
      return null
    }
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
