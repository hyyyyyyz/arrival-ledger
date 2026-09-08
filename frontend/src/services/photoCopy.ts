export const PHOTO_COPY_TIMEOUT_MS = 15_000

// Detach from the camera/file picker before clearing its input or retaining a
// photo across page suspension. Blob([file]) alone may keep the disk reference.
export async function copyPhoto(file: File): Promise<File> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const bytes = await Promise.race([file.arrayBuffer(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取照片超时，请从相册重新选择；已有待上传照片不会删除')), PHOTO_COPY_TIMEOUT_MS)
    })])
    if (!bytes.byteLength || bytes.byteLength !== file.size) throw new Error('照片未读取完整，请从相册重新选择')
    return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified })
  } finally { if (timer) clearTimeout(timer) }
}
