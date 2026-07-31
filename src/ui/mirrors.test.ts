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
})
