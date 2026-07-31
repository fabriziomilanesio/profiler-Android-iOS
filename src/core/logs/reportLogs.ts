// Logs dentro del reporte HTML (ticket 030): funciones PURAS que convierten los
// logs de la ventana exportada en (a) marcas sobre el timeline de FPS
// (`session.marks` — el hook del 026 las pinta solas como markLines) y (b) la
// sección de logs embebida en el HTML standalone.
//
// Presupuesto de embebido (decisión del ticket, documentada en su Entregado):
//   - Se embeben SOLO W/E/F + todos los isCrash. Cap de 500 entradas no-crash
//     (los bloques de crash van completos siempre — son el evento que importa);
//     ante overflow sobreviven las MÁS RECIENTES (el final de la ventana es
//     donde la sesión murió). El resto queda como conteo por nivel
//     ("además hubo N info/debug"). 500 × ~250 B ≈ 125 KB: no infla el ~2 MB
//     del HTML.
//   - Marcas: una por BLOQUE de crash (entradas isCrash con gap ≤ 2 s = el
//     mismo stacktrace), label "CRASH: <primer mensaje>" (o "ANR: <reason>")
//     truncado a 40 chars. Los errores E/F sueltos NO marcan (ruido: quedan en
//     la lista); una ráfaga de ≥ 5 errores con gaps ≤ 10 s colapsa en una única
//     marca "N errors". Máximo 20 marcas (crashes con prioridad, ráfagas por
//     tamaño).
//   - Recorte: el rango es exactamente el de la ventana exportada
//     [primer sample, último sample], con una gracia de 10 s al final SOLO
//     para crashes: el crash que mata la app llega después del último sample
//     (la persistencia pausa con la muerte). Sus marcas se clampean al rango
//     del chart para que no caigan fuera del eje.
import type { LogEntry, LogLevel } from './logEntry'

/** Cap de entradas NO-crash embebidas (los bloques de crash van completos siempre). */
export const REPORT_LOG_CAP = 500
/** Gracia al final de la ventana SOLO para crashes (el crash llega tras el último sample). */
export const CRASH_END_GRACE_MS = 10_000
/** Dos entradas isCrash con gap ≤ esto pertenecen al mismo bloque (stacktrace). */
export const CRASH_BLOCK_GAP_MS = 2_000
/** Ráfaga: ≥ BURST_MIN_ERRORS errores E/F no-crash con gaps ≤ BURST_GAP_MS ⇒ una marca. */
export const BURST_MIN_ERRORS = 5
export const BURST_GAP_MS = 10_000
/** Máximo de marcas sobre el chart (más sería ruido visual; crashes con prioridad). */
export const MAX_MARKS = 20
/** Largo máximo del label de una marca (se pinta sobre el chart). */
export const MARK_LABEL_MAX = 40

/** Marca puntual sobre el timeline de FPS (contrato del hook del ticket 026). */
export interface ReportMark {
  ts: number
  label: string
}

/** Sección de logs embebida en el reporte. */
export interface ReportLogs {
  /** W/E/F + crashes de la ventana, orden original, cap aplicado a las no-crash */
  entries: LogEntry[]
  /** conteo TOTAL por nivel de la ventana (antes de filtrar niveles y del cap) */
  totalByLevel: Record<LogLevel, number>
  /** cuántas W/E/F no-crash quedaron afuera por el cap */
  truncated: number
}

/**
 * Recorta los logs al rango de la ventana exportada. Estricto para todo salvo
 * crashes, que gozan de CRASH_END_GRACE_MS después del final: la app que crashea
 * deja de samplear ANTES de que el crash stream entregue el stacktrace.
 */
export function filterLogsToWindow(
  entries: LogEntry[],
  startTs: number,
  endTs: number,
): LogEntry[] {
  const out: LogEntry[] = []
  for (const e of entries) {
    if (e.ts >= startTs && e.ts <= endTs) out.push(e)
    else if (e.isCrash === true && e.ts > endTs && e.ts <= endTs + CRASH_END_GRACE_MS) out.push(e)
  }
  return out
}

/** Conteo por nivel de TODAS las entradas (alimenta el "además hubo N info/debug"). */
export function countByLevel(entries: LogEntry[]): Record<LogLevel, number> {
  const out: Record<LogLevel, number> = { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0 }
  for (const e of entries) out[e.level]++
  return out
}

/**
 * Selección con presupuesto: crashes SIEMPRE completos; de las W/E/F no-crash
 * sobreviven hasta `cap`, las más recientes primero (el final de la ventana es
 * donde la sesión murió). El orden original del stream se preserva.
 */
export function buildReportLogs(windowEntries: LogEntry[], cap = REPORT_LOG_CAP): ReportLogs {
  const totalByLevel = countByLevel(windowEntries)
  const nonCrashKeep = new Set<LogEntry>()
  let nonCrashTotal = 0
  // pasada hacia atrás: las últimas `cap` no-crash relevantes entran
  for (let i = windowEntries.length - 1; i >= 0; i--) {
    const e = windowEntries[i]!
    if (e.isCrash === true) continue
    if (e.level !== 'W' && e.level !== 'E' && e.level !== 'F') continue
    nonCrashTotal++
    if (nonCrashKeep.size < cap) nonCrashKeep.add(e)
  }
  const entries = windowEntries.filter((e) => e.isCrash === true || nonCrashKeep.has(e))
  return { entries, totalByLevel, truncated: nonCrashTotal - nonCrashKeep.size }
}

/** Agrupa las entradas isCrash en bloques (mismo stacktrace = gap ≤ CRASH_BLOCK_GAP_MS). */
export function crashBlocks(entries: LogEntry[]): LogEntry[][] {
  const blocks: LogEntry[][] = []
  let cur: LogEntry[] | null = null
  for (const e of entries) {
    if (e.isCrash !== true) continue
    if (cur && e.ts - cur[cur.length - 1]!.ts <= CRASH_BLOCK_GAP_MS) cur.push(e)
    else {
      cur = [e]
      blocks.push(cur)
    }
  }
  return blocks
}

function truncateLabel(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > MARK_LABEL_MAX ? clean.slice(0, MARK_LABEL_MAX - 1) + '…' : clean
}

function crashLabel(block: LogEntry[]): string {
  const first = block[0]!
  if (first.tag === 'am_anr') {
    // am_anr: "0,<pid>,<pkg>,<flags>,<reason>" — el reason es la parte legible
    const parts = first.message.split(',')
    const reason = parts.length >= 5 ? parts.slice(4).join(',') : first.message
    return truncateLabel('ANR: ' + reason)
  }
  return truncateLabel('CRASH: ' + first.message)
}

interface ErrorBurst {
  ts: number
  count: number
}

/** Ráfagas de errores E/F no-crash: gaps ≤ BURST_GAP_MS encadenan; ≥ MIN califica. */
function errorBursts(entries: LogEntry[]): ErrorBurst[] {
  const bursts: ErrorBurst[] = []
  let startTs = 0
  let lastTs = 0
  let count = 0
  const flush = (): void => {
    if (count >= BURST_MIN_ERRORS) bursts.push({ ts: startTs, count })
  }
  for (const e of entries) {
    if (e.isCrash === true || (e.level !== 'E' && e.level !== 'F')) continue
    if (count > 0 && e.ts - lastTs <= BURST_GAP_MS) {
      count++
      lastTs = e.ts
    } else {
      flush()
      startTs = e.ts
      lastTs = e.ts
      count = 1
    }
  }
  flush()
  return bursts
}

/**
 * Marcas para el hook del 026: crashes (una por bloque) + ráfagas de errores.
 * Los ts se clampean al rango del chart (un crash con gracia post-ventana debe
 * pintarse en el borde, no fuera del eje). Cap MAX_MARKS: crashes primero; si
 * hay lugar, ráfagas de mayor a menor tamaño. Resultado cronológico.
 */
export function buildLogMarks(
  windowEntries: LogEntry[],
  startTs: number,
  endTs: number,
): ReportMark[] {
  const clamp = (ts: number): number => Math.min(Math.max(ts, startTs), endTs)
  const crashes: ReportMark[] = crashBlocks(windowEntries).map((b) => ({
    ts: clamp(b[0]!.ts),
    label: crashLabel(b),
  }))
  let marks: ReportMark[]
  if (crashes.length >= MAX_MARKS) {
    // patológico (> 20 bloques de crash): quedan los últimos, los más cercanos al final
    marks = crashes.slice(crashes.length - MAX_MARKS)
  } else {
    const room = MAX_MARKS - crashes.length
    const bursts = errorBursts(windowEntries)
      .sort((a, b) => b.count - a.count)
      .slice(0, room)
      .map((b) => ({ ts: clamp(b.ts), label: `${b.count} errors` }))
    marks = [...crashes, ...bursts]
  }
  return marks.sort((a, b) => a.ts - b.ts)
}
