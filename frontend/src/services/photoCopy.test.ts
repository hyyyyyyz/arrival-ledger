import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyPhoto, PHOTO_COPY_TIMEOUT_MS } from './photoCopy'

afterEach(() => { vi.useRealTimers() })

describe('camera file byte detachment', () => {
  it('copies actual bytes before releasing the picker file and preserves metadata', async () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 2])
    const original = new File([bytes], 'label.jpg', { type: 'image/jpeg', lastModified: 123 })
    const copied = await copyPhoto(original)
    expect(copied).not.toBe(original)
    expect(copied.name).toBe(original.name)
    expect(copied.lastModified).toBe(123)
    expect(copied.type).toBe('image/jpeg')
    expect(new Uint8Array(await copied.arrayBuffer())).toEqual(bytes)
  })

  it('rejects empty or partially readable photos instead of claiming a safe save', async () => {
    await expect(copyPhoto(new File([], 'empty.jpg'))).rejects.toThrow('未读取完整')
    const original = new File(['full image'], 'partial.jpg')
    vi.spyOn(original, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(1))
    await expect(copyPhoto(original)).rejects.toThrow('未读取完整')
  })

  it('bounds a stalled picker file read even if the browser never resolves it', async () => {
    vi.useFakeTimers()
    const original = new File(['image'], 'stalled.jpg')
    vi.spyOn(original, 'arrayBuffer').mockReturnValue(new Promise(() => undefined))
    const result = expect(copyPhoto(original)).rejects.toThrow('读取照片超时')
    await vi.advanceTimersByTimeAsync(PHOTO_COPY_TIMEOUT_MS)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })
})
