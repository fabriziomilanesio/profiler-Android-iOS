// Ring buffer de logs en memoria (ticket 027). Cap default 50k entradas:
// a ~250 bytes por entrada son ~12 MB — mismo espíritu que el cap de 8 h del
// SessionBuffer (el proceso no crece sin límite aunque la app loguee a chorro).
// Circular con índice de cabeza: push O(1) real (un shift() de 50k por línea de
// log sería O(n) en el hot path del stream).
import type { LogEntry } from './logEntry'

export const DEFAULT_LOG_CAP = 50_000

export class LogRing {
  private readonly buf: LogEntry[] = []
  /** índice de la entrada MÁS VIEJA una vez que el buffer dio la vuelta */
  private head = 0

  constructor(readonly cap = DEFAULT_LOG_CAP) {}

  get size(): number {
    return this.buf.length
  }

  push(entry: LogEntry): void {
    if (this.buf.length < this.cap) {
      this.buf.push(entry)
      return
    }
    this.buf[this.head] = entry
    this.head = (this.head + 1) % this.cap
  }

  /** Últimas n entradas en orden cronológico (más vieja primero). */
  last(n: number): LogEntry[] {
    const count = Math.max(0, Math.min(n, this.buf.length))
    const out: LogEntry[] = new Array(count) as LogEntry[]
    for (let i = 0; i < count; i++) {
      out[i] = this.buf[(this.head + this.buf.length - count + i) % this.buf.length]!
    }
    return out
  }
}
