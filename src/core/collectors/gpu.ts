// GPU% en Android es best-effort: no existe una API pública y cada driver expone
// un sysfs distinto. El orden coincide con docs/research/dumpsys-formats.md §5.
export const GPU_SOURCES = [
  { path: '/sys/class/kgsl/kgsl-3d0/gpubusy', format: 'busy-total' },
  { path: '/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage', format: 'percent' },
  { path: '/sys/kernel/gpu/gpu_busy', format: 'percent' },
  { path: '/sys/class/misc/mali0/device/utilization', format: 'percent' },
] as const

export type GpuSource = (typeof GPU_SOURCES)[number]
export type GpuFormat = GpuSource['format']

export interface GpuWorkSnapshot {
  atMs: number
  /** Nanosegundos activos acumulados, por GPU y UID. */
  activeNs: Map<string, number>
}

/** Convierte la salida del sysfs del vendor a utilización 0–100. */
export function parseGpu(raw: string, format: GpuFormat = 'percent'): number | null {
  const s = raw.trim()

  if (format === 'busy-total') {
    // Qualcomm kgsl: ticks ocupados y ticks totales desde la lectura anterior.
    const m = s.match(/^(\d+)\s+(\d+)$/)
    if (!m || m[1] === undefined || m[2] === undefined) return null
    const busy = Number(m[1])
    const total = Number(m[2])
    if (!Number.isFinite(busy) || !Number.isFinite(total) || total < 0) return null
    // La primera lectura de kgsl puede devolver 0 0 si todavía no hubo ventana.
    // La fuente es válida: conservarla y reportar 0 hasta el próximo tick.
    if (total === 0) return busy === 0 ? 0 : null
    return clampPercent((busy / total) * 100)
  }

  // Samsung, kgsl reciente y Mali: entero/decimal, con '%' opcional.
  // Un error de cat no matchea y queda correctamente como N/A.
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/)
  if (!m || m[1] === undefined) return null
  const value = Number(m[1])
  return Number.isFinite(value) ? clampPercent(value) : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/**
 * Fallback Android estándar para devices cuyo sysfs está protegido (p. ej. Unisoc).
 * `dumpsys gpu` expone contadores acumulados por GPU/UID; hacen falta dos snapshots.
 */
export function parseGpuWorkSnapshot(raw: string, atMs: number): GpuWorkSnapshot | null {
  const lines = raw.split(/\r?\n/)
  const header = lines.findIndex((line) =>
    line.includes('gpu_id uid total_active_duration_ns total_inactive_duration_ns'),
  )
  if (header < 0) return null

  const activeNs = new Map<string, number>()
  for (const line of lines.slice(header + 1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/)
    if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      continue
    }
    const active = Number(match[3])
    if (Number.isFinite(active)) activeNs.set(`${match[1]}:${match[2]}`, active)
  }
  return { atMs, activeNs }
}

/** Utilización device-wide a partir del incremento de tiempo activo / tiempo de pared. */
export function gpuWorkUtilization(
  previous: GpuWorkSnapshot,
  current: GpuWorkSnapshot,
): number | null {
  const elapsedNs = (current.atMs - previous.atMs) * 1_000_000
  if (!Number.isFinite(elapsedNs) || elapsedNs <= 0) return null

  let activeDeltaNs = 0
  let comparableCounters = 0
  for (const [key, active] of current.activeNs) {
    const before = previous.activeNs.get(key)
    if (before === undefined) continue
    comparableCounters++
    if (active >= before) activeDeltaNs += active - before
  }
  if (comparableCounters === 0) return null
  return clampPercent((activeDeltaNs / elapsedNs) * 100)
}
