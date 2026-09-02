import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

const ZXING_FORMAT_NAMES = [
  'CODE_128', 'CODE_39', 'CODE_93', 'CODABAR', 'ITF',
  'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'RSS_14', 'RSS_EXPANDED',
] as const
const NATIVE_FORMAT_NAMES = [
  'code_128', 'code_39', 'code_93', 'codabar', 'itf',
  'ean_13', 'ean_8', 'upc_a', 'upc_e', 'rss_14', 'rss_expanded',
] as const
const MAX_DECODE_DIMENSION = 2400

type NativeBarcodeDetector = { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>> }
type NativeBarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): NativeBarcodeDetector
  getSupportedFormats?: () => Promise<string[]>
}
interface LoadedImage { source: CanvasImageSource; width: number; height: number; dispose: () => void }
interface VariantSpec { x: number; y: number; width: number; height: number; rotation: 0 | 90 | 270; enhance: boolean }

// The first two passes are fast. Extra passes are bounded fallbacks for
// angled photos or labels where the barcode occupies only a narrow band.
const VARIANT_SPECS: VariantSpec[] = [
  { x: 0, y: 0, width: 1, height: 1, rotation: 0, enhance: false },
  { x: 0, y: 0.18, width: 1, height: 0.64, rotation: 0, enhance: false },
  { x: 0.08, y: 0.08, width: 0.84, height: 0.84, rotation: 0, enhance: true },
  { x: 0, y: 0, width: 1, height: 1, rotation: 90, enhance: false },
  { x: 0, y: 0, width: 1, height: 1, rotation: 270, enhance: false },
]

function plausibleResult(raw: string | undefined): string | null {
  if (!raw) return null
  const normalized = normalizeTrackingNo(raw)
  return isPlausibleTrackingNo(normalized) ? normalized : null
}

async function loadImage(photo: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(photo, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() }
    } catch {
      try {
        const bitmap = await createImageBitmap(photo)
        return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() }
      } catch { /* use Image below */ }
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(photo)
    const image = new Image()
    image.onload = () => resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, dispose: () => URL.revokeObjectURL(url) })
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取照片')) }
    image.src = url
  })
}

function enhanceContrast(context: CanvasRenderingContext2D, width: number, height: number): void {
  const imageData = context.getImageData(0, 0, width, height)
  for (let i = 0; i < imageData.data.length; i += 4) {
    const luminance = 0.299 * (imageData.data[i] ?? 0) + 0.587 * (imageData.data[i + 1] ?? 0) + 0.114 * (imageData.data[i + 2] ?? 0)
    const value = Math.max(0, Math.min(255, (luminance - 128) * 1.65 + 128))
    imageData.data[i] = value; imageData.data[i + 1] = value; imageData.data[i + 2] = value
  }
  context.putImageData(imageData, 0, 0)
}

function renderVariant(image: LoadedImage, spec: VariantSpec): HTMLCanvasElement {
  const cropWidth = Math.max(1, Math.round(image.width * spec.width))
  const cropHeight = Math.max(1, Math.round(image.height * spec.height))
  const cropX = Math.min(image.width - cropWidth, Math.max(0, Math.round(image.width * spec.x)))
  const cropY = Math.min(image.height - cropHeight, Math.max(0, Math.round(image.height * spec.y)))
  const scale = Math.min(1.5, MAX_DECODE_DIMENSION / Math.max(cropWidth, cropHeight))
  const width = Math.max(1, Math.round(cropWidth * scale))
  const height = Math.max(1, Math.round(cropHeight * scale))
  const rotated = spec.rotation === 90 || spec.rotation === 270
  const canvas = document.createElement('canvas')
  canvas.width = rotated ? height : width
  canvas.height = rotated ? width : height
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: spec.enhance })
  if (!context) throw new Error('当前浏览器无法处理照片')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.save(); context.translate(canvas.width / 2, canvas.height / 2)
  context.rotate((spec.rotation * Math.PI) / 180)
  context.drawImage(image.source, cropX, cropY, cropWidth, cropHeight, -width / 2, -height / 2, width, height)
  context.restore()
  if (spec.enhance) enhanceContrast(context, canvas.width, canvas.height)
  return canvas
}

async function nativeDetector(): Promise<NativeBarcodeDetector | null> {
  if (typeof window === 'undefined') return null
  const ctor = (window as Window & { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector
  if (!ctor) return null
  try {
    const supported = ctor.getSupportedFormats ? await ctor.getSupportedFormats() : [...NATIVE_FORMAT_NAMES]
    const formats = NATIVE_FORMAT_NAMES.filter((format) => supported.includes(format))
    return formats.length ? new ctor({ formats }) : null
  } catch { return null }
}

async function zxingReader(): Promise<{ decodeFromCanvas: (canvas: HTMLCanvasElement) => { getText: () => string } } | null> {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'), import('@zxing/library'),
  ])
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMAT_NAMES.map((name) => BarcodeFormat[name]))
  hints.set(DecodeHintType.TRY_HARDER, true)
  return new BrowserMultiFormatReader(hints)
}

async function decodeVariants(photo: Blob): Promise<string | null> {
  const image = await loadImage(photo)
  const [detector, reader] = await Promise.all([nativeDetector(), zxingReader()])
  const candidates = new Map<string, number>()
  try {
    for (const spec of VARIANT_SPECS) {
      const canvas = renderVariant(image, spec)
      try {
        if (detector) {
          for (const barcode of await detector.detect(canvas)) {
            const value = plausibleResult(barcode.rawValue)
            if (value) candidates.set(value, (candidates.get(value) ?? 0) + 2)
          }
        }
        if (reader) {
          try {
            const value = plausibleResult(reader.decodeFromCanvas(canvas).getText())
            if (value) candidates.set(value, (candidates.get(value) ?? 0) + 1)
          } catch { /* no barcode in this pass */ }
        }
      } finally { canvas.width = 1; canvas.height = 1 }
      // A native hit is reliable; return without paying for the slower crops.
      const best = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0]
      if (best && best[1] >= 2) return best[0]
    }
    const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1])
    if (!ranked[0] || ranked[1]?.[1] === ranked[0][1]) return null
    return ranked[0][0]
  } finally { image.dispose() }
}

export async function recognizeTrackingNo(photo: Blob): Promise<string | null> {
  try {
    if (typeof document !== 'undefined' && typeof Image !== 'undefined') return await decodeVariants(photo)
  } catch { /* recognition must never block photo upload */ }
  return null
}
