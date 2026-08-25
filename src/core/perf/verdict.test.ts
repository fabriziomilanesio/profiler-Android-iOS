// Tests del veredicto de perf (ticket 026): series sintéticas por caso + el dump
// real del Galaxy A15 (fixtures/sm-a155m-api36) como fuente de un tick de frame real.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrameStats } from '../collectors/fps'
import {
  buildPerfVerdict,
  detectThrottling,
  redSpans,
  timeInTarget,
  worstWindows,
  THROTTLE_SUSTAIN_S,
  THROTTLE_TEMP_C,
  type VerdictPoint,
} from './verdict'

const T0 = 1_750_000_000_000

/** Punto sintético: 1 Hz, todo sano por default, overrides por caso. */
function pt(sec: number, over: Partial<VerdictPoint> = {}): VerdictPoint {
  return {
    ts: T0 + sec * 1000,
    fps: 30,
    jankPct: 0,
    gpu: 50,
    cpu: 40,
    tempC: 35,
    ...over,
  }
}

/** n puntos consecutivos desde startSec con el mismo override. */
function run(startSec: number, n: number, over: Partial<VerdictPoint> = {}): VerdictPoint[] {
  return Array.from({ length: n }, (_, i) => pt(startSec + i, over))
}

describe('timeInTarget', () => {
  test('reparte por semáforo ponderando por ticks con dato', () => {
    const points = [
      ...run(0, 6, { fps: 30 }), // verde
      ...run(6, 3, { fps: 25 }), // amarillo (≥ 80% de 30 = 24)
      ...run(9, 1, { fps: 10 }), // rojo
      pt(10, { fps: null }), // sin dato: no pondera
    ]
    const share = timeInTarget(points, 30)!
    expect(share.ticks).toBe(10)
    expect(share.greenPct).toBe(60)
    expect(share.yellowPct).toBe(30)
    expect(share.redPct).toBe(10)
  })

  test('sin ningún FPS ⇒ null (datos insuficientes, no 0% rojo)', () => {
    expect(timeInTarget(run(0, 5, { fps: null }), 30)).toBeNull()
    expect(timeInTarget([], 30)).toBeNull()
  })
})

describe('redSpans', () => {
  test('agrupa ticks rojos contiguos; un tick no-rojo o sin dato corta', () => {
    const points = [
      ...run(0, 3, { fps: 30 }),
      ...run(3, 4, { fps: 10 }), // rojo 3..6
      pt(7, { fps: null }), // corta
      ...run(8, 2, { fps: 12 }), // rojo 8..9
      pt(10, { fps: 30 }),
    ]
    const spans = redSpans(points, 30)
    expect(spans).toEqual([
      { startTs: T0 + 3000, endTs: T0 + 6000 },
      { startTs: T0 + 8000, endTs: T0 + 9000 },
    ])
  })

  test('todo verde ⇒ sin spans', () => {
    expect(redSpans(run(0, 10), 30)).toEqual([])
  })
})

describe('worstWindows', () => {
  test('encuentra el bajón como peor tramo, con contexto GPU/CPU/temp', () => {
    const points = [
      ...run(0, 60),
      ...run(60, 20, { fps: 12, jankPct: 40, gpu: 95, cpu: 80, tempC: 44 }), // el bajón
      ...run(80, 60),
    ]
    const wins = worstWindows(points, 30)
    expect(wins.length).toBeGreaterThan(0)
    const w = wins[0]!
    // la peor ventana cae dentro/alrededor del bajón (60s..80s)
    expect(w.startTs).toBeGreaterThanOrEqual(T0 + 45_000)
    expect(w.startTs).toBeLessThanOrEqual(T0 + 80_000)
    expect(w.score).toBeGreaterThan(0)
    expect(w.avgFps!).toBeLessThan(30)
    expect(w.minFps).toBe(12)
    expect(w.avgGpu!).toBeGreaterThan(50)
    expect(w.avgTempC!).toBeGreaterThan(35)
  })

  test('las ventanas elegidas no se solapan y son máximo N', () => {
    const points = [
      ...run(0, 40),
      ...run(40, 10, { fps: 5 }),
      ...run(50, 40),
      ...run(90, 10, { fps: 8 }),
      ...run(100, 40),
      ...run(140, 10, { fps: 11 }),
      ...run(150, 40),
      ...run(190, 10, { fps: 14 }),
      ...run(200, 40),
    ]
    const wins = worstWindows(points, 30)
    expect(wins.length).toBe(3)
    // ordenadas por score descendente y sin solaparse
    for (let i = 1; i < wins.length; i++) {
      expect(wins[i]!.score).toBeLessThanOrEqual(wins[i - 1]!.score)
    }
    for (const a of wins) {
      for (const b of wins) {
        if (a === b) continue
        expect(a.startTs > b.endTs || a.endTs < b.startTs).toBe(true)
      }
    }
  })

  test('ventana 100% en target ⇒ score 0 ⇒ no aparece', () => {
    expect(worstWindows(run(0, 120, { fps: 60, jankPct: 0 }), 30)).toEqual([])
  })

  test('sesión vieja sin frame-time: el score degrada a solo-FPS', () => {
    const points = [...run(0, 60, { jankPct: null }), ...run(60, 15, { fps: 10, jankPct: null })]
    const wins = worstWindows(points, 30)
    expect(wins.length).toBeGreaterThan(0)
    expect(wins[0]!.avgJankPct).toBeNull()
    expect(wins[0]!.score).toBeGreaterThan(0)
  })

  test('jank alto pesa aunque el FPS promedio esté en target', () => {
    const smooth = run(0, 60, { fps: 30, jankPct: 0 })
    const janky = [...run(0, 30, { fps: 30, jankPct: 0 }), ...run(30, 30, { fps: 30, jankPct: 60 })]
    expect(worstWindows(smooth, 30)).toEqual([])
    const wins = worstWindows(janky, 30)
    expect(wins.length).toBeGreaterThan(0)
    expect(wins[0]!.startTs).toBeGreaterThanOrEqual(T0 + 25_000)
  })

  test('menos de 3 ticks con FPS ⇒ ninguna ventana compite', () => {
    expect(worstWindows([pt(0, { fps: 5 }), pt(1, { fps: 5 })], 30)).toEqual([])
    expect(worstWindows(run(0, 50, { fps: null }), 30)).toEqual([])
  })
})

describe('detectThrottling', () => {
  const cool = (n: number, startSec = 0): VerdictPoint[] =>
    run(startSec, n, { tempC: 35, fps: 30, gpu: 60 })
  const hotSlow = (n: number, startSec: number): VerdictPoint[] =>
    run(startSec, n, { tempC: 44, fps: 21, gpu: 60 })

  test('temp sostenida + caída de FPS ⇒ detectado, con el detalle del tramo', () => {
    const r = detectThrottling([...cool(120), ...hotSlow(90, 120)])
    expect(r.detected).toBe(true)
    expect(r.hotStartTs).toBe(T0 + 120_000)
    expect(r.peakTempC).toBe(44)
    expect(r.baselineFps).toBe(30)
    expect(r.hotFps).toBe(21)
    expect(r.fpsDropPct!).toBeCloseTo(30, 0)
  })

  test('caída solo de GPU% (FPS estable) también cuenta', () => {
    const hot = run(120, 90, { tempC: 44, fps: 30, gpu: 40 })
    const r = detectThrottling([...cool(120), ...hot])
    expect(r.detected).toBe(true)
    expect(r.gpuDropPct!).toBeCloseTo(33.3, 0)
  })

  test('caliente pero corto (< sostenido) ⇒ no acusa', () => {
    const short = run(120, THROTTLE_SUSTAIN_S - 20, { tempC: 44, fps: 15 })
    const r = detectThrottling([...cool(120), ...short, ...cool(60, 220)])
    expect(r.detected).toBe(false)
    expect(r.hotStartTs).toBeNull()
  })

  test('caliente sostenido pero FPS/GPU estables ⇒ no acusa (reporta el tramo)', () => {
    const hotStable = run(120, 90, { tempC: 44, fps: 30, gpu: 60 })
    const r = detectThrottling([...cool(120), ...hotStable])
    expect(r.detected).toBe(false)
    expect(r.hotStartTs).toBe(T0 + 120_000)
    expect(r.fpsDropPct!).toBeCloseTo(0, 5)
  })

  test('sesión que arranca ya caliente ⇒ sin línea de base ⇒ no acusa', () => {
    const r = detectThrottling(hotSlow(180, 0))
    expect(r.detected).toBe(false)
    expect(r.fpsDropPct).toBeNull()
  })

  test('sin datos de temperatura ⇒ no acusa', () => {
    const r = detectThrottling(run(0, 200, { tempC: null, fps: 10 }))
    expect(r).toMatchObject({ detected: false, hotStartTs: null })
  })

  test('umbral de temperatura: justo abajo del límite no arma tramo caliente', () => {
    const warm = run(120, 90, { tempC: THROTTLE_TEMP_C - 0.5, fps: 15 })
    expect(detectThrottling([...cool(120), ...warm]).detected).toBe(false)
  })
})

describe('buildPerfVerdict', () => {
  test('ventana sana: verde, 100% en target, sin tramos ni throttling', () => {
    const v = buildPerfVerdict(run(0, 120, { fps: 32 }), 30)
    expect(v.fpsTarget).toBe(30)
    expect(v.overall).toBe('green')
    expect(v.avgFps).toBe(32)
    expect(v.timeInTarget!.greenPct).toBe(100)
    expect(v.worstWindows).toEqual([])
    expect(v.throttling.detected).toBe(false)
    expect(v.redSpans).toEqual([])
  })

  test('sin FPS en toda la ventana ⇒ datos insuficientes (overall null), nunca rompe', () => {
    const v = buildPerfVerdict(run(0, 60, { fps: null, jankPct: null }), 30)
    expect(v.overall).toBeNull()
    expect(v.avgFps).toBeNull()
    expect(v.timeInTarget).toBeNull()
    expect(v.worstWindows).toEqual([])
    expect(v.redSpans).toEqual([])
  })

  test('serie vacía ⇒ veredicto vacío sin throw', () => {
    const v = buildPerfVerdict([], 30)
    expect(v.overall).toBeNull()
    expect(v.throttling.detected).toBe(false)
  })

  test('escenario throttling completo: rojo + tramos + acusación coherentes', () => {
    const points = [
      ...run(0, 120, { fps: 30, gpu: 60, tempC: 36 }),
      ...run(120, 120, { fps: 18, jankPct: 35, gpu: 45, tempC: 45 }),
    ]
    const v = buildPerfVerdict(points, 30)
    expect(v.overall).toBe('yellow') // avg 24 = 80% del target
    expect(v.timeInTarget!.redPct).toBe(50)
    expect(v.worstWindows.length).toBeGreaterThan(0)
    expect(v.worstWindows[0]!.startTs).toBeGreaterThanOrEqual(T0 + 115_000)
    expect(v.throttling.detected).toBe(true)
    expect(v.redSpans).toEqual([{ startTs: T0 + 120_000, endTs: T0 + 239_000 }])
  })
})

describe('veredicto sobre el fixture real (Galaxy A15)', () => {
  const FIX = join(import.meta.dir, '../../../fixtures/sm-a155m-api36')
  const dump = readFileSync(join(FIX, 'session/final/timestats-dump.txt'), 'utf8')
  const frame = parseFrameStats(dump, 'com.sample.oda.qa', 90)

  test('serie armada con el frame real del A15: jank bajo no infla el score', () => {
    // el dump real da p50 33 ms (~30 FPS) y jank 0.93% — un tramo sano a target 30
    expect(frame.jankPct).not.toBeNull()
    const points = run(0, 60, { fps: 30, jankPct: frame.jankPct })
    const v = buildPerfVerdict(points, 30)
    expect(v.overall).toBe('green')
    expect(v.worstWindows).toEqual([]) // score jank-only ≈ 0.3 < piso de 1 ⇒ ruido, no tramo
  })

  test('el mismo frame real contra target 60 cae en rojo con % en target coherente', () => {
    // ~30 FPS reales (p50 33 ms) sobre un target de 60 ⇒ rojo de punta a punta
    const fps = 1000 / frame.p50Ms!
    const points = run(0, 60, { fps, jankPct: frame.jankPct })
    const v = buildPerfVerdict(points, 60)
    expect(v.overall).toBe('red')
    expect(v.timeInTarget!.redPct).toBe(100)
    expect(v.worstWindows.length).toBeGreaterThan(0)
    expect(v.redSpans.length).toBe(1)
  })
})
