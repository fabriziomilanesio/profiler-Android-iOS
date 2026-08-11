// Estadísticas de sesión para el reporte exportado (contrato del ticket 020):
// cada métrica escalar → {avg, peak, min, p90}; batería → drain/avgMa/temp;
// memAvg → breakdown PSS promedio. Funciones puras, null-safe: los Samples reales
// traen null en lo no disponible y acá se filtra (una métrica sin datos ⇒ null).
import type { DeviceInfo, MemSample, Sample } from '../schema'
import { buildPerfVerdict, type PerfVerdict } from '../perf/verdict'
import type { LogEntry } from '../logs/logEntry'
import {
  buildLogMarks,
  buildReportLogs,
  filterLogsToWindow,
  type ReportLogs,
  type ReportMark,
} from '../logs/reportLogs'

export interface ScalarStats {
  avg: number
  peak: number
  min: number
  p90: number
}

export interface BatterySummary {
  levelStart: number | null
  levelEnd: number | null
  drainPct: number | null
  avgMa: number | null
  tempPeak: number | null
  tempAvg: number | null
}

/** Resumen de frame-times/jank de la sesión (ticket 024 — insumo del reporte 026). */
export interface FrameSummary {
  /** stats de los p50/p90/p99 por tick (ms) */
  p50Ms: ScalarStats | null
  p90Ms: ScalarStats | null
  p99Ms: ScalarStats | null
  /** % janky de la sesión, ponderado por frames del tick (fallback: promedio simple) */
  jankPct: number | null
  /** total de frames que perdieron ≥1 vsync en la sesión */
  jankFrames: number | null
}

export interface ReportSummary {
  cpu: ScalarStats | null
  gpu: ScalarStats | null
  fps: ScalarStats | null
  /** frame-times/jank derivados por tick (null-safe: sesiones viejas no los traen) */
  frame: FrameSummary
  tempC: ScalarStats | null
  ramMb: ScalarStats | null
  /** CPU total del device (0–100%) */
  deviceCpu: ScalarStats | null
  /** RAM usada total del device (MB) */
  deviceRamMb: ScalarStats | null
  battery: BatterySummary
  memAvg: Record<'java' | 'native' | 'graphics' | 'code' | 'stack' | 'other', number | null>
}

/** Punto de la serie del reporte (shape que consume el template del ticket 020). */
export interface ReportSeriesPoint {
  t: number
  ts: number
  cpu: number | null
  gpu: number | null
  fps: number | null
  /** frame-time p90 del tick (ms) — la señal de tirones para el timeline del reporte */
  frameP90Ms: number | null
  /** % de frames janky del tick */
  jankPct: number | null
  tempC: number | null
  ramMb: number | null
  deviceCpu: number | null
  deviceRamMb: number | null
  // el reporte grafica la composición PSS; ni el total (va en ramMb) ni el RSS vivo
  /**
   * Sólo las categorías de la torta (Android). `footprint`/`compressed` de iOS NO entran
   * acá a propósito: no son categorías de una composición, son totales con otra
   * definición — graficarlos como porciones sería inventar una torta que no existe.
   */
  mem: Pick<MemSample, 'java' | 'native' | 'graphics' | 'code' | 'stack' | 'other'>
  battery: { level: number | null; tempC: number | null; mA: number | null }
  netRxKb: number | null
  netTxKb: number | null
}

export interface ReportSession {
  app: string
  bundleId: string
  device: {
    name: string
    os: string
    ramMb: number | null
    gpu: string | null
    soc: string | null
    cores: number | null
    /** refresh rate del panel (Hz) — contexto del umbral de jank */
    refreshHz: number | null
    serial: string
  } | null
  startedAt: string
  durationS: number
  samplingHz: number
  sampleCount: number
  /** true si la ventana pedida se recortó al tramo de la app actual (hubo switches). */
  trimmed: boolean
  /** target de FPS configurado al generar el reporte (config.fpsTarget, ticket 025) */
  fpsTarget: number
  series: ReportSeriesPoint[]
  summary: ReportSummary
  /** veredicto de perf de la ventana (ticket 026) — derivado de series + fpsTarget */
  verdict: PerfVerdict
  /** marcas de crashes/ráfagas de errores sobre el timeline (ticket 030, hook del 026) */
  marks: ReportMark[]
  /** logs embebidos de la ventana (ticket 030); null = sesión sin logs capturados */
  logs: ReportLogs | null
}

function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))),
  )
  return sortedAsc[idx]!
}

/** Stats de una serie de valores (los null ya filtrados). null si no hay datos. */
export function scalarStats(values: number[]): ScalarStats | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  let sum = 0
  for (const v of values) sum += v
  return {
    avg: sum / values.length,
    peak: sorted[sorted.length - 1]!,
    min: sorted[0]!,
    p90: percentile(sorted, 90),
  }
}

function pick(samples: Sample[], get: (s: Sample) => number | null): number[] {
  const out: number[] = []
  for (const s of samples) {
    const v = get(s)
    if (v !== null && Number.isFinite(v)) out.push(v)
  }
  return out
}

function avgOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * Jank de sesión: ponderado por los frames de cada tick cuando hay conteos
 * (11 janky sobre 1178 frames ≠ promedio de porcentajes de ticks desparejos);
 * si ningún tick trae conteos, cae al promedio simple de jankPct.
 */
function summarizeFrames(samples: Sample[]): FrameSummary {
  let jankSum = 0
  let framesSum = 0
  let jankSeen = false
  for (const s of samples) {
    const f = s.frame
    if (f && f.jankFrames !== null && f.totalFrames !== null && f.totalFrames > 0) {
      jankSum += f.jankFrames
      framesSum += f.totalFrames
      jankSeen = true
    }
  }
  return {
    p50Ms: scalarStats(pick(samples, (s) => s.frame?.p50Ms ?? null)),
    p90Ms: scalarStats(pick(samples, (s) => s.frame?.p90Ms ?? null)),
    p99Ms: scalarStats(pick(samples, (s) => s.frame?.p99Ms ?? null)),
    jankPct:
      framesSum > 0
        ? (jankSum / framesSum) * 100
        : avgOrNull(pick(samples, (s) => s.frame?.jankPct ?? null)),
    jankFrames: jankSeen ? jankSum : null,
  }
}

export function summarize(samples: Sample[]): ReportSummary {
  const levels = pick(samples, (s) => s.battery.levelPct)
  const battTemps = pick(samples, (s) => s.battery.tempC)
  // el signo de mA varía por OEM (carga vs drenaje): se reporta magnitud promedio
  const mAs = pick(samples, (s) => s.battery.mA).map(Math.abs)
  const levelStart = levels.length ? levels[0]! : null
  const levelEnd = levels.length ? levels[levels.length - 1]! : null

  const memKeys = ['java', 'native', 'graphics', 'code', 'stack', 'other'] as const
  const memAvg = {} as ReportSummary['memAvg']
  for (const k of memKeys) memAvg[k] = avgOrNull(pick(samples, (s) => s.mem[k]))

  return {
    cpu: scalarStats(pick(samples, (s) => s.cpu)),
    gpu: scalarStats(pick(samples, (s) => s.gpu)),
    fps: scalarStats(pick(samples, (s) => s.fps)),
    frame: summarizeFrames(samples),
    tempC: scalarStats(pick(samples, (s) => s.tempC)),
    ramMb: scalarStats(pick(samples, (s) => s.mem.pss)),
    deviceCpu: scalarStats(pick(samples, (s) => s.deviceCpu)),
    deviceRamMb: scalarStats(pick(samples, (s) => s.deviceRamUsedMb)),
    battery: {
      levelStart,
      levelEnd,
      drainPct: levelStart !== null && levelEnd !== null ? levelStart - levelEnd : null,
      avgMa: avgOrNull(mAs),
      tempPeak: battTemps.length ? Math.max(...battTemps) : null,
      tempAvg: avgOrNull(battTemps),
    },
    memAvg,
  }
}

export interface BuildReportOptions {
  samples: Sample[]
  packageName: string
  device: DeviceInfo | null
  intervalMs: number
  trimmed: boolean
  /** config.fpsTarget al momento de exportar; ausente ⇒ 30 (el default del AppStore) */
  fpsTarget?: number
  /** logs de la sesión (ticket 030); acá se recortan a la ventana de los samples.
   *  null/ausente/vacío ⇒ el reporte sale sin sección de logs ni marcas. */
  logEntries?: LogEntry[] | null
}

/** Arma la sesión completa que consume el template del reporte. */
export function buildReportSession(opts: BuildReportOptions): ReportSession {
  const { samples, device } = opts
  const first = samples[0]
  const last = samples[samples.length - 1]
  // Duración ACTIVA: con la persistencia pausada mientras la app está muerta, el span
  // first→last puede incluir huecos; contar samples × intervalo excluye el tiempo muerto.
  const spanS = first && last ? Math.round((last.ts - first.ts) / 1000) + 1 : 0
  const activeS = Math.round((samples.length * opts.intervalMs) / 1000)
  const durationS = samples.length ? Math.max(1, Math.min(spanS, activeS)) : 0
  const fpsTarget = opts.fpsTarget ?? 30
  // Logs de la ventana (ticket 030): recorte EXACTO al rango de los samples
  // (con gracia solo-crashes al final — ver reportLogs.ts). Sin logs ⇒ marks
  // vacías y logs null: el reporte sale como antes del 030.
  let marks: ReportMark[] = []
  let logs: ReportLogs | null = null
  if (opts.logEntries && opts.logEntries.length > 0 && first && last) {
    const windowLogs = filterLogsToWindow(opts.logEntries, first.ts, last.ts)
    logs = buildReportLogs(windowLogs)
    marks = buildLogMarks(windowLogs, first.ts, last.ts)
  }
  const series: ReportSeriesPoint[] = samples.map((s) => ({
    t: s.t,
    ts: s.ts,
    cpu: s.cpu,
    gpu: s.gpu,
    fps: s.fps,
    // ?? null: sesiones viejas no traen frame
    frameP90Ms: s.frame?.p90Ms ?? null,
    jankPct: s.frame?.jankPct ?? null,
    tempC: s.tempC,
    ramMb: s.mem.pss,
    // ?? null: sesiones viejas del historial no traen estos campos
    deviceCpu: s.deviceCpu ?? null,
    deviceRamMb: s.deviceRamUsedMb ?? null,
    mem: {
      java: s.mem.java,
      native: s.mem.native,
      graphics: s.mem.graphics,
      code: s.mem.code,
      stack: s.mem.stack,
      other: s.mem.other,
    },
    battery: { level: s.battery.levelPct, tempC: s.battery.tempC, mA: s.battery.mA },
    netRxKb: s.netRxKb,
    netTxKb: s.netTxKb,
  }))
  return {
    app: opts.packageName.split('.').pop() ?? opts.packageName,
    bundleId: opts.packageName,
    device: device
      ? {
          name: [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial,
          os: `Android ${device.androidRelease ?? '?'} (API ${device.apiLevel ?? '?'})`,
          ramMb: device.ramTotalMb ?? null,
          gpu: device.gpu ?? null,
          soc: device.soc ?? null,
          cores: device.cores ?? null,
          // ?? null: fichas viejas del historial no traen refreshHz
          refreshHz: device.refreshHz ?? null,
          serial: device.serial,
        }
      : null,
    startedAt: first ? new Date(first.ts).toISOString() : new Date(0).toISOString(),
    durationS,
    samplingHz: +(1000 / opts.intervalMs).toFixed(2),
    sampleCount: samples.length,
    trimmed: opts.trimmed,
    fpsTarget,
    series,
    summary: summarize(samples),
    verdict: buildPerfVerdict(series, fpsTarget),
    marks,
    logs,
  }
}
