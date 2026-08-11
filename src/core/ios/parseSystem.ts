// Parser de `pymobiledevice3 developer dvt sysmon system` (ticket 038): datos del DEVICE,
// no del proceso. Salida en líneas `clave: valor`.
//
// De acá sale el total de RAM del sistema, que es lo que el dashboard necesita para las
// barras de memoria (sin él, "app of device RAM" no tiene denominador).

/** Datos del device que expone sysmontap a nivel sistema. */
export interface IosSystemInfo {
  /** RAM física total en MB. */
  ramTotalMb: number | null
  /** cores de CPU habilitados. */
  cores: number | null
}

/**
 * Tamaño de página en arm64 de Apple. `physMemSize` viene en PÁGINAS, no en bytes:
 * 360717 páginas × 16 KB = 5,5 GiB, que es la RAM del iPhone 14 Pro Max (6 GB
 * comerciales). Con 4 KB daría 1,4 GB, que no corresponde a ningún iPhone — por eso se
 * puede afirmar el tamaño de página en vez de suponerlo.
 */
const PAGE_BYTES = 16 * 1024
const BYTES_TO_MB = 1 / (1024 * 1024)

function readNumber(text: string, key: string): number | null {
  const m = new RegExp(`^${key}:\\s*(-?[\\d.]+)\\s*$`, 'm').exec(text)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

export function parseIosSystem(stdout: string): IosSystemInfo {
  const pages = readNumber(stdout, 'physMemSize')
  return {
    ramTotalMb: pages === null ? null : Math.round(pages * PAGE_BYTES * BYTES_TO_MB),
    cores: readNumber(stdout, 'EnabledCPUs') ?? readNumber(stdout, 'CPUCount'),
  }
}
