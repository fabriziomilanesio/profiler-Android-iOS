// Parser de FPS (ticket 021).
//
// Fuente primaria (confirmada, Unity): `dumpsys SurfaceFlinger --timestats -dump`
// → campo `averageFPS` del layer de la app (los buffers presentados que SurfaceFlinger
// sí ve; gfxinfo da 0 frames en Unity — NO usar). Ver research §2.
//
// OJO (bug real observado en device): el dump lista VARIOS layers (NotificationShade,
// StatusBar, el SurfaceView de la app…), cada uno con su `averageFPS`. Hay que quedarse
// con el averageFPS del bloque cuyo `layerName` matchea la SurfaceView del package,
// no con el primero. Si no se pasa package (o no matchea), cae al primer averageFPS.
//
// Requiere que timestats esté habilitado (Sampler.init hace `--timestats -enable`);
// si no hay frames presentándose (app idle/background) el layer no aparece → N/A.
//
// Fallback (research §2, NO implementado acá): `--latency '<layer>'`.
//
// Frame-times/jank (ticket 024): el MISMO dump trae, por layer, el histograma
// `present2present` (intervalo entre presents consecutivos, en ms) — la distribución
// de frame-times del último tick gratis, sin comandos nuevos. parseFrameStats saca
// de ahí p50/p90/p99 y el jank. Umbral de jank RELATIVO:
//   1. vsyncMs = 1000 / refreshHz real del panel (parseRefreshRate; cae a 60 Hz).
//   2. cadencia esperada de la app = p50 redondeado a vsyncs enteros (un juego a
//      30 FPS en un panel de 90 Hz presenta cada 3 vsyncs — eso NO es jank).
//   3. janky = frame que perdió ≥1 vsync sobre esa cadencia (intervalo > cadencia
//      + ½ vsync de tolerancia de cuantización).
// Nada de 16.6 ms hardcodeado: a 90 Hz el vsync es 11.1 ms, a 120 Hz 8.3 ms.
import type { FrameSample } from '../schema'

function firstAverageFps(text: string): number | null {
  const m = text.match(/averageFPS\s*=\s*([\d.]+)/)
  if (!m || m[1] === undefined) return null
  const fps = Number(m[1])
  return Number.isFinite(fps) ? fps : null
}

export function parseFps(timestatsDump: string, packageName?: string): number | null {
  if (packageName) {
    // Recorrer los bloques por layer; quedarnos con el averageFPS del que menciona el package.
    // El dump separa layers con líneas "layerName = ...". Partimos por esa marca.
    const blocks = timestatsDump.split(/^layerName\s*=\s*/m)
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i]!
      // la primera línea del bloque es el nombre del layer
      const layerLine = block.split('\n', 1)[0] ?? ''
      if (layerLine.includes(packageName)) {
        const fps = firstAverageFps(block)
        if (fps !== null) return fps
      }
    }
    // no encontramos el layer de la app (idle/background o dump legacy sin layers) → N/A
    // salvo que el dump NO tenga layers (formato "Legacy stats"): ahí cae al global.
    if (/^layerName\s*=/m.test(timestatsDump)) return null
  }
  return firstAverageFps(timestatsDump)
}

export const NULL_FRAME: FrameSample = {
  p50Ms: null,
  p90Ms: null,
  p99Ms: null,
  jankPct: null,
  jankFrames: null,
  totalFrames: null,
}

/**
 * Refresh rate del panel en Hz desde `dumpsys SurfaceFlinger --latency`: la primera
 * línea es el período de refresh en ns (11111111 → 90 Hz) y se imprime aun cuando
 * no se pasa layer (o no matchea) — por eso es la fuente estable para leerlo una
 * vez al conectar. null si el output no trae un período plausible.
 */
export function parseRefreshRate(latencyDump: string): number | null {
  const first = latencyDump.trim().split('\n', 1)[0] ?? ''
  const periodNs = Number(first.trim())
  if (!Number.isFinite(periodNs) || periodNs <= 0) return null
  const hz = 1e9 / periodNs
  // fuera de 10–1000 Hz no es un período de panel real (basura/valor centinela)
  if (hz < 10 || hz > 1000) return null
  return Math.round(hz)
}

/** Percentil desde el histograma: primer bucket cuyo acumulado cubre p (0–1). */
function histPercentile(buckets: Array<[number, number]>, total: number, p: number): number {
  const target = total * p
  let cum = 0
  for (const [ms, count] of buckets) {
    cum += count
    if (cum >= target) return ms
  }
  return buckets[buckets.length - 1]![0]
}

/** Frame stats desde el histograma present2present/presentToPresent de un bloque. */
function statsFromHistogram(text: string, vsyncMs: number): FrameSample | null {
  // per-layer: "present2present histogram" (¡no confundir con present2presentDelta!);
  // bloque global/legacy: "presentToPresent histogram". La línea siguiente trae los
  // buckets "0ms=0 1ms=38 ...", label = piso del bucket en ms (resolución 1–2 ms).
  const m = text.match(/present(?:2p|ToP)resent histogram is as below:\s*\r?\n([^\n]*)/)
  if (!m || m[1] === undefined) return null
  const buckets: Array<[number, number]> = []
  let total = 0
  for (const b of m[1].matchAll(/(\d+)ms=(\d+)/g)) {
    const count = Number(b[2])
    if (count > 0) {
      buckets.push([Number(b[1]), count])
      total += count
    }
  }
  if (total === 0) return null // histograma presente pero sin frames (app idle)
  buckets.sort((a, b) => a[0] - b[0])
  const p50 = histPercentile(buckets, total, 0.5)
  // cadencia propia de la app en vsyncs ENTEROS del panel real (mínimo 1)
  const expectedMs = Math.max(1, Math.round(p50 / vsyncMs)) * vsyncMs
  const jankThresholdMs = expectedMs + vsyncMs / 2
  let jankFrames = 0
  for (const [ms, count] of buckets) if (ms > jankThresholdMs) jankFrames += count
  return {
    p50Ms: p50,
    p90Ms: histPercentile(buckets, total, 0.9),
    p99Ms: histPercentile(buckets, total, 0.99),
    jankPct: (jankFrames / total) * 100,
    jankFrames,
    totalFrames: total,
  }
}

/**
 * Frame-time p50/p90/p99 (ms) y jank del layer de la app, desde el mismo dump de
 * timestats del tick. refreshHz = panel real (parseRefreshRate); null/invalid ⇒ 60.
 * Sin layer de la app (idle/background) o sin histograma ⇒ todo null, nunca throw.
 */
export function parseFrameStats(
  timestatsDump: string,
  packageName: string | undefined,
  refreshHz: number | null,
): FrameSample {
  const hz = refreshHz !== null && Number.isFinite(refreshHz) && refreshHz > 0 ? refreshHz : 60
  const vsyncMs = 1000 / hz
  if (packageName) {
    const blocks = timestatsDump.split(/^layerName\s*=\s*/m)
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i]!
      const layerLine = block.split('\n', 1)[0] ?? ''
      if (!layerLine.includes(packageName)) continue
      const stats = statsFromHistogram(block, vsyncMs)
      if (stats) return stats
    }
    // dump con layers pero ninguno de la app ⇒ N/A (igual que parseFps)
    if (/^layerName\s*=/m.test(timestatsDump)) return NULL_FRAME
  }
  // formato legacy sin layers (o sin package): histograma global presentToPresent
  return statsFromHistogram(timestatsDump, vsyncMs) ?? NULL_FRAME
}
