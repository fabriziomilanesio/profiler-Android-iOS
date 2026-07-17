// Parser de CPU% del proceso (ticket 021).
//
// Fuente primaria (confirmada): deltas entre dos snapshots de
//   /proc/<pid>/stat  (campos 14 utime + 15 stime, en clock ticks)
//   /proc/stat        (línea "cpu ..." = total de ticks de todos los cores)
//
//   CPU%_device = Δ(utime+stime) / Δ(total_ticks) × 100   → 0–100, ya normalizado por cores.
//
// Ojo (research §3): el campo 2 (comm) va entre paréntesis y puede contener espacios
// y paréntesis → parsear los campos numéricos DESPUÉS del último ')'.
// USER_HZ=100 y ncores no hacen falta para el share-of-device (se cancelan en el ratio).

/** utime+stime en ticks desde /proc/<pid>/stat, o null si no parsea. */
function pidCpuTicks(pidStat: string): number | null {
  const close = pidStat.lastIndexOf(')')
  if (close < 0) return null
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
  return u + s
}

/** total de ticks de la línea "cpu ..." de /proc/stat, o null. */
function totalCpuTicks(cpuStat: string): number | null {
  const line = cpuStat.split('\n').find((l) => /^cpu\s/.test(l))
  if (!line) return null
  // Solo los primeros 8 campos (user nice system idle iowait irq softirq steal):
  // guest/guest_nice ya están incluidos dentro de user/nice — sumarlos los duplica.
  const nums = line.trim().split(/\s+/).slice(1, 9).map(Number)
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) return null
  return nums.reduce((a, b) => a + b, 0)
}

export interface CpuSnapshot {
  pidStat: string
  cpuStat: string
}

/** % de CPU del proceso (share-of-device 0–100) entre dos snapshots. null si no parsea. */
export function parseCpu(prev: CpuSnapshot, next: CpuSnapshot): number | null {
  const prevPid = pidCpuTicks(prev.pidStat)
  const nextPid = pidCpuTicks(next.pidStat)
  const prevTotal = totalCpuTicks(prev.cpuStat)
  const nextTotal = totalCpuTicks(next.cpuStat)
  if (prevPid === null || nextPid === null || prevTotal === null || nextTotal === null) return null

  const dProc = nextPid - prevPid
  const dTotal = nextTotal - prevTotal
  if (dTotal <= 0) return dProc <= 0 ? 0 : null
  const pct = (dProc / dTotal) * 100
  // acotar por seguridad numérica (jitter de sampling puede dar leve <0 o >100)
  return Math.max(0, Math.min(100, pct))
}
