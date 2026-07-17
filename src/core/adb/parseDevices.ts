import type { AdbDevice } from './AdbTransport'

/** Parsea el output de `adb devices -l`. Función pura, testeada contra fixtures. */
export function parseDevices(raw: string): AdbDevice[] {
  const devices: AdbDevice[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue
    const match = trimmed.match(/^(\S+)\s+(\S+)\s*(.*)$/)
    if (!match) continue
    const [, serial, state, description] = match
    devices.push({ serial: serial!, state: state!, description: description ?? '' })
  }
  return devices
}
