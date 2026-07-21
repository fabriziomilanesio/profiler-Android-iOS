// RAM usada total del device desde /proc/meminfo (uso total del celular).
//
// used = MemTotal − MemAvailable. MemAvailable (kernel ≥3.14, todo Android moderno)
// es la estimación del kernel de cuánta RAM hay disponible sin swappear — mejor que
// MemFree, que ignora page cache recuperable. Valores en kB → devolvemos MB.

/** RAM usada del device en MB, o null si el dump no trae ambos campos. */
export function parseDeviceMemUsedMb(raw: string): number | null {
  const total = raw.match(/^MemTotal:\s*(\d+)\s*kB/im)
  const avail = raw.match(/^MemAvailable:\s*(\d+)\s*kB/im)
  if (!total || total[1] === undefined || !avail || avail[1] === undefined) return null
  const usedKb = Number(total[1]) - Number(avail[1])
  if (!Number.isFinite(usedKb) || usedKb < 0) return null
  return usedKb / 1024
}
