// Ficha del device iOS (ticket 038): arma un `DeviceInfo` — el mismo tipo que usa
// Android — a partir de lo que ya devolvió `usbmux list`.
//
// No hace falta un comando extra: la descripción que produjo `parseIosDevices` ya trae
// modelo, versión y build. Los campos que en iOS no tienen equivalente quedan null y la
// UI los esconde por capabilities.
import type { AdbDevice } from '../adb/AdbTransport'
import type { DeviceInfo } from '../schema'

/**
 * Mapea el device de la lista a la ficha del dashboard.
 *
 * `androidRelease` se reusa para la versión de iOS a propósito: es el campo "versión del
 * SO" del schema y renombrarlo obligaría a migrar todas las sesiones grabadas. La UI lo
 * etiqueta según `platform`.
 */
export function iosDeviceInfo(device: AdbDevice): DeviceInfo {
  const model = match(device.description, /model:(\S+)/)
  const iosVersion = match(device.description, /ios:(\S+)/)
  return {
    serial: device.serial,
    platform: 'ios',
    model,
    manufacturer: 'Apple',
    androidRelease: iosVersion,
    apiLevel: null,
    // El SoC se puede inferir del ProductType, pero sería una tabla hardcodeada que
    // envejece con cada modelo nuevo. Mejor null honesto que un mapeo que miente.
    soc: null,
    gpu: null,
    ramTotalMb: null,
    cores: null,
    // Los iPhone con ProMotion cambian el refresh dinámicamente (LTPO); no hay un valor
    // fijo que reportar, y en iOS no se usa para jank porque no hay frame-times.
    refreshHz: null,
  }
}

/** Un proceso vivo del device, tal como lo lista `pymobiledevice3 processes ps`. */
export interface IosProcess {
  pid: number
  name: string
}

/**
 * Resuelve el proceso de una app a partir de su bundle id.
 *
 * iOS 26 no expone `bundleIdentifier` entre los atributos de sysmontap (spike 033), así
 * que el filtro va por NOMBRE de proceso — y ese nombre no se puede derivar del bundle:
 * `com.evermoregames.evermorearcade` corre como `EvermoreArcade`, con mayúsculas que el
 * bundle id no tiene. Adivinarlo daría `Evermorearcade` y no matchearía nunca.
 *
 * `executable` es el CFBundleExecutable del Info.plist y es el dato EXACTO: el binario se
 * llama igual que el proceso. Cuando está, manda. La heurística del último segmento del
 * bundle id queda sólo como fallback, y es realmente una heurística: para
 * `com.github.stormbreaker.prod` daba "prod" y no enganchaba nunca el proceso `GitHub`,
 * dejando la app elegida sin CPU ni memoria (verificado contra el iPhone real).
 *
 * En ambos caminos se prefiere el match exacto-sin-case sobre el que sólo contiene el
 * término, para no engancharse con un daemon del sistema que comparta prefijo.
 */
export function resolveIosProcess(
  processes: IosProcess[],
  bundleId: string,
  executable?: string | null,
): IosProcess | null {
  if (executable) {
    const exec = executable.toLowerCase()
    const byExec = processes.find((p) => p.name.toLowerCase() === exec)
    if (byExec) return byExec
    // sysmontap trunca los nombres largos (vimos "AppPredictionIntentsHelperServi"), así
    // que un prefijo del ejecutable también cuenta como match.
    const byPrefix = processes.find(
      (p) => p.name !== '' && exec.startsWith(p.name.toLowerCase()) && p.name.length >= 8,
    )
    if (byPrefix) return byPrefix
  }
  const target = (bundleId.split('.').filter(Boolean).pop() ?? bundleId).toLowerCase()
  if (target === '') return null
  const exact = processes.find((p) => p.name.toLowerCase() === target)
  if (exact) return exact
  return processes.find((p) => p.name.toLowerCase().includes(target)) ?? null
}

/** Parsea la salida JSON de `pymobiledevice3 processes ps` (mapa pid → {ProcessName}). */
export function parseIosProcesses(stdout: string): IosProcess[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return []
  }
  if (raw === null || typeof raw !== 'object') return []
  const out: IosProcess[] = []
  for (const [pid, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(pid)
    if (!Number.isFinite(n)) continue
    const name = (value as { ProcessName?: unknown })?.ProcessName
    if (typeof name === 'string' && name !== '') out.push({ pid: n, name })
  }
  return out
}

function match(text: string, re: RegExp): string | null {
  const m = text.match(re)
  return m?.[1] ?? null
}
