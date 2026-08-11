// Parser de `pymobiledevice3 usbmux list` (ticket 035): el análogo iOS de
// `src/core/adb/parseDevices.ts`.
//
// Devuelve el MISMO shape que `AdbDevice` a propósito. La UI ya sabe pintar esa forma
// (lista, estado, descripción con `model:`), así que un iPhone entra a la lista de devices
// sin que el dashboard tenga que aprender nada nuevo — sólo lee el `platform` para la
// etiqueta. Es la costura del 035 en su punto más barato.
import type { AdbDevice } from '../adb/AdbTransport'

/** Un device tal como lo reporta usbmux. Todos los campos pueden faltar. */
export interface UsbmuxEntry {
  Identifier?: string
  UniqueDeviceID?: string
  DeviceName?: string
  DeviceClass?: string
  ProductType?: string
  ProductVersion?: string
  BuildVersion?: string
  ConnectionType?: string
}

/**
 * El mismo device aparece MÁS DE UNA VEZ cuando está por USB y por wifi a la vez (lo vimos
 * en el spike 033: dos entradas con el mismo UDID). Se deduplica por UDID prefiriendo la
 * entrada USB, que es la que sirve para profilear.
 */
export function parseIosDevices(stdout: string): AdbDevice[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return []
  }
  const entries: UsbmuxEntry[] = Array.isArray(raw)
    ? (raw as UsbmuxEntry[])
    : raw !== null && typeof raw === 'object'
      ? [raw as UsbmuxEntry]
      : []

  const byUdid = new Map<string, UsbmuxEntry>()
  for (const e of entries) {
    const udid = e.Identifier ?? e.UniqueDeviceID
    if (udid === undefined || udid === '') continue
    const prev = byUdid.get(udid)
    // USB gana: es el transporte con el que se profilea.
    if (prev === undefined || (prev.ConnectionType !== 'USB' && e.ConnectionType === 'USB')) {
      byUdid.set(udid, e)
    }
  }

  return [...byUdid.entries()].map(([udid, e]) => ({
    serial: udid,
    // usbmux sólo lista devices ya pareados y alcanzables; no hay equivalente de
    // "unauthorized" como en adb. Si algún día lo hay, este es el lugar.
    state: 'device',
    description: describe(e),
    platform: 'ios' as const,
  }))
}

/**
 * Se imita el formato de `adb devices -l` (`model:X product:Y ...`) porque la UI ya
 * extrae `model:` de ahí para el label. Así el iPhone se etiqueta solo.
 */
function describe(e: UsbmuxEntry): string {
  const parts: string[] = []
  // ProductType (iPhone15,3) es el equivalente honesto de ro.product.model.
  if (e.ProductType !== undefined && e.ProductType !== '') {
    parts.push(`model:${e.ProductType.replace(/\s+/g, '_')}`)
  }
  if (e.ProductVersion !== undefined && e.ProductVersion !== '') {
    parts.push(`ios:${e.ProductVersion}`)
  }
  if (e.BuildVersion !== undefined && e.BuildVersion !== '') {
    parts.push(`build:${e.BuildVersion}`)
  }
  if (e.ConnectionType !== undefined && e.ConnectionType !== '') {
    parts.push(`transport:${e.ConnectionType}`)
  }
  // DeviceName NO se incluye: suele traer el nombre de la persona ("iPhone de Ignacio")
  // y esta descripción termina en sesiones y reportes que se comparten.
  return parts.join(' ')
}
