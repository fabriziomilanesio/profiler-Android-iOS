// Export de logs (ticket 029): serializadores PUROS a .txt legible (una línea por
// entry, para pegar en Jira/Slack) y .jsonl estructurado (las LogEntry tal cual,
// una por línea), + nombre de archivo y validación de entries que llegan del
// cliente (el export de "lo filtrado" manda las entries visibles por POST — ver
// la decisión de arquitectura en docs/wayfinder/tickets/029-export-logs.md).
import type { LogEntry, LogLevel } from './logEntry'

const LEVELS: ReadonlySet<string> = new Set(['V', 'D', 'I', 'W', 'E', 'F'])

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

/** HH:MM:SS.mmm en hora local del host — mismo formato que el panel de logs. */
export function formatLogTime(ts: number): string {
  const d = new Date(ts)
  return (
    `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}` +
    `.${pad(d.getMilliseconds(), 3)}`
  )
}

/**
 * .txt legible: `HH:MM:SS.mmm LEVEL/tag(pid): message`, una línea por entry.
 * Los crashes van claramente marcados con prefijo `[CRASH]` (o `[ANR]` para las
 * líneas de am_anr): un stacktrace multi-línea son N entries ⇒ N líneas marcadas,
 * fáciles de ver y de grepear en el texto pegado.
 */
export function serializeLogsTxt(entries: LogEntry[]): string {
  const lines: string[] = []
  for (const e of entries) {
    const mark = e.isCrash ? (e.tag === 'am_anr' ? '[ANR] ' : '[CRASH] ') : ''
    lines.push(`${mark}${formatLogTime(e.ts)} ${e.level}/${e.tag}(${e.pid}): ${e.message}`)
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n'
}

/** .jsonl estructurado: cada LogEntry tal cual, JSON por línea (mismo formato que el sink). */
export function serializeLogsJsonl(entries: LogEntry[]): string {
  return entries.length === 0 ? '' : entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

/**
 * Nombre del archivo exportado: `evermore-logs-<sesión|fecha>[-filtered].<ext>`.
 * Con sessionId (export de una sesión) el nombre queda atado a la sesión; sin él
 * (export de lo filtrado en vivo) va el timestamp del momento, como el reporte.
 */
export function logsExportFilename(opts: {
  format: 'txt' | 'jsonl'
  filtered: boolean
  sessionId?: string | null
  now: Date
}): string {
  const stamp = opts.sessionId ?? opts.now.toISOString().replace(/:/g, '-').replace(/\..*$/, '')
  return `evermore-logs-${stamp}${opts.filtered ? '-filtered' : ''}.${opts.format}`
}

/**
 * Valida y normaliza las entries que manda el cliente (input hostil: viajan por
 * HTTP y terminan escritas a disco). Devuelve null si algo no tiene la forma de
 * una LogEntry; descarta campos desconocidos para que el .jsonl exportado tenga
 * exactamente el esquema del ticket 027.
 */
export function parseExportEntries(raw: unknown, max: number): LogEntry[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null
  const out: LogEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const e = item as Record<string, unknown>
    const ts = e['ts']
    const level = e['level']
    const tag = e['tag']
    const message = e['message']
    const pid = e['pid']
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
    if (typeof level !== 'string' || !LEVELS.has(level)) return null
    if (typeof tag !== 'string' || typeof message !== 'string') return null
    if (typeof pid !== 'number' || !Number.isFinite(pid)) return null
    const entry: LogEntry = {
      ts,
      level: level as LogLevel,
      tag,
      message,
      pid,
      source: e['source'] === 'game' ? 'game' : 'logcat',
    }
    if (typeof e['tid'] === 'number' && Number.isFinite(e['tid'])) entry.tid = e['tid']
    if (e['isCrash'] === true) entry.isCrash = true
    out.push(entry)
  }
  return out
}
