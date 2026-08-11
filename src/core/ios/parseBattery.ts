// Parser de `pymobiledevice3 diagnostics battery monitor` (ticket 038).
//
// Es un canal LOCKDOWN, no DTX: no depende del túnel ni del DDI, emite un JSON por línea
// a 1 Hz y es de los más baratos del stack. Mapea casi 1:1 contra el `BatterySample` que
// Android arma con `dumpsys battery`.
import type { BatterySample } from '../schema'

/**
 * Unidades verificadas contra el device real (iPhone15,3):
 *
 *   {"InstantAmperage": -186, "Temperature": 2989, "Voltage": 4340,
 *    "IsCharging": false, "CurrentCapacity": 100}
 *
 * - `Temperature` en **centi-°C** (2989 → 29,89 °C). Android usa deci-°C, así que la
 *   conversión NO es la misma; usar la de Android daría 298,9 °C.
 *   ⚠️ Es temperatura **de la batería**, no del SoC. El `tempC` térmico de Android no
 *   tiene equivalente en iOS y queda null (ver capabilities).
 * - `CurrentCapacity` en **porcentaje** (0–100), no en mAh.
 * - `InstantAmperage` en mA, con el mismo criterio de signo que Android (negativo drena).
 */
const CENTI_C = 1 / 100

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function parseBatteryLine(line: string): BatterySample | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
  // Una muestra de batería siempre trae al menos la capacidad; si no, es otro mensaje.
  if (!('CurrentCapacity' in obj) && !('InstantAmperage' in obj)) return null

  const tempCenti = num(obj['Temperature'])
  return {
    levelPct: num(obj['CurrentCapacity']),
    tempC: tempCenti === null ? null : tempCenti * CENTI_C,
    mA: num(obj['InstantAmperage']),
    charging: typeof obj['IsCharging'] === 'boolean' ? obj['IsCharging'] : null,
  }
}
