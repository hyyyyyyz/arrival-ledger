import type { CompressedImage } from '@/types'

const DEFAULT_MAX_DIMENSION = 1800
const DEFAULT_QUALITY = 0.82

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  dispose: () => void
}

async function decodeWithImageBitmap(file: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap !== 'function') return null

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    }
  } catch {
    return null
  }
}

function decodeWithImageElement(file: Blob): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        dispose: () => URL.revokeObjectURL(url),
      })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取这张照片，请重新拍摄'))
    }
    image.src = url
  })
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('照片压缩失败'))
      }, 'image/jpeg', quality)
    })
  }

  const dataUrl = canvas.toDataURL('image/jpeg', quality)
  const [header, body] = dataUrl.split(',')
  if (!header || !body) throw new Error('照片压缩失败')
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return Promise.resolve(new Blob([bytes], { type: 'image/jpeg' }))
}

export async function compressImage(
  file: File,
  maxDimension = DEFAULT_MAX_DIMENSION,
  quality = DEFAULT_QUALITY,
): Promise<CompressedImage> {
  const decoded = (await decodeWithImageBitmap(file)) ?? (await decodeWithImageElement(file))

  try {
    const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('当前浏览器无法处理照片')

    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(decoded.source, 0, 0, width, height)

    const blob = await canvasToJpeg(canvas, quality)
    canvas.width = 1
    canvas.height = 1

    return {
      blob,
      width,
      height,
      originalBytes: file.size,
      compressedBytes: blob.size,
    }
  } finally {
    decoded.dispose()
  }
}
