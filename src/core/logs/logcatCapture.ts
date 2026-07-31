// Captura de logcat de la app seleccionada + crashes/ANR (ticket 027).
//
// Dos streams long-running vía AdbTransport.streamShell (la costura: acá no se
// conoce el binario adb):
//  - APP: `logcat -b main,system --pid=<pid>` — solo el proceso de la app. Barato:
//    logcat lee el ring buffer del kernel, el filtro por pid corre en logd. En
//    Unity los Debug.Log/LogError salen por el tag "Unity". Se corta y re-arma
//    cuando cambia el pid (muerte/renacimiento — lo detecta el sampler) y muere
//    con pid null (app cerrada ⇒ sin stream, sin errores ruidosos).
//  - CRASH: `logcat -b crash,events` — device-wide (el buffer crash no filtra por
//    un pid que ya murió), adjudicado a la app en código: entradas cuyo pid está
//    en los pids recientes de la app (el crash llega con el pid que acaba de
//    morir) o eventos `am_anr` que mencionan el package (ANR best-effort, sin
//    root). Todo lo demás se descarta. Sobrevive a los cambios de pid.
//
// `-T 1` en ambos: al (re)armar no se re-ingesta el histórico completo del buffer
// (evita duplicados en cada re-enganche). Robustez: si un logcat muere solo, se
// re-arma con backoff exponencial suave (1 s → 15 s), reseteado al recibir línea.
import type { AdbTransport } from '../adb/AdbTransport'
import type { LogEntry } from './logEntry'
import { parseLogcatLine } from './parseLogcat'

export const LOGCAT_COMMANDS = {
  app: (pid: number) => `logcat -b main,system --pid=${pid} -v threadtime -v year -T 1`,
  crash: 'logcat -b crash,events -v threadtime -v year -T 1',
} as const

export interface LogcatCaptureOptions {
  /** delay base del backoff de reintento (default 1000 ms) */
  retryBaseMs?: number
  /** delay máximo del backoff (default 15000 ms) */
  retryMaxMs?: number
  /** cuántos pids recientes de la app se recuerdan para adjudicar crashes (default 8) */
  pidMemory?: number
}

interface StreamState {
  stop: (() => void) | null
  /** invalida callbacks de streams viejos tras un re-arme o stop */
  generation: number
  attempts: number
  retryTimer: ReturnType<typeof setTimeout> | null
}

function newStreamState(): StreamState {
  return { stop: null, generation: 0, attempts: 0, retryTimer: null }
}

export class LogcatCapture {
  private readonly app = newStreamState()
  private readonly crash = newStreamState()
  private pid: number | null = null
  /** pids recientes de la app (actual + anteriores): adjudican el buffer crash */
  private readonly knownPids: number[] = []
  private stopped = false

  constructor(
    private readonly transport: AdbTransport,
    private readonly serial: string,
    private readonly pkg: string,
    private readonly onEntry: (entry: LogEntry) => void,
    private readonly opts: LogcatCaptureOptions = {},
  ) {}

  /** Arranca la captura: crash stream siempre; app stream si hay pid. */
  start(pid: number | null): void {
    if (this.stopped) return
    this.armCrash()
    this.setPid(pid)
  }

  /**
   * Cambio de pid en caliente (app murió/renació — el sampler lo detecta):
   * corta el stream viejo y re-arma contra el pid nuevo. Idempotente con el
   * mismo pid; null = app sin proceso ⇒ solo queda el crash stream.
   */
  setPid(pid: number | null): void {
    if (this.stopped || pid === this.pid) return
    this.pid = pid
    if (pid !== null) this.rememberPid(pid)
    this.disarm(this.app)
    if (pid !== null) this.armApp(pid)
  }

  /** Corta ambos streams y cancela reintentos pendientes. Definitivo. */
  stop(): void {
    this.stopped = true
    this.disarm(this.app)
    this.disarm(this.crash)
  }

  private rememberPid(pid: number): void {
    if (this.knownPids.includes(pid)) return
    this.knownPids.push(pid)
    const cap = this.opts.pidMemory ?? 8
    if (this.knownPids.length > cap) this.knownPids.shift()
  }

  private armApp(pid: number): void {
    const gen = ++this.app.generation
    this.app.stop = this.transport.streamShell(
      this.serial,
      LOGCAT_COMMANDS.app(pid),
      (line) => this.onAppLine(gen, line),
      () => this.onStreamExit(this.app, gen, () => this.pid !== null && this.armApp(this.pid)),
    )
  }

  private armCrash(): void {
    const gen = ++this.crash.generation
    this.crash.stop = this.transport.streamShell(
      this.serial,
      LOGCAT_COMMANDS.crash,
      (line) => this.onCrashLine(gen, line),
      () => this.onStreamExit(this.crash, gen, () => this.armCrash()),
    )
  }

  private disarm(s: StreamState): void {
    s.generation++
    if (s.retryTimer) {
      clearTimeout(s.retryTimer)
      s.retryTimer = null
    }
    s.stop?.()
    s.stop = null
    s.attempts = 0
  }

  /** El proceso logcat terminó sin que lo cortáramos: reintentar con backoff. */
  private onStreamExit(s: StreamState, gen: number, rearm: () => void): void {
    if (this.stopped || gen !== s.generation) return // lo cortamos nosotros
    s.stop = null
    const base = this.opts.retryBaseMs ?? 1000
    const max = this.opts.retryMaxMs ?? 15_000
    const delay = Math.min(max, base * 2 ** Math.min(s.attempts, 8))
    s.attempts++
    s.retryTimer = setTimeout(() => {
      s.retryTimer = null
      if (this.stopped || gen !== s.generation) return
      rearm()
    }, delay)
  }

  private onAppLine(gen: number, line: string): void {
    if (this.stopped || gen !== this.app.generation) return
    this.app.attempts = 0 // el stream está vivo: resetear el backoff
    const parsed = parseLogcatLine(line)
    if (!parsed) return
    this.onEntry({ ...parsed, source: 'logcat' })
  }

  private onCrashLine(gen: number, line: string): void {
    if (this.stopped || gen !== this.crash.generation) return
    this.crash.attempts = 0
    const parsed = parseLogcatLine(line)
    if (!parsed) return
    // ANR (buffer events): el tag am_anr trae el package en el payload.
    const isAnr = parsed.tag === 'am_anr' && parsed.message.includes(this.pkg)
    // Crash (buffer crash): el stacktrace llega con el pid de la app que murió.
    const isOwnCrash = this.knownPids.includes(parsed.pid)
    if (!isAnr && !isOwnCrash) return // crash de otra app: no es nuestro
    this.onEntry({ ...parsed, source: 'logcat', isCrash: true })
  }
}
