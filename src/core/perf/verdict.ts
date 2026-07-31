// Veredicto de perf del reporte (ticket 026): funciones PURAS sobre la serie ya
// capturada — análisis post-hoc, cero comandos nuevos al device. Todo null-safe /
// best-effort: sesiones viejas sin frame-time ⇒ el score degrada a solo-FPS; sin
// FPS ⇒ "datos insuficientes" (overall null), nunca throw.
//
// Umbrales elegidos (documentados también en el ticket 026):
// - Peor tramo: ventana deslizante de 30 s; score compuesto 0–100 por tick con FPS =
//   70 % déficit de FPS contra el target + 30 % jank del tick (sin jank ⇒ 100 % FPS).
//   Ventanas con < 3 ticks con FPS no compiten; score < 1 es ruido y no se reporta;
//   se eligen las top 3 sin solaparse.
// - Throttling térmico (conservador — mejor no acusar que acusar mal): temperatura
//   ≥ 42 °C sostenida ≥ 60 s Y caída ≥ 15 % del FPS y/o GPU% promedio en el tramo
//   caliente contra la línea de base fría anterior (≥ 5 ticks fríos con dato).
//   Sin línea de base (sesión que arranca caliente) NO se acusa.
import { fpsStatus, type FpsStatus } from './threshold'

/** Punto mínimo que necesita el veredicto (ReportSeriesPoint es compatible). */
export interface VerdictPoint {
  ts: number
  fps: number | null
  jankPct: number | null
  gpu: number | null
  cpu: number | null
  tempC: number | null
}

/** Ventana deslizante del "peor tramo" (segundos). */
export const WORST_WINDOW_S = 30
/** Cuántos peores tramos reporta el veredicto. */
export const WORST_WINDOW_COUNT = 3
/** Peso del déficit de FPS en el score compuesto del tramo. */
export const SCORE_WEIGHT_FPS = 0.7
/** Peso del jank% en el score compuesto del tramo. */
export const SCORE_WEIGHT_JANK = 0.3
/** Mínimo de ticks con FPS para que una ventana compita como "peor tramo". */
export const WORST_MIN_FPS_TICKS = 3
/** Piso de score para reportar un tramo (filtra ruido: jank residual < 1). */
export const WORST_MIN_SCORE = 1

/** Temperatura que cuenta como "caliente" para la heurística de throttling (°C). */
export const THROTTLE_TEMP_C = 42
/** Cuánto debe sostenerse la temperatura alta para considerarla (segundos). */
export const THROTTLE_SUSTAIN_S = 60
/** Caída relativa (FPS o GPU%) contra la línea de base que confirma throttling. */
export const THROTTLE_DROP_RATIO = 0.15
/** Mínimo de ticks fríos con dato para que exista línea de base. */
export const THROTTLE_MIN_BASELINE_TICKS = 5
/** Mínimo de ticks con dato dentro del tramo caliente para comparar. */
export const THROTTLE_MIN_HOT_TICKS = 3

/** Reparto del tiempo (ticks con dato de FPS) por color de semáforo. */
export interface TargetTimeShare {
  greenPct: number
  yellowPct: number
  redPct: number
  /** ticks con dato de FPS que ponderaron el reparto */
  ticks: number
}

export interface WorstWindow {
  startTs: number
  endTs: number
  /** score compuesto 0–100 (más alto = peor) */
  score: number
  avgFps: number | null
  minFps: number | null
  /**
   * Promedio SIMPLE de los jankPct por tick de la ventana — semántica distinta
   * al jank de sesión (FrameSummary.jankPct, ponderado por frames del tick).
   * Acá alcanza: describe el tramo a golpe de vista y los ticks de una misma
   * ventana de 30 s traen conteos de frames parecidos.
   */
  avgJankPct: number | null
  avgGpu: number | null
  avgCpu: number | null
  avgTempC: number | null
}

export interface ThrottlingReport {
  detected: boolean
  /** tramo caliente sostenido (si lo hubo, aun sin acusación) */
  hotStartTs: number | null
  hotEndTs: number | null
  peakTempC: number | null
  baselineFps: number | null
  hotFps: number | null
  /** caída del FPS en el tramo caliente vs. base (%; positivo = cayó) */
  fpsDropPct: number | null
  baselineGpu: number | null
  hotGpu: number | null
  gpuDropPct: number | null
}

/** Tramo contiguo con FPS en rojo (para pintar markAreas en el timeline). */
export interface RedSpan {
  startTs: number
  endTs: number
}

export interface PerfVerdict {
  /** target usado (config.fpsTarget al momento de generar) */
  fpsTarget: number
  /** FPS promedio de la ventana (insumo del semáforo general) */
  avgFps: number | null
  /** semáforo general: fpsStatus(avg FPS, target); null = datos insuficientes */
  overall: FpsStatus | null
  timeInTarget: TargetTimeShare | null
  worstWindows: WorstWindow[]
  throttling: ThrottlingReport
  redSpans: RedSpan[]
}

function finite(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v)
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** % del tiempo (ticks con dato) en verde/amarillo/rojo. null sin ningún FPS. */
export function timeInTarget(points: VerdictPoint[], target: number): TargetTimeShare | null {
  let g = 0
  let y = 0
  let r = 0
  for (const p of points) {
    const st = fpsStatus(p.fps, target)
    if (st === 'green') g++
    else if (st === 'yellow') y++
    else if (st === 'red') r++
  }
  const total = g + y + r
  if (total === 0) return null
  return {
    greenPct: (g / total) * 100,
    yellowPct: (y / total) * 100,
    redPct: (r / total) * 100,
    ticks: total,
  }
}

/** Tramos contiguos en rojo; un tick no-rojo (o sin dato) corta el tramo. */
export function redSpans(points: VerdictPoint[], target: number): RedSpan[] {
  const spans: RedSpan[] = []
  let cur: RedSpan | null = null
  for (const p of points) {
    if (fpsStatus(p.fps, target) === 'red') {
      if (cur) cur.endTs = p.ts
      else {
        cur = { startTs: p.ts, endTs: p.ts }
        spans.push(cur)
      }
    } else {
      cur = null
    }
  }
  return spans
}

/**
 * Peores N tramos: ventana deslizante de `windowS` anclada en cada tick; score
 * compuesto por tick con FPS (70 % déficit de FPS + 30 % jank; sin jank ⇒ solo
 * FPS). Se eligen las de mayor score SIN solaparse; ventanas 100 % en target
 * (score 0) no aparecen.
 */
export function worstWindows(
  points: VerdictPoint[],
  target: number,
  count: number = WORST_WINDOW_COUNT,
  windowS: number = WORST_WINDOW_S,
): WorstWindow[] {
  if (!Number.isFinite(target) || target <= 0) return []
  const windowMs = windowS * 1000
  const candidates: WorstWindow[] = []
  for (let i = 0; i < points.length; i++) {
    const startTs = points[i]!.ts
    let endTs = startTs
    let penaltySum = 0
    let fpsTicks = 0
    let minFps = Infinity
    const fpsVals: number[] = []
    const jankVals: number[] = []
    const gpuVals: number[] = []
    const cpuVals: number[] = []
    const tempVals: number[] = []
    for (let j = i; j < points.length && points[j]!.ts <= startTs + windowMs; j++) {
      const p = points[j]!
      endTs = p.ts
      if (finite(p.gpu)) gpuVals.push(p.gpu)
      if (finite(p.cpu)) cpuVals.push(p.cpu)
      if (finite(p.tempC)) tempVals.push(p.tempC)
      if (finite(p.jankPct)) jankVals.push(p.jankPct)
      if (!finite(p.fps) || p.fps < 0) continue
      fpsTicks++
      if (p.fps < minFps) minFps = p.fps
      fpsVals.push(p.fps)
      const fpsPen = Math.max(0, (target - p.fps) / target)
      penaltySum += finite(p.jankPct)
        ? SCORE_WEIGHT_FPS * fpsPen + SCORE_WEIGHT_JANK * Math.min(1, Math.max(0, p.jankPct) / 100)
        : fpsPen
    }
    if (fpsTicks < WORST_MIN_FPS_TICKS) continue
    candidates.push({
      startTs,
      endTs,
      score: (penaltySum / fpsTicks) * 100,
      avgFps: avg(fpsVals),
      minFps: minFps === Infinity ? null : minFps,
      avgJankPct: avg(jankVals),
      avgGpu: avg(gpuVals),
      avgCpu: avg(cpuVals),
      avgTempC: avg(tempVals),
    })
  }
  candidates.sort((a, b) => b.score - a.score || a.startTs - b.startTs)
  const chosen: WorstWindow[] = []
  for (const c of candidates) {
    if (c.score < WORST_MIN_SCORE || chosen.length >= count) break
    if (chosen.some((w) => c.startTs <= w.endTs && c.endTs >= w.startTs)) continue
    chosen.push(c)
  }
  return chosen
}

export interface ThrottlingOptions {
  tempC?: number
  sustainS?: number
  dropRatio?: number
}

const NULL_THROTTLING: ThrottlingReport = {
  detected: false,
  hotStartTs: null,
  hotEndTs: null,
  peakTempC: null,
  baselineFps: null,
  hotFps: null,
  fpsDropPct: null,
  baselineGpu: null,
  hotGpu: null,
  gpuDropPct: null,
}

/**
 * Throttling térmico, heurística conservadora: temperatura ≥ tempC sostenida
 * ≥ sustainS Y caída ≥ dropRatio del FPS y/o GPU% promedio en el tramo caliente
 * contra la línea de base fría ANTERIOR al tramo. Sin línea de base (la sesión
 * arranca ya caliente, o sin datos) ⇒ NO se acusa.
 *
 * Nota (decisión consciente del ticket 026, no "corregir" sin datos de campo):
 * se usa la CAÍDA de GPU% como confirmación, aunque bajo throttling real la
 * utilización suele SUBIR (el clock baja y el mismo trabajo ocupa más del
 * budget) — en ese caso esta señal no dispara y solo cuenta la caída de FPS.
 * Es coherente con el sesgo del veredicto: mejor sub-acusar que acusar mal.
 */
export function detectThrottling(
  points: VerdictPoint[],
  opts: ThrottlingOptions = {},
): ThrottlingReport {
  const tempThresh = opts.tempC ?? THROTTLE_TEMP_C
  const sustainMs = (opts.sustainS ?? THROTTLE_SUSTAIN_S) * 1000
  const dropRatio = opts.dropRatio ?? THROTTLE_DROP_RATIO

  // 1) run caliente sostenido más largo, sobre los ticks CON temperatura
  const tempTicks = points.filter((p) => finite(p.tempC))
  let best: { startTs: number; endTs: number; peak: number } | null = null
  let run: { startTs: number; endTs: number; peak: number } | null = null
  for (const p of tempTicks) {
    if ((p.tempC as number) >= tempThresh) {
      if (run) {
        run.endTs = p.ts
        run.peak = Math.max(run.peak, p.tempC as number)
      } else {
        run = { startTs: p.ts, endTs: p.ts, peak: p.tempC as number }
      }
      if (
        run.endTs - run.startTs >= sustainMs &&
        (!best || run.endTs - run.startTs > best.endTs - best.startTs)
      ) {
        best = run
      }
    } else {
      run = null
    }
  }
  if (!best) return NULL_THROTTLING

  // 2) línea de base = ticks confirmadamente fríos ANTES del tramo caliente
  const baselinePts = points.filter(
    (p) => p.ts < best!.startTs && finite(p.tempC) && (p.tempC as number) < tempThresh,
  )
  const hotPts = points.filter((p) => p.ts >= best!.startTs && p.ts <= best!.endTs)

  const baseFpsVals = baselinePts.map((p) => p.fps).filter(finite)
  const hotFpsVals = hotPts.map((p) => p.fps).filter(finite)
  const baseGpuVals = baselinePts.map((p) => p.gpu).filter(finite)
  const hotGpuVals = hotPts.map((p) => p.gpu).filter(finite)

  const compare = (
    base: number[],
    hot: number[],
  ): [number | null, number | null, number | null] => {
    if (base.length < THROTTLE_MIN_BASELINE_TICKS || hot.length < THROTTLE_MIN_HOT_TICKS) {
      return [avg(base), avg(hot), null]
    }
    const b = avg(base)!
    const h = avg(hot)!
    if (b <= 0) return [b, h, null]
    return [b, h, ((b - h) / b) * 100]
  }
  const [baselineFps, hotFps, fpsDropPct] = compare(baseFpsVals, hotFpsVals)
  const [baselineGpu, hotGpu, gpuDropPct] = compare(baseGpuVals, hotGpuVals)

  const detected =
    (fpsDropPct !== null && fpsDropPct >= dropRatio * 100) ||
    (gpuDropPct !== null && gpuDropPct >= dropRatio * 100)

  return {
    detected,
    hotStartTs: best.startTs,
    hotEndTs: best.endTs,
    peakTempC: best.peak,
    baselineFps,
    hotFps,
    fpsDropPct,
    baselineGpu,
    hotGpu,
    gpuDropPct,
  }
}

/** Arma el veredicto completo de la ventana (lo embebe el reporte del 026). */
export function buildPerfVerdict(points: VerdictPoint[], fpsTarget: number): PerfVerdict {
  const fpsVals = points.map((p) => p.fps).filter((v): v is number => finite(v) && v >= 0)
  const avgFps = avg(fpsVals)
  return {
    fpsTarget,
    avgFps,
    overall: fpsStatus(avgFps, fpsTarget),
    timeInTarget: timeInTarget(points, fpsTarget),
    worstWindows: worstWindows(points, fpsTarget),
    throttling: detectThrottling(points),
    redSpans: redSpans(points, fpsTarget),
  }
}
