// Parser de CPU% del proceso (ticket 021) + CPU% total del device.
//
// Fuente primaria (confirmada): deltas entre dos snapshots de
//   /proc/<pid>/stat  (campos 14 utime + 15 stime, en clock ticks) — uno por proceso
//   /proc/stat        (línea "cpu ..." = total de ticks de todos los cores)
//
//   CPU%_device = Δ(utime+stime) / Δ(total_ticks) × 100   → 0–100, ya normalizado por cores.
//
// Multi-proceso: un package puede correr procesos hijos (`pkg:servicio`). El snapshot
// lleva N líneas de /proc/<pid>/stat y el CPU% de la app es la suma de los deltas,
// emparejando por pid (un hijo que nace/muere entre snapshots no aporta delta).
//
// Ojo (research §3): el campo 2 (comm) va entre paréntesis y puede contener espacios
// y paréntesis → parsear los campos numéricos DESPUÉS del último ')'.
// USER_HZ=100 y ncores no hacen falta para el share-of-device (se cancelan en el ratio).

/** {pid, utime+stime en ticks} desde una línea de /proc/<pid>/stat, o null si no parsea. */
function pidCpuTicks(pidStat: string): { pid: number; ticks: number } | null {
  const close = pidStat.lastIndexOf(')')
  if (close < 0) return null
  const pid = Number(pidStat.slice(0, pidStat.indexOf(' ')))
  if (!Number.isFinite(pid)) return null
  // Tras el ')' vienen: state(3) ppid(4) ... utime(14) stime(15) ...
  // Al hacer split de lo que sigue al ')', el primer token es el campo 3 (state),
  // así que utime = índice 11, stime = índice 12 (0-based) en ese sub-array.
  const rest = pidStat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const utime = rest[11]
  const stime = rest[12]
  if (utime === undefined || stime === undefined) return null
  const u = Number(utime)
  const s = Number(stime)
  if (!Number.isFinite(u) || !Number.isFinite(s)) return null
  return { pid, ticks: u + s }
}

/** {total, idle} de ticks de la línea "cpu ..." de /proc/stat, o null. */
function cpuLineTicks(cpuStat: string): { total: number; idle: number } | null {
  const line = cpuStat.split('\n').find((l) => /^cpu\s/.test(l))
  if (!line) return null
  // Solo los primeros 8 campos (user nice system idle iowait irq softirq steal):
  // guest/guest_nice ya están incluidos dentro de user/nice — sumarlos los duplica.
  const nums = line.trim().split(/\s+/).slice(1, 9).map(Number)
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) return null
  const total = nums.reduce((a, b) => a + b, 0)
  // idle = idle + iowait (índices 3 y 4 tras el label)
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0)
  return { total, idle }
}

export interface CpuSnapshot {
  /** líneas de /proc/<pid>/stat, una por proceso del package (main + hijos) */
  pidStats: string[]
  cpuStat: string
}

/** Suma de ticks por pid → mapa pid→ticks (los que no parsean se saltean). */
function ticksByPid(pidStats: string[]): Map<number, number> {
  const map = new Map<number, number>()
  for (const line of pidStats) {
    const parsed = pidCpuTicks(line)
    if (parsed) map.set(parsed.pid, parsed.ticks)
  }
  return map
}

/**
 * % de CPU de la app (share-of-device 0–100) entre dos snapshots: suma de los
 * deltas de todos los pids presentes en AMBOS snapshots. null si no parsea.
 */
export function parseCpu(prev: CpuSnapshot, next: CpuSnapshot): number | null {
  const prevTicks = ticksByPid(prev.pidStats)
  const nextTicks = ticksByPid(next.pidStats)
  const prevTotal = cpuLineTicks(prev.cpuStat)
  const nextTotal = cpuLineTicks(next.cpuStat)
  if (prevTicks.size === 0 || nextTicks.size === 0 || !prevTotal || !nextTotal) return null

  let dProc = 0
  let matched = false
  for (const [pid, ticks] of nextTicks) {
    const before = prevTicks.get(pid)
    if (before === undefined) continue // hijo nuevo: sin delta este tick
    matched = true
    dProc += ticks - before
  }
  if (!matched) return null

  const dTotal = nextTotal.total - prevTotal.total
  if (dTotal <= 0) return dProc <= 0 ? 0 : null
  const pct = (dProc / dTotal) * 100
  // acotar por seguridad numérica (jitter de sampling puede dar leve <0 o >100)
  return Math.max(0, Math.min(100, pct))
}

/** % de CPU total del device (todos los procesos, 0–100) entre dos snapshots. */
export function parseDeviceCpu(prev: CpuSnapshot, next: CpuSnapshot): number | null {
  const a = cpuLineTicks(prev.cpuStat)
  const b = cpuLineTicks(next.cpuStat)
  if (!a || !b) return null
  const dTotal = b.total - a.total
  if (dTotal <= 0) return 0
  const dBusy = dTotal - (b.idle - a.idle)
  return Math.max(0, Math.min(100, (dBusy / dTotal) * 100))
}
