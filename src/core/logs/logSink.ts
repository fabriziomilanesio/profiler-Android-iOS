// Persistencia NDJSON de logs junto a la sesión (ticket 027): archivo hermano
// `<id>.logs.jsonl` en el MISMO directorio de sesiones que el `<id>.jsonl` del
// SessionLog — el export de sesiones pasadas (ticket 029) lee de acá.
// Best-effort como el SessionLog: un disco que falla nunca rompe la captura.
// El archivo se crea recién en el primer append (una sesión sin logs no deja
// un .logs.jsonl vacío).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEntry } from './logEntry'
import { isValidSessionId } from '../session/sessionLog'

export class LogSink {
  readonly path: string
  private ok = true
  private created = false

  constructor(
    private readonly dir: string,
    sessionId: string,
  ) {
    this.path = join(dir, `${sessionId}.logs.jsonl`)
  }

  append(entries: LogEntry[]): void {
    if (!this.ok || entries.length === 0) return
    try {
      if (!this.created) {
        mkdirSync(this.dir, { recursive: true })
        this.created = true
      }
      appendFileSync(this.path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    } catch {
      /* best-effort: sin disco los logs siguen viviendo en el ring */
    }
  }

  /** Lee los logs de una sesión pasada. null si no existen (sesión sin logs). */
  static read(dir: string, sessionId: string): LogEntry[] | null {
    if (!isValidSessionId(sessionId)) return null
    let raw: string
    try {
      raw = readFileSync(join(dir, `${sessionId}.logs.jsonl`), 'utf8')
    } catch {
      return null
    }
    const out: LogEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as LogEntry)
      } catch {
        /* línea corrupta (corte a mitad de escritura): se saltea */
      }
    }
    return out
  }
}
