// Parser de GPU% (ticket 021).
//
// Fuente primaria (confirmada en este device): `cat /sys/kernel/gpu/gpu_busy` → "99 %".
// (kgsl gpubusy y mali0/device/utilization fallan en el A15 → N/A esas rutas; ver research §5.)
//
// El collector (sampler) probará la ruta; este parser solo extrae el entero del output.

export function parseGpu(raw: string): number | null {
  const s = raw.trim()
  // ".err.txt" típico: "cat: ...: No such file or directory" → no numérico → null.
  const m = s.match(/^(\d+)\s*%?/)
  if (!m || m[1] === undefined) return null
  const v = Number(m[1])
  if (!Number.isFinite(v)) return null
  return Math.max(0, Math.min(100, v))
}
