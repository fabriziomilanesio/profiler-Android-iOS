// Guardias anti-divergencia de los espejos de la UI (review 024-027, hallazgo #2).
//
// La UI es JS plano servido estático (sin bundler), así que dos piezas del core
// viven espejadas a mano y podían divergir en silencio:
//  - render.js#fpsStatusOf espeja src/core/perf/threshold.ts#fpsStatus (el
//    semáforo del ticket 025) — a diferencia de logsCore.js (patrón UMD, un solo
//    origen), acá son 6 líneas y el espejo es más barato que otro archivo UMD;
//  - index.html hardcodea min/max del input del target, espejo de
//    FPS_TARGET_MIN/MAX de appStore.ts.
// Estos tests leen los archivos como TEXTO y comparan contra el core: si alguien
// toca un lado y no el otro, rompen acá con el diff a la vista.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FPS_TARGET_MAX, FPS_TARGET_MIN } from '../core/appStore'
import type { LogEntry } from '../core/logs/logEntry'
import { CRASH_BLOCK_GAP_MS, crashBlocks } from '../core/logs/reportLogs'
import { FPS_YELLOW_RATIO, fpsStatus } from '../core/perf/threshold'

const UI = import.meta.dir

describe('espejos de la UI vs core', () => {
  test('fpsStatusOf de render.js coincide con fpsStatus del core (tabla de casos)', () => {
    const renderSrc = readFileSync(join(UI, 'render.js'), 'utf8')
    const m = /function fpsStatusOf\(fps, target\) \{[\s\S]*?\n {2}\}/.exec(renderSrc)
    // si esto falla, la función se movió/renombró: actualizar la extracción
    expect(m).not.toBeNull()
    const mirrored = new Function(`return ${m![0]}`)() as typeof fpsStatus

    const fpsCases = [
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1, // basura del parser ⇒ null, no rojo
      0, // app congelada: dato real ⇒ rojo
      23.9,
      24, // borde: exactamente 80% del target 30 ⇒ amarillo
      29.9,
      30, // borde: igual al target ⇒ verde
      47.9,
      48,
      60,
      240,
      30 * FPS_YELLOW_RATIO,
    ]
    const targetCases = [30, 60, 90, 120, 1, 240, 0, -30, Number.NaN, Number.POSITIVE_INFINITY]
    for (const target of targetCases) {
      for (const fps of fpsCases) {
        expect(mirrored(fps, target)).toBe(fpsStatus(fps, target))
      }
    }
  })

  test('min/max del input del target en index.html == FPS_TARGET_MIN/MAX del core', () => {
    const html = readFileSync(join(UI, 'index.html'), 'utf8')
    const m = /<input id="cfgFps"[^>]*\bmin="(\d+)"[^>]*\bmax="(\d+)"/.exec(html)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(FPS_TARGET_MIN)
    expect(Number(m![2])).toBe(FPS_TARGET_MAX)
  })

  // live.js y template.js son JS plano servido estático: no pueden importar el
  // core TS, así que hardcodean el gap de bloque de crash. Esta guardia rompe
  // si el core cambia y algún espejo queda atrás.
  test('CRASH_BLOCK_GAP_MS hardcodeado en live.js y template.js == core', () => {
    for (const file of [join(UI, 'live.js'), join(UI, '..', 'report', 'template.js')]) {
      const src = readFileSync(file, 'utf8')
      const m = /var CRASH_BLOCK_GAP_MS = (\d+)/.exec(src)
      expect(m).not.toBeNull()
      expect(Number(m![1])).toBe(CRASH_BLOCK_GAP_MS)
    }
  })

  // Fix de la review final del rediseño (I1): tras el fix de tombstones un crash
  // NATIVO llega con DOS pids (la línea "F libc" con el pid de la app, los frames
  // del tombstone con el pid de crash_dump64). El live tiene que contarlo como UN
  // solo crash, igual que crashBlocks del reporte (gap ≤ 2 s, sin mirar pid).
  test('scanLogSignals de live.js: crash nativo con dos pids = 1 solo bloque (== crashBlocks)', () => {
    const liveSrc = readFileSync(join(UI, 'live.js'), 'utf8')
    const m =
      /var CRASH_BLOCK_GAP_MS = \d+[\s\S]*?function scanLogSignals\(entries\) \{[\s\S]*?\n {2}\}/.exec(
        liveSrc,
      )
    // si esto falla, el bloque se movió/renombró: actualizar la extracción
    expect(m).not.toBeNull()
    const crashes: number[] = []
    const gcs: number[] = []
    const install = new Function('ProfilerDashboard', `${m![0]}\nreturn scanLogSignals`)
    const scan = install({
      noteCrash: (ts: number) => crashes.push(ts),
      noteGc: (ts: number) => gcs.push(ts),
    }) as (entries: LogEntry[]) => void

    const T0 = 1_700_000_000_000
    const entry = (offsetMs: number, pid: number, tag: string, message: string): LogEntry => ({
      ts: T0 + offsetMs,
      level: 'F',
      tag,
      message,
      pid,
      source: 'logcat',
      isCrash: true,
    })
    // secuencia real de crash nativo: F libc con el pid de la app, después los
    // frames del tombstone con el pid de crash_dump64 — mismo bloque temporal
    const nativeCrash = [
      entry(0, 1234, 'libc', 'Fatal signal 11 (SIGSEGV), code 1, fault addr 0x0 in tid 1234'),
      entry(150, 31337, 'DEBUG', '*** *** *** *** Crash dump: pid 1234, tid 1234'),
      entry(300, 31337, 'DEBUG', 'backtrace: #00 pc 00000000 /system/lib64/libc.so'),
    ]
    scan(nativeCrash)
    expect(crashes).toHaveLength(1)
    // espejo exacto del criterio del reporte
    expect(crashBlocks(nativeCrash)).toHaveLength(1)
    // un crash posterior fuera del gap sí cuenta como bloque nuevo
    scan([entry(60_000, 1234, 'libc', 'Fatal signal 6 (SIGABRT) in tid 1234')])
    expect(crashes).toHaveLength(2)
    expect(gcs).toHaveLength(0)
  })
})
