// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BARCODE_RECOGNITION_TIMEOUT_MS, recognizeTrackingNo } from './barcode'
import { decodeBarcode, isOneDimensionalSymbol, renderVariant, rgbaToLuminance, trackingCandidate } from './barcode.worker'
import type { BarcodeWorkerRequest, BarcodeWorkerResponse } from './barcode.worker'

const zbar = vi.hoisted(() => ({
  scanner: { setConfig: vi.fn() },
  getDefaultScanner: vi.fn(),
  scanRGBABuffer: vi.fn(),
}))

vi.mock('@undecaf/zbar-wasm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@undecaf/zbar-wasm')>(),
  getDefaultScanner: zbar.getDefaultScanner,
  scanRGBABuffer: zbar.scanRGBABuffer,
}))

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<BarcodeWorkerResponse>) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
}

class FakeImage {
  static instances: FakeImage[] = []
  naturalWidth = 4_000
  naturalHeight = 3_000
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  removeAttribute = vi.fn()
  constructor() { FakeImage.instances.push(this) }
}

describe('bounded off-main-thread barcode recognition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWorker.instances = []
    FakeImage.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:barcode-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('terminates a worker that never answers, releasing the recognition promise', async () => {
    const result = recognizeTrackingNo(new Blob(['photo']))
    FakeImage.instances[0]?.onload?.()
    expect(FakeWorker.instances[0]?.postMessage).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(BARCODE_RECOGNITION_TIMEOUT_MS)
    await expect(result).resolves.toBeNull()
    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it('includes a stalled image load in the same deadline and cancels its handlers', async () => {
    const result = recognizeTrackingNo(new Blob(['photo']))
    const image = FakeImage.instances[0]
    await vi.advanceTimersByTimeAsync(BARCODE_RECOGNITION_TIMEOUT_MS)
    await expect(result).resolves.toBeNull()
    expect(image?.onload).toBeNull()
    expect(image?.onerror).toBeNull()
    expect(image?.removeAttribute).toHaveBeenCalledWith('src')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:barcode-test')
    expect(FakeWorker.instances[0]?.postMessage).not.toHaveBeenCalled()
    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce()
  })

  it('transfers one capped pixel buffer and cleans up after a valid result', async () => {
    const result = recognizeTrackingNo(new Blob(['photo']))
    FakeImage.instances[0]?.onload?.()
    const worker = FakeWorker.instances[0]
    const [request, transfer] = worker?.postMessage.mock.calls[0] as [BarcodeWorkerRequest, ArrayBuffer[]]
    expect(request.width).toBeLessThanOrEqual(2_400)
    expect(request.height).toBeLessThanOrEqual(2_400)
    expect(request.width * request.height).toBeLessThanOrEqual(3_000_000)
    expect(request.buffer.byteLength).toBe(request.width * request.height * 4)
    expect(transfer).toEqual([request.buffer])
    worker?.onmessage?.({ data: { trackingNo: 'SF1234567890' } } as MessageEvent<BarcodeWorkerResponse>)
    await expect(result).resolves.toBe('SF1234567890')
    expect(worker?.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses a fresh worker after a prior attempt times out', async () => {
    const first = recognizeTrackingNo(new Blob(['one']))
    FakeImage.instances[0]?.onload?.()
    await vi.advanceTimersByTimeAsync(BARCODE_RECOGNITION_TIMEOUT_MS)
    await expect(first).resolves.toBeNull()
    const second = recognizeTrackingNo(new Blob(['two']))
    FakeImage.instances[1]?.onload?.()
    FakeWorker.instances[1]?.onmessage?.({ data: { trackingNo: 'YT9876543210' } } as MessageEvent<BarcodeWorkerResponse>)
    await expect(second).resolves.toBe('YT9876543210')
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true)
  })

  it.each(['onerror', 'onmessageerror'] as const)('degrades safely on worker %s', async (event) => {
    const result = recognizeTrackingNo(new Blob(['photo']))
    FakeWorker.instances[0]?.[event]?.()
    await expect(result).resolves.toBeNull()
    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('degrades safely when CSP rejects worker construction', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('CSP blocked') } })
    await expect(recognizeTrackingNo(new Blob(['photo']))).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns null without decoding on browsers without workers', async () => {
    vi.stubGlobal('Worker', undefined)
    await expect(recognizeTrackingNo(new Blob(['photo']))).resolves.toBeNull()
    expect(FakeImage.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['13800138000', 'https://parcel/12345678', 'NOTATRACKINGNUMBER'])('rejects unusable worker output %s', async (trackingNo) => {
    const result = recognizeTrackingNo(new Blob(['photo']))
    FakeWorker.instances[0]?.onmessage?.({ data: { trackingNo } } as MessageEvent<BarcodeWorkerResponse>)
    await expect(result).resolves.toBeNull()
    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce()
  })
})

describe('worker-only barcode pixel transforms and result filters', () => {
  const image: BarcodeWorkerRequest = {
    width: 2, height: 3,
    buffer: new Uint8ClampedArray([1, 2, 3, 4, 5, 6].flatMap((value) => [value, value, value, 255])).buffer,
  }
  const pixels = (variant: BarcodeWorkerRequest): number[] => [...new Uint8ClampedArray(variant.buffer)].filter((_value, index) => index % 4 === 0)

  beforeEach(() => {
    vi.clearAllMocks()
    zbar.getDefaultScanner.mockResolvedValue(zbar.scanner)
    zbar.scanRGBABuffer.mockResolvedValue([])
  })

  it('uses ZBar first, discarding QR hits even when their text looks like a tracking ID', async () => {
    zbar.scanRGBABuffer.mockResolvedValue([
      { type: 64, decode: () => 'QR1234567890' },
      { type: 128, decode: () => 'SF1234567890' },
    ])
    await expect(decodeBarcode(image)).resolves.toBe('SF1234567890')
    expect(zbar.scanRGBABuffer).toHaveBeenCalledOnce()
    expect(zbar.scanRGBABuffer.mock.calls[0]?.slice(1, 3)).toEqual([2, 3])
  })

  it('rejects malformed or oversized pixel requests before loading a decoder', async () => {
    await expect(decodeBarcode({ width: 2, height: 3, buffer: new ArrayBuffer(4) })).resolves.toBeNull()
    await expect(decodeBarcode({ width: 4_000, height: 4_000, buffer: new ArrayBuffer(4) })).resolves.toBeNull()
    expect(zbar.getDefaultScanner).not.toHaveBeenCalled()
  })

  it('decodes a synthetic Code 39 fixture through real ZXing when WASM is unavailable', async () => {
    zbar.getDefaultScanner.mockRejectedValue(new Error('WASM blocked'))
    // Standard Code 39 patterns for *SF1234567890*, with quiet zones. This
    // generated fixture contains no real label, address, or customer data.
    const encodings = [0x094, 0x046, 0x058, 0x121, 0x061, 0x160, 0x031, 0x130, 0x070, 0x025, 0x124, 0x064, 0x034, 0x094]
    const row: number[] = Array<number>(40).fill(255)
    for (const encoding of encodings) {
      for (let bit = 8; bit >= 0; bit--) {
        const width = encoding & (1 << bit) ? 6 : 2
        row.push(...Array<number>(width).fill(bit % 2 === 0 ? 0 : 255))
      }
      row.push(255, 255)
    }
    row.push(...Array<number>(40).fill(255))
    const height = 80
    const rgba = new Uint8ClampedArray(row.length * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < row.length; x++) {
        const at = (y * row.length + x) * 4
        const value = y >= 8 && y < height - 8 ? row[x] ?? 255 : 255
        rgba[at] = value; rgba[at + 1] = value; rgba[at + 2] = value; rgba[at + 3] = 255
      }
    }
    await expect(decodeBarcode({ width: row.length, height, buffer: rgba.buffer })).resolves.toBe('SF1234567890')
    expect(zbar.scanRGBABuffer).not.toHaveBeenCalled()
  })

  it('rotates rectangular images by 90 and 270 degrees without losing pixels', () => {
    const clockwise = renderVariant(image, { x: 0, y: 0, width: 1, height: 1, rotation: 90 })
    const counterclockwise = renderVariant(image, { x: 0, y: 0, width: 1, height: 1, rotation: 270 })
    expect([clockwise.width, clockwise.height]).toEqual([3, 2])
    expect(pixels(clockwise)).toEqual([5, 3, 1, 6, 4, 2])
    expect(pixels(counterclockwise)).toEqual([2, 4, 6, 1, 3, 5])
  })

  it('crops an edge strip within the original bounds', () => {
    const cropped = renderVariant(image, { x: 0.5, y: 1 / 3, width: 0.5, height: 2 / 3, rotation: 0 })
    expect([cropped.width, cropped.height]).toEqual([1, 2])
    expect(pixels(cropped)).toEqual([4, 6])
  })

  it('converts RGBA to one luminance byte per pixel for ZXing', () => {
    const buffer = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]).buffer
    expect([...rgbaToLuminance(buffer)]).toEqual([64, 128, 64])
  })

  it('filters QR/2-D symbologies, URLs and obvious mainland mobile numbers', () => {
    expect(isOneDimensionalSymbol(128)).toBe(true)
    expect(isOneDimensionalSymbol(39)).toBe(true)
    for (const type of [64, 57, 80, 0]) expect(isOneDimensionalSymbol(type)).toBe(false)
    expect(trackingCandidate('sf-1234567890')).toBe('SF1234567890')
    for (const raw of ['https://parcel/12345678', '13800138000', '8613800138000', 'tel:13800138000', 'NO-DIGITS']) {
      expect(trackingCandidate(raw)).toBeNull()
    }
  })
})
