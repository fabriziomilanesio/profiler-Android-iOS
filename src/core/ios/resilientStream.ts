// Stream que se repone solo (ticket 046).
//
// Es para los canales LOCKDOWN de iOS — `diagnostics battery monitor` y `syslog live`. No
// pasan por DTX, así que no pagan el handshake del túnel: levantar uno cuesta ~2 s contra
// el iPhone real, y por eso reintentar sale barato. Los canales DTX NO usan esto:
//
//  - `graphics` es el canal vital y lo maneja el server (ventana de gracia + re-enganche
//    completo), porque sin FPS no hay sesión que valga.
//  - `sysmon` ya se repone por el watch de procesos, que llama a `setProcessName` cada 5 s.
//
// Sin esto, un canal muerto quedaba en null hasta el próximo enganche del device: contra el
// iPhone real, matar el proceso de batería dejaba la temperatura en N/A para el resto de la
// sesión. Degradar es honesto; no volver nunca, no.

/** Espera entre reintentos, en ms. Se queda en el último valor si sigue fallando. */
export const DEFAULT_BACKOFF_MS = [2000, 5000, 15000, 30000]

export interface ResilientStreamOptions {
  /** Arranca el stream con el `onExit` provisto y devuelve su `stop()`. */
  start: (onExit: (err: Error | null) => void) => () => void
  /** Escalera de espera entre reintentos (los tests la bajan a milisegundos). */
  backoffMs?: number[]
}

export class ResilientStream {
  private stopCurrent: (() => void) | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private attempt = 0
  /** generación del hijo: el onExit del viejo no programa reintentos para el nuevo. */
  private gen = 0
  private readonly backoff: number[]

  constructor(private readonly opts: ResilientStreamOptions) {
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  }

  start(): void {
    if (this.stopped) return
    // Generación: matar al hijo viejo dispara SU onExit un rato después. Sin esto, ese
    // cadáver programaría un reintento del stream que ya está corriendo.
    const gen = ++this.gen
    this.stopCurrent = this.opts.start((_err) => {
      if (this.stopped || gen !== this.gen) return
      this.scheduleRetry()
    })
  }

  /** El canal entregó datos: el próximo corte vuelve a reintentar rápido. */
  noteData(): void {
    this.attempt = 0
  }

  /** Reintentos programados y en curso (lo mira el server/los tests). */
  get retrying(): boolean {
    return this.retryTimer !== null
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.stopCurrent?.()
    this.stopCurrent = null
  }

  private scheduleRetry(): void {
    const wait = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 0
    this.attempt++
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.start()
    }, wait)
    // no mantener vivo el proceso sólo por un reintento pendiente
    this.retryTimer.unref?.()
  }
}
