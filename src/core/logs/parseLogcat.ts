// Parser puro del formato `logcat -v threadtime -v year` (ticket 027).
//
// Elegimos threadtime + el modificador year porque:
//  - threadtime es el default de `adb logcat` y trae pid + tid + level + tag por
//    línea (todo lo que pide el esquema LogEntry);
//  - `-v year` agrega el año a la fecha (threadtime pelado imprime `MM-DD`), lo
//    que evita la ambigüedad del cruce de año y hace el epoch determinístico.
// El parser igual acepta líneas SIN año (fixtures viejas / OEMs que ignoran el
// modificador): en ese caso asume el año provisto en opts (default: el actual).
//
// Las continuation lines de un stacktrace (Java o Unity) son líneas logcat
// completas con el mismo tag/pid/tid: se parsean una a una y el orden del stream
// las preserva agrupadas — no hace falta coser multi-línea acá.
import type { LogLevel } from './logEntry'

export interface ParsedLogcatLine {
  /** epoch ms (fecha del device interpretada en la zona horaria del host) */
  ts: number
  pid: number
  tid: number
  level: LogLevel
  tag: string
  message: string
}

// `2026-07-31 10:15:02.123 18743 18790 I Unity   : mensaje` (año opcional).
// El tag va non-greedy hasta el `:` separador; `:\s?` come exactamente UN espacio
// para no mutilar la indentación de los stacktraces (`\tat com...`).
const LINE_RE =
  /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?)\s*:\s?(.*)$/

/**
 * Parsea una línea de `logcat -v threadtime [-v year]`. Devuelve null para
 * líneas que no son entradas: separadores (`--------- beginning of main`),
 * vacías, o cualquier formato inesperado (best-effort, jamás tira).
 */
export function parseLogcatLine(
  line: string,
  opts: { fallbackYear?: number } = {},
): ParsedLogcatLine | null {
  if (!line || line.startsWith('---------')) return null
  const m = LINE_RE.exec(line)
  if (!m) return null
  const year = m[1] ? Number(m[1]) : (opts.fallbackYear ?? new Date().getFullYear())
  const ts = new Date(
    year,
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]),
  ).getTime()
  if (!Number.isFinite(ts)) return null
  return {
    ts,
    pid: Number(m[8]),
    tid: Number(m[9]),
    level: m[10] as LogLevel,
    tag: m[11]!,
    message: m[12]!,
  }
}
