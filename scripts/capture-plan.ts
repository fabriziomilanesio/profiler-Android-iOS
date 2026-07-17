// Plan de captura de fixtures del device real (ticket 001) — lógica PURA.
// Acá vive todo lo testeable sin device: sanitización de nombres, armado del
// plan de comandos (one-shot y por tick de sesión), parsing de getprop,
// descubrimiento del layer del SurfaceView y generación del README.
// El script `capture-fixtures.ts` ejecuta este plan contra un AdbTransport real.
//
// Fuentes primaria/fallback por métrica: docs/research/dumpsys-formats.md.

export interface CaptureStep {
  /** nombre del archivo destino (relativo al dir de la captura), ej. 'dumpsys-meminfo.txt' */
  file: string
  /** comando a correr vía `adb shell` */
  cmd: string
}

/** 'Pixel 7 Pro' → 'pixel-7-pro'. Vacío/no-sanitizable → 'unknown-device'. */
export function sanitizeDirName(model: string): string {
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'unknown-device'
}

/** Nombre del dir de fixtures: `<modelo-sanitizado>-api<NN>`. */
export function fixtureDirName(model: string, apiLevel: string): string {
  const api = apiLevel.trim() || 'unknown'
  return `${sanitizeDirName(model)}-api${api}`
}

/** Parsea el output de `getprop` (`[key]: [value]`) a un mapa plano. */
export function parseGetprop(raw: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]\s*$/.exec(line.trim())
    if (m) props[m[1]!] = m[2]!
  }
  return props
}

/**
 * Rutas sysfs de GPU% a probar EN ORDEN (docs/research/dumpsys-formats.md §5):
 * kgsl (Qualcomm) → gpu_busy_percentage → Samsung unificado → Mali utilization.
 * Cada una puede fallar según SoC/OEM — el fallo también es dato (fixture .err.txt).
 */
export const GPU_PROBES = [
  { file: 'gpu-kgsl-gpubusy', path: '/sys/class/kgsl/kgsl-3d0/gpubusy' },
  { file: 'gpu-kgsl-gpu-busy-percentage', path: '/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage' },
  { file: 'gpu-samsung-gpu-busy', path: '/sys/kernel/gpu/gpu_busy' },
  { file: 'gpu-mali-utilization', path: '/sys/class/misc/mali0/device/utilization' },
] as const

/** Primera ruta GPU legible según los resultados del probing one-shot; null = N/A. */
export function pickGpuPath(results: Array<{ path: string; ok: boolean }>): string | null {
  for (const probe of GPU_PROBES) {
    const result = results.find((r) => r.path === probe.path)
    if (result?.ok) return probe.path
  }
  return null
}

/** Plan ONE-SHOT: cada output crudo tal cual — son fixtures de los parsers. */
export function oneshotPlan(pkg: string, pid: string): CaptureStep[] {
  return [
    { file: 'getprop.txt', cmd: 'getprop' },
    { file: 'proc-meminfo.txt', cmd: 'cat /proc/meminfo' },
    { file: 'dumpsys-meminfo.txt', cmd: `dumpsys meminfo ${pkg}` },
    { file: 'dumpsys-cpuinfo.txt', cmd: 'dumpsys cpuinfo' },
    { file: 'top.txt', cmd: 'top -b -n 1' },
    { file: 'proc-pid-stat.txt', cmd: `cat /proc/${pid}/stat` },
    { file: 'proc-stat.txt', cmd: 'cat /proc/stat' },
    { file: 'dumpsys-thermalservice.txt', cmd: 'dumpsys thermalservice' },
    // Batería: level %, temperature (÷10 °C), current now (mA), status — sin root
    { file: 'dumpsys-battery.txt', cmd: 'dumpsys battery' },
    { file: 'thermal-zones-ls.txt', cmd: 'ls /sys/class/thermal/' },
    // grep . file1 file2… imprime `ruta:valor` por línea → conserva el pairing zona↔valor
    { file: 'thermal-zone-types.txt', cmd: 'grep . /sys/class/thermal/thermal_zone*/type' },
    { file: 'thermal-zone-temps.txt', cmd: 'grep . /sys/class/thermal/thermal_zone*/temp' },
    // Probing GPU: listados + lecturas; los que fallen quedan como .err.txt (es dato: N/A del device)
    { file: 'gpu-kgsl-ls.txt', cmd: 'ls /sys/class/kgsl/kgsl-3d0/' },
    { file: 'gpu-samsung-ls.txt', cmd: 'ls /sys/kernel/gpu/' },
    { file: 'gpu-mali-ls.txt', cmd: 'ls /sys/class/misc/mali0/device/' },
    ...GPU_PROBES.map((p) => ({ file: `${p.file}.txt`, cmd: `cat ${p.path}` })),
    { file: 'dumpsys-netstats.txt', cmd: 'dumpsys netstats detail' },
    { file: 'surfaceflinger-list.txt', cmd: 'dumpsys SurfaceFlinger --list' },
    // gfxinfo NO ve frames de Unity — se captura igual para documentar que viene vacío
    { file: 'gfxinfo-framestats.txt', cmd: `dumpsys gfxinfo ${pkg} framestats` },
    { file: 'surfaceflinger-gles.txt', cmd: 'dumpsys SurfaceFlinger | grep -i gles' },
  ]
}

/**
 * Plan de UN TICK de sesión (1 Hz). `/proc/stat` + `/proc/<pid>/stat` van en una
 * sola llamada (mismo instante → delta de CPU coherente, como hará el collector).
 * `gpuPath` sale de `pickGpuPath` sobre el probing one-shot; null ⇒ sin GPU en ticks.
 */
export function tickPlan(pkg: string, pid: string, gpuPath: string | null): CaptureStep[] {
  return [
    { file: 'meminfo.txt', cmd: `dumpsys meminfo ${pkg}` },
    { file: 'proc-stat.txt', cmd: `cat /proc/stat /proc/${pid}/stat` },
    { file: 'thermalservice.txt', cmd: 'dumpsys thermalservice' },
    { file: 'battery.txt', cmd: 'dumpsys battery' },
    ...(gpuPath ? [{ file: 'gpubusy.txt', cmd: `cat ${gpuPath}` }] : []),
    { file: 'netstats.txt', cmd: 'dumpsys netstats detail' },
  ]
}

/**
 * Encuentra el layer del SurfaceView de la app en `dumpsys SurfaceFlinger --list`.
 * API 31+ (BLAST): `SurfaceView[com.pkg/Activity]@0(BLAST)#123` · API 26–30:
 * `SurfaceView - com.pkg/Activity#0`. Preferí la línea con 'SurfaceView' + pkg;
 * fallback: cualquier línea que mencione el pkg.
 */
export function findSurfaceViewLayer(listOutput: string, pkg: string): string | null {
  const lines = listOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const surfaceView = lines.find((l) => l.includes('SurfaceView') && l.includes(pkg))
  if (surfaceView) return surfaceView
  return lines.find((l) => l.includes(pkg)) ?? null
}

export interface DeviceInfo {
  model: string
  brand: string
  manufacturer: string
  androidVersion: string
  apiLevel: string
  soc: string
  gpu: string
  serial: string
}

/** Extrae la ficha del device desde getprop + la línea GLES de SurfaceFlinger. */
export function deviceInfoFromProps(
  props: Record<string, string>,
  serial: string,
  glesLine: string,
): DeviceInfo {
  const socParts = [props['ro.soc.manufacturer'], props['ro.soc.model']].filter(Boolean)
  const soc =
    socParts.length > 0
      ? socParts.join(' ')
      : (props['ro.board.platform'] ?? props['ro.hardware'] ?? 'desconocido')
  // `grep -i gles` también matchea el header decorativo "---RE GLES (Ganesh)---":
  // quedarse con la línea GLES: real.
  const gles = glesLine
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^GLES:/i.test(l))
  return {
    model: props['ro.product.model'] ?? 'desconocido',
    brand: props['ro.product.brand'] ?? 'desconocido',
    manufacturer: props['ro.product.manufacturer'] ?? 'desconocido',
    androidVersion: props['ro.build.version.release'] ?? '?',
    apiLevel: props['ro.build.version.sdk'] ?? '?',
    soc,
    gpu: gles
      ? gles.replace(/^GLES:\s*/i, '')
      : 'desconocida (falló dumpsys SurfaceFlinger | grep GLES)',
    serial,
  }
}

export interface CaptureSummary {
  pkg: string
  /** fecha ISO de la captura */
  date: string
  sessionSeconds: number
  ticks: number
  gpuPath: string | null
  layer: string | null
  /** líneas ya formateadas: comando/archivo → por qué falló */
  failures: string[]
}

/** README.md del dir de fixtures: ficha del device + qué comandos fallaron (los N/A). */
export function buildReadme(info: DeviceInfo, summary: CaptureSummary): string {
  const failuresSection =
    summary.failures.length === 0
      ? 'Ninguno — todo capturado.'
      : summary.failures.map((f) => `- ${f}`).join('\n')
  return `# Fixtures: ${info.model} (API ${info.apiLevel})

Outputs **crudos** de adb, sin procesar — capturados con \`bun scripts/capture-fixtures.ts\`
(ticket 001). Son la fuente de verdad de los parsers (tests capa 1) y el material de
replay de fake-adb. No editar a mano.

## Device

| Campo | Valor |
|---|---|
| Modelo | ${info.model} |
| Marca / fabricante | ${info.brand} / ${info.manufacturer} |
| Android | ${info.androidVersion} (API ${info.apiLevel}) |
| SoC | ${info.soc} |
| GPU | ${info.gpu} |
| Serial | ${info.serial} |
| Fecha de captura | ${summary.date} |
| Package medido | ${summary.pkg} |

## Estructura

- \`oneshot/\` — una pasada de cada comando (getprop, meminfo, cpuinfo, top, proc, thermal, GPU probing, netstats, SurfaceFlinger, gfxinfo).
- \`session/tick-NNN/\` — sesión de ${summary.sessionSeconds} s a 1 Hz mientras se jugaba (${summary.ticks} ticks: meminfo, proc-stat, thermal, gpubusy, netstats).
- \`session/final/\` — \`SurfaceFlinger --timestats -dump\` + \`--latency\` del layer del SurfaceView al cierre.
- Fuente GPU% elegida: ${summary.gpuPath ?? 'ninguna legible — GPU% es N/A en este device'}.
- Layer SurfaceFlinger de la app: ${summary.layer ? `\`${summary.layer}\`` : 'no encontrado en --list'}.

## Comandos que fallaron (los N/A de este device)

Los \`.err.txt\` guardan exit code + stderr: también son fixtures — los parsers deben
tratar estos casos como "métrica no disponible", no como error fatal.

${failuresSection}
`
}
