import { getDefaultScanner, scanRGBABuffer, ZBarConfigType, ZBarSymbolType } from '@undecaf/zbar-wasm'
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from '@zxing/library'
import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

export interface BarcodeWorkerRequest { width: number; height: number; buffer: ArrayBuffer }
export interface BarcodeWorkerResponse { trackingNo: string | null }
interface VariantSpec {
  x: number; y: number; width: number; height: number
  rotation: 0 | 90 | 270
  threshold?: number
}

const VARIANTS: VariantSpec[] = [
  { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  { x: 0, y: 0.04, width: 1, height: 0.52, rotation: 0 },
  { x: 0, y: 0.10, width: 1, height: 0.36, rotation: 0, threshold: 158 },
  { x: 0.08, y: 0.08, width: 0.84, height: 0.84, rotation: 0, threshold: 170 },
  { x: 0, y: 0, width: 1, height: 1, rotation: 90 },
  { x: 0, y: 0, width: 1, height: 1, rotation: 270 },
  { x: 0.52, y: 0.26, width: 0.46, height: 0.58, rotation: 90, threshold: 160 },
]

const ZBAR_FORMATS = new Set<ZBarSymbolType>([
  ZBarSymbolType.ZBAR_CODE128, ZBarSymbolType.ZBAR_CODE39, ZBarSymbolType.ZBAR_CODE93,
  ZBarSymbolType.ZBAR_CODABAR, ZBarSymbolType.ZBAR_I25, ZBarSymbolType.ZBAR_EAN13,
  ZBarSymbolType.ZBAR_EAN8, ZBarSymbolType.ZBAR_UPCA, ZBarSymbolType.ZBAR_UPCE,
  ZBarSymbolType.ZBAR_DATABAR, ZBarSymbolType.ZBAR_DATABAR_EXP,
])
const ZXING_FORMATS = [
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.CODABAR,
  BarcodeFormat.ITF, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E, BarcodeFormat.RSS_14, BarcodeFormat.RSS_EXPANDED,
]

export function trackingCandidate(raw: string): string | null {
  // Do not normalize a QR URL/contact payload into a plausible-looking ID.
  if (!/^[A-Za-z0-9 -]{8,40}$/.test(raw.trim())) return null
  const normalized = normalizeTrackingNo(raw)
  if (/^(?:86)?1[3-9]\d{9}$/.test(normalized)) return null
  return isPlausibleTrackingNo(normalized) ? normalized : null
}

export function isOneDimensionalSymbol(type: number): boolean {
  return ZBAR_FORMATS.has(type)
}

// Pure RGBA transforms: no DOM, OffscreenCanvas, or browser-reader dependency.
export function renderVariant(image: BarcodeWorkerRequest, spec: VariantSpec): BarcodeWorkerRequest {
  const source = new Uint8ClampedArray(image.buffer)
  const width = Math.max(1, Math.round(image.width * spec.width))
  const height = Math.max(1, Math.round(image.height * spec.height))
  const left = Math.min(image.width - width, Math.max(0, Math.round(image.width * spec.x)))
  const top = Math.min(image.height - height, Math.max(0, Math.round(image.height * spec.y)))
  const outWidth = spec.rotation ? height : width
  const outHeight = spec.rotation ? width : height
  const pixels = new Uint8ClampedArray(outWidth * outHeight * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceAt = ((y + top) * image.width + x + left) * 4
      const outX = spec.rotation === 90 ? height - 1 - y : spec.rotation === 270 ? y : x
      const outY = spec.rotation === 90 ? x : spec.rotation === 270 ? width - 1 - x : y
      const outAt = (outY * outWidth + outX) * 4
      if (spec.threshold !== undefined) {
        const luminance = ((source[sourceAt] ?? 0) + 2 * (source[sourceAt + 1] ?? 0) + (source[sourceAt + 2] ?? 0)) / 4
        const value = (luminance - 128) * 1.85 + 128 < spec.threshold ? 0 : 255
        pixels[outAt] = value; pixels[outAt + 1] = value; pixels[outAt + 2] = value
      } else {
        pixels[outAt] = source[sourceAt] ?? 0
        pixels[outAt + 1] = source[sourceAt + 1] ?? 0
        pixels[outAt + 2] = source[sourceAt + 2] ?? 0
      }
      pixels[outAt + 3] = 255
    }
  }
  return { width: outWidth, height: outHeight, buffer: pixels.buffer }
}

export function rgbaToLuminance(buffer: ArrayBuffer): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(buffer)
  const luminance = new Uint8ClampedArray(pixels.length / 4)
  for (let i = 0; i < luminance.length; i++) {
    luminance[i] = ((pixels[i * 4] ?? 0) + 2 * (pixels[i * 4 + 1] ?? 0) + (pixels[i * 4 + 2] ?? 0)) / 4
  }
  return luminance
}

export async function decodeBarcode(image: BarcodeWorkerRequest): Promise<string | null> {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 1 || image.height < 1 || image.width * image.height > 3_000_000
    || image.buffer.byteLength !== image.width * image.height * 4) return null
  const startedAt = Date.now()
  let scannerTimer: ReturnType<typeof setTimeout> | undefined
  try {
    // A missing/blocked WASM response must leave time for the JS fallback.
    const scanner = await Promise.race([
      getDefaultScanner(),
      new Promise<null>((resolve) => { scannerTimer = setTimeout(() => resolve(null), 900) }),
    ])
    if (scanner) {
      scanner.setConfig(ZBarSymbolType.ZBAR_NONE, ZBarConfigType.ZBAR_CFG_ENABLE, 0)
      for (const format of ZBAR_FORMATS) scanner.setConfig(format, ZBarConfigType.ZBAR_CFG_ENABLE, 1)
      for (const spec of VARIANTS) {
        if (Date.now() - startedAt > 2_500) break
        const variant = renderVariant(image, spec)
        const symbols = await scanRGBABuffer(variant.buffer, variant.width, variant.height, scanner)
        const values = new Set(symbols.filter((symbol) => isOneDimensionalSymbol(symbol.type))
          .map((symbol) => trackingCandidate(symbol.decode())).filter((value): value is string => value !== null))
        if (values.size === 1) return values.values().next().value ?? null
      }
    }
  } catch { /* Optional WASM unavailable; use ZXing in this same worker. */ }
  finally { if (scannerTimer !== undefined) clearTimeout(scannerTimer) }

  const reader = new MultiFormatReader()
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS],
    [DecodeHintType.TRY_HARDER, true],
  ])
  reader.setHints(hints)
  try {
    for (const spec of VARIANTS) {
      if (Date.now() - startedAt > 4_500) break
      const variant = renderVariant(image, spec)
      try {
        const source = new RGBLuminanceSource(rgbaToLuminance(variant.buffer), variant.width, variant.height)
        const result = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)))
        if (!ZXING_FORMATS.includes(result.getBarcodeFormat())) continue
        const value = trackingCandidate(result.getText())
        if (value) return value
      } catch { /* No usable 1-D barcode in this bounded pass. */ }
    }
  } finally { reader.reset() }
  return null
}

// The document guard lets unit tests import the pure transforms in a DOM test
// environment without installing worker message handlers on window.
if (typeof document === 'undefined' && typeof self !== 'undefined') {
  const workerScope = self as unknown as {
    onmessage: ((event: MessageEvent<BarcodeWorkerRequest>) => void) | null
    postMessage: (response: BarcodeWorkerResponse) => void
  }
  workerScope.onmessage = (event) => {
    void decodeBarcode(event.data).then(
      (trackingNo) => workerScope.postMessage({ trackingNo }),
      () => workerScope.postMessage({ trackingNo: null }),
    )
  }
}
