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
//    un pid que ya murió), adjudicado a la app en código por tres vías:
//      1. pid en los pids recientes de la app (los crashes Java de AndroidRuntime
//         y la línea `F libc: Fatal signal...` salen con el pid que acaba de morir);
//      2. mensaje que menciona el package (`>>> pkg <<<` del tombstone /
//         `Process: pkg` de AndroidRuntime) — en Android real las líneas `F DEBUG`
//         del tombstone las emite crash_dump64 con SU propio pid, no el de la app;
//      3. pid emisor recordado tras una mención (2): los frames siguientes del
//         mismo tombstone (`#00 pc ...`) llegan del mismo crash_dump sin repetir
//         el package. El banner previo a la mención se retiene en un buffer corto
//         y se libera retroactivamente al adjudicar el pid (tombstone completo).
//    También eventos `am_anr` que mencionan el package (ANR best-effort, sin
//    root). Todo lo demás se descarta. Sobrevive a los cambios de pid.
//
// `-T 1` en ambos: al (re)armar no se re-ingesta el histórico completo del buffer
// (evita duplicados en cada re-enganche). La única línea histórica que -T 1 sí
// re-entrega se dedupea contra la última emitida (la línea de un crash no debe
// aparecer dos veces tras un re-arme). Robustez: si un logcat muere solo, se
// re-arma con backoff exponencial suave (1 s → 15 s), reseteado al recibir una
// línea VÁLIDA (una que solo escupe separadores no re-arma en caliente para siempre).
import type { AdbTransport } from '../adb/AdbTransport'
import type { LogEntry } from './logEntry'
import { parseLogcatLine, type ParsedLogcatLine } from './parseLogcat'

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
  /** clave de la última entrada emitida (dedup de la línea histórica de -T 1) */
  lastKey: string | null
  /** recién (re)armado: la primera línea idéntica a lastKey es histórico re-entregado */
  dropDupHead: boolean
}

function newStreamState(): StreamState {
  return {
    stop: null,
    generation: 0,
    attempts: 0,
    retryTimer: null,
    lastKey: null,
    dropDupHead: false,
  }
}

function entryKey(p: ParsedLogcatLine): string {
  return `${p.ts}|${p.pid}|${p.tid}|${p.level}|${p.tag}|${p.message}`
}

/** Cuántas líneas del buffer crash aún sin adjudicar se retienen (banner del tombstone). */
const PENDING_CRASH_CAP = 64

export class LogcatCapture {
  private readonly app = newStreamState()
  private readonly crash = newStreamState()
  private pid: number | null = null
  /** pids recientes de la app (actual + anteriores): adjudican el buffer crash */
  private readonly knownPids: number[] = []
  /** pids emisores adjudicados por mencionar el package (crash_dump del tombstone) */
  private readonly reporterPids: number[] = []
  /** líneas del buffer crash aún sin adjudicar (banner del tombstone previo al `>>> pkg <<<`) */
  private readonly pendingCrash: ParsedLogcatLine[] = []
  /** `>>> pkg <<<` (tombstone) o `Process: pkg` (AndroidRuntime), con borde de palabra */
  private readonly mentionRe: RegExp
  private stopped = false

  constructor(
    private readonly transport: AdbTransport,
    private readonly serial: string,
    private readonly pkg: string,
    private readonly onEntry: (entry: LogEntry) => void,
    private readonly opts: LogcatCaptureOptions = {},
  ) {
    const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    this.mentionRe = new RegExp(`>>> ${esc} <<<|Process: ${esc}(?=[,\\s]|$)`)
  }

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
    this.app.dropDupHead = true // -T 1 re-entrega la última línea del buffer
    this.app.stop = this.transport.streamShell(
      this.serial,
      LOGCAT_COMMANDS.app(pid),
      (line) => this.onAppLine(gen, line),
      () => this.onStreamExit(this.app, gen, () => this.pid !== null && this.armApp(this.pid)),
    )
  }

  private armCrash(): void {
    const gen = ++this.crash.generation
    this.crash.dropDupHead = true // -T 1 re-entrega la última línea del buffer
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
    // 'error' + 'close' del MISMO proceso disparan dos callbacks: el segundo no
    // debe incrementar attempts otra vez ni pisar el timer ya programado.
    if (s.retryTimer !== null) return
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

  /**
   * Emite una entrada del stream `s` con dedup de cabeza: la primera línea tras
   * un (re)arme idéntica a la última emitida es el histórico que -T 1 re-entrega.
   */
  private emit(s: StreamState, parsed: ParsedLogcatLine, isCrash?: boolean): void {
    const key = entryKey(parsed)
    if (s.dropDupHead) {
      s.dropDupHead = false
      if (key === s.lastKey) return
    }
    s.lastKey = key
    if (isCrash) this.onEntry({ ...parsed, source: 'logcat', isCrash: true })
    else this.onEntry({ ...parsed, source: 'logcat' })
  }

  private onAppLine(gen: number, line: string): void {
    if (this.stopped || gen !== this.app.generation) return
    const parsed = parseLogcatLine(line)
    if (!parsed) return
    // backoff: resetear recién con una entrada VÁLIDA (un logcat que solo imprime
    // `--------- beginning of main` y muere no debe re-armarse cada 1 s por siempre)
    this.app.attempts = 0
    this.emit(this.app, parsed)
  }

  private rememberReporter(pid: number): void {
    if (this.reporterPids.includes(pid)) return
    this.reporterPids.push(pid)
    const cap = this.opts.pidMemory ?? 8
    if (this.reporterPids.length > cap) this.reporterPids.shift()
  }

  private onCrashLine(gen: number, line: string): void {
    if (this.stopped || gen !== this.crash.generation) return
    const parsed = parseLogcatLine(line)
    if (!parsed) return
    this.crash.attempts = 0 // ídem app: solo una entrada válida resetea el backoff
    // ANR (buffer events): el tag am_anr trae el package en el payload.
    const isAnr = parsed.tag === 'am_anr' && parsed.message.includes(this.pkg)
    // Crash con el pid de la app que murió (AndroidRuntime, `F libc: Fatal signal`)
    // o de un crash_dump ya adjudicado (frames siguientes del tombstone).
    const isOwnPid = this.knownPids.includes(parsed.pid) || this.reporterPids.includes(parsed.pid)
    if (isAnr || isOwnPid) {
      this.emit(this.crash, parsed, true)
      return
    }
    // Tombstone nativo: crash_dump64 emite con SU pid, pero el mensaje menciona el
    // package (`pid: X ... >>> pkg <<<`). Adjudicar el pid emisor y liberar el
    // banner previo del mismo pid retenido en pendingCrash (tombstone completo).
    if (this.mentionRe.test(parsed.message)) {
      this.rememberReporter(parsed.pid)
      for (let i = 0; i < this.pendingCrash.length; i++) {
        const p = this.pendingCrash[i]!
        if (p.pid !== parsed.pid) continue
        this.pendingCrash.splice(i, 1)
        i--
        this.emit(this.crash, p, true)
      }
      this.emit(this.crash, parsed, true)
      return
    }
    // Sin adjudicar (¿banner de un tombstone nuestro que aún no mencionó el
    // package?): retener por si una mención posterior lo reclama. Cap corto:
    // crashes ajenos que nunca se reclaman no acumulan memoria.
    this.pendingCrash.push(parsed)
    if (this.pendingCrash.length > PENDING_CRASH_CAP) this.pendingCrash.shift()
  }
}
