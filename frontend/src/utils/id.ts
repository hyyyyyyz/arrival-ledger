const DEVICE_ID_KEY = 'arrival-manager-device-id'

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const random = Math.random().toString(36).slice(2)
  return `${Date.now().toString(36)}-${random}-${Math.random().toString(36).slice(2)}`
}

export function getDeviceId(): string {
  const stored = localStorage.getItem(DEVICE_ID_KEY)
  if (stored) return stored

  const deviceId = createId()
  localStorage.setItem(DEVICE_ID_KEY, deviceId)
  return deviceId
}
