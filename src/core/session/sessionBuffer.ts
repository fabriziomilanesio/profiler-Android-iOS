// Buffer de sesión en memoria (export de reportes): guarda cada Sample con la
// app/device activos en ese tick, más los eventos de switch. Circular: con cap
// de 8 h a 1 Hz (~28800 muestras ≈ 15 MB) el proceso no crece sin límite.
import type { Sample } from '../schema'

export interface SessionEntry {
  sample: Sample
  pkg: string
  serial: string
}

export interface SessionEvent {
  ts: number
  kind: 'app' | 'device'
  pkg: string
  serial: string
}

export class SessionBuffer {
  private entries: SessionEntry[] = []
  readonly events: SessionEvent[] = []

  constructor(private readonly cap = 28800) {}

  get size(): number {
    return this.entries.length
  }

  push(entry: SessionEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.cap) this.entries.shift()
  }

  addEvent(ev: SessionEvent): void {
    this.events.push(ev)
  }

  /**
   * Tramo continuo FINAL de la app/device dados: desde el último sample hacia atrás
   * hasta el primer sample que no matchea (un switch) o el borde de la ventana.
   * Es el recorte del export: stats de UNA sola app, nunca mezcladas.
   */
  currentSegment(
    pkg: string,
    serial: string,
    windowMs?: number,
  ): { samples: Sample[]; trimmed: boolean } {
    const out: Sample[] = []
    const lastTs = this.entries.length ? this.entries[this.entries.length - 1]!.sample.ts : 0
    let trimmed = false
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!
      if (e.pkg !== pkg || e.serial !== serial) {
        // hubo un switch dentro de la ventana pedida ⇒ el reporte aclara el recorte
        if (windowMs === undefined || lastTs - e.sample.ts <= windowMs) trimmed = true
        break
      }
      if (windowMs !== undefined && lastTs - e.sample.ts > windowMs) break
      out.push(e.sample)
    }
    out.reverse()
    return { samples: out, trimmed }
  }
}
