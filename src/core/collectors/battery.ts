// Parser de batería (ticket 021).
//
// Fuente (confirmada, siempre disponible): `dumpsys battery` →
//   level: 99            → %
//   temperature: 257     → ÷10 = 25.7 °C
//   current now: 587     → mA (signo/OEM varía; en Samsung positivo mientras carga)
//   AC/USB/wireless powered: true → charging (no hay drenaje real, reportarlo pero no romper)
import type { BatterySample } from '../schema'

function intField(raw: string, label: string): number | null {
  const m = raw.match(new RegExp(`^\\s*${label}:\\s*(-?\\d+)`, 'im'))
  if (!m || m[1] === undefined) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

function boolField(raw: string, label: string): boolean {
  const m = raw.match(new RegExp(`^\\s*${label}:\\s*(true|false)`, 'im'))
  return m?.[1] === 'true'
}

export function parseBattery(raw: string): BatterySample {
  const levelPct = intField(raw, 'level')
  const tempRaw = intField(raw, 'temperature')
  const mA = intField(raw, 'current now')

  // charging = enchufado por cualquier vía. Si ninguna línea *powered* existe, null.
  const hasPowered = /\b(AC|USB|Wireless) powered:/i.test(raw)
  const charging = hasPowered
    ? boolField(raw, 'AC powered') ||
      boolField(raw, 'USB powered') ||
      boolField(raw, 'Wireless powered')
    : null

  return {
    levelPct,
    tempC: tempRaw === null ? null : tempRaw / 10,
    mA,
    charging,
  }
}
