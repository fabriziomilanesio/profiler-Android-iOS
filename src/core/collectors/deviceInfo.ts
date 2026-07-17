// Parser de la ficha del device (ticket 021).
//
// Fuentes: getprop (model/release/sdk/soc/manufacturer) + MemTotal de /proc/meminfo.
// GPU: sacar el renderer REAL de la línea "GLES:" de `dumpsys SurfaceFlinger`
// (ej. "GLES: ARM, Mali-G57 MC2, OpenGL ES 3.2 ...") → "Mali-G57 MC2".
//
// BUG que arregla (README fixtures): antes el nombre de GPU capturaba
// "------RE GLES (Ganesh)------" del grep de SurfaceFlinger → basura. Ahora tomamos
// el renderer limpio de la línea GLES:, con fallback a getprop.
import type { DeviceInfo } from '../schema'

function getprop(raw: string, key: string): string | null {
  // formato: [ro.product.model]: [SM-A155M]
  const m = raw.match(new RegExp(`^\\[${key.replace(/\./g, '\\.')}\\]:\\s*\\[([^\\]]*)\\]`, 'm'))
  const v = m?.[1]?.trim()
  return v ? v : null
}

/** GPU renderer limpio desde la línea "GLES: <vendor>, <renderer>, <version>". */
function gpuFromSurfaceFlinger(raw: string): string | null {
  const m = raw.match(/^\s*GLES:\s*(.+)$/m)
  if (!m || m[1] === undefined) return null
  // "ARM, Mali-G57 MC2, OpenGL ES 3.2 v1..." → el renderer es el 2º campo separado por coma.
  const parts = m[1].split(',').map((p) => p.trim())
  const renderer = parts[1]
  if (!renderer) return null
  // descartar restos como "GLES (Ganesh)" / vacíos
  if (/^\(?GLES/i.test(renderer) || /Ganesh/i.test(renderer)) return null
  return renderer
}

export interface DeviceInfoInputs {
  getprop: string
  procMeminfo: string
  surfaceflingerGles: string
  serial: string
}

export function parseDeviceInfo(inputs: DeviceInfoInputs): DeviceInfo {
  const gp = inputs.getprop

  const model = getprop(gp, 'ro.product.model')
  const manufacturer = getprop(gp, 'ro.product.manufacturer')
  const androidRelease = getprop(gp, 'ro.build.version.release')
  const sdkStr = getprop(gp, 'ro.build.version.sdk')
  const apiLevel = sdkStr && Number.isFinite(Number(sdkStr)) ? Number(sdkStr) : null
  const soc = getprop(gp, 'ro.board.platform') ?? getprop(gp, 'ro.soc.model')

  // GPU: SurfaceFlinger GLES limpio → fallback a props de hardware (vulkan/egl).
  let gpu = gpuFromSurfaceFlinger(inputs.surfaceflingerGles)
  if (!gpu) {
    const vulkan = getprop(gp, 'ro.hardware.vulkan')
    // "mali"/"meow" no son nombres de GPU útiles; solo aceptar si parece un renderer real.
    if (vulkan && /mali|adreno|xclipse|powervr|immortalis/i.test(vulkan)) gpu = vulkan
  }

  // MemTotal:  3754184 kB
  const memMatch = inputs.procMeminfo.match(/^MemTotal:\s*(\d+)\s*kB/im)
  const ramTotalMb =
    memMatch && memMatch[1] !== undefined ? Math.round(Number(memMatch[1]) / 1024) : null

  return {
    serial: inputs.serial,
    model,
    manufacturer,
    androidRelease,
    apiLevel,
    soc,
    gpu,
    ramTotalMb,
  }
}
