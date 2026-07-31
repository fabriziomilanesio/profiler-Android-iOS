// Ciclo de vida de la captura de logcat (ticket 027), todo con stub del
// AdbTransport (sin device): armado de streams, filtro de crashes/ANR por pid
// conocido, re-arme por cambio de pid, corte con app muerta y retry con backoff.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdbTransport } from '../adb/AdbTransport'
import type { LogEntry } from './logEntry'
import { LogcatCapture, LOGCAT_COMMANDS } from './logcatCapture'

const PKG = 'com.evermore.oda.qa'
const FIXTURES = join(import.meta.dir, '../../../fixtures/logcat')
const CRASH_FIXTURE = readFileSync(join(FIXTURES, 'crash-events.txt'), 'utf8')
  .split('\n')
  .filter(Boolean)

interface StubStream {
  command: string
  onLine: (line: string) => void
  onExit?: (err: Error | null) => void
  stopped: boolean
}

function stubTransport(): { t: AdbTransport; streams: StubStream[] } {
  const streams: StubStream[] = []
  const t: AdbTransport = {
    isAvailable: async () => true,
    version: async () => '1.0.41',
    devices: async () => [],
    shell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    trackDevices: () => () => {},
    streamShell: (_serial, command, onLine, onExit) => {
      const s: StubStream = { command, onLine, onExit, stopped: false }
      streams.push(s)
      return () => {
        s.stopped = true
      }
    },
  }
  return { t, streams }
}

function capture(opts: { pid?: number | null } = {}) {
  const { t, streams } = stubTransport()
  const entries: LogEntry[] = []
  const cap = new LogcatCapture(t, 'SERIAL', PKG, (e) => entries.push(e), {
    retryBaseMs: 5,
    retryMaxMs: 20,
  })
  cap.start(opts.pid === undefined ? 18743 : opts.pid)
  return { cap, streams, entries }
}

const appStream = (streams: StubStream[]) => streams.filter((s) => s.command.includes('--pid='))
const crashStream = (streams: StubStream[]) => streams.filter((s) => s.command.includes('crash'))

describe('LogcatCapture armado', () => {
  test('start(pid) arma app stream filtrado por pid + crash stream device-wide', () => {
    const { streams } = capture()
    expect(streams).toHaveLength(2)
    expect(streams.map((s) => s.command)).toContain(LOGCAT_COMMANDS.app(18743))
    expect(streams.map((s) => s.command)).toContain(LOGCAT_COMMANDS.crash)
    // formato/opciones que asume el parser y evitan re-ingestar el histórico
    expect(LOGCAT_COMMANDS.app(18743)).toBe(
      'logcat -b main,system --pid=18743 -v threadtime -v year -T 1',
    )
  })

  test('start(null) — app sin proceso: solo el crash stream, sin errores', () => {
    const { streams } = capture({ pid: null })
    expect(streams).toHaveLength(1)
    expect(streams[0]!.command).toBe(LOGCAT_COMMANDS.crash)
  })

  test('las líneas del app stream salen como LogEntry con source logcat', () => {
    const { streams, entries } = capture()
    const app = appStream(streams)[0]!
    app.onLine('2026-07-31 10:15:02.087 18743 18790 I Unity   : hola')
    app.onLine('--------- beginning of main') // separador: se ignora
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'I',
      tag: 'Unity',
      message: 'hola',
      pid: 18743,
      tid: 18790,
      source: 'logcat',
    })
    expect(entries[0]!.isCrash).toBeUndefined()
  })
})

describe('LogcatCapture crashes/ANR', () => {
  test('adjudica el buffer crash por pids recientes de la app y am_anr por package', () => {
    const { cap, streams, entries } = capture() // pid 18743
    cap.setPid(19102) // la app renació con otro pid: ambos son "nuestros"
    const crash = crashStream(streams)[0]!
    for (const line of CRASH_FIXTURE) crash.onLine(line)
    // 7 AndroidRuntime (pid viejo 18743) + F libc (pid nuevo 19102) +
    // 4 F DEBUG (pid de crash_dump 19178, adjudicadas por contenido) + 1 am_anr
    expect(entries).toHaveLength(13)
    expect(entries.every((e) => e.isCrash === true)).toBe(true)
    // el crash de com.other.app (pid 4444) y am_proc_died quedan afuera
    expect(entries.some((e) => e.pid === 4444)).toBe(false)
    expect(entries.some((e) => e.tag === 'am_proc_died')).toBe(false)
    // el stacktrace multi-línea llega en orden
    const java = entries.filter((e) => e.tag === 'AndroidRuntime')
    expect(java[0]!.message).toBe('FATAL EXCEPTION: UnityMain')
    expect(java[3]!.message).toStartWith('\tat com.unity3d.player')
  })

  test('tombstone nativo real: las F DEBUG salen del pid de crash_dump y se capturan enteras', () => {
    const { cap, streams, entries } = capture()
    cap.setPid(19102)
    const crash = crashStream(streams)[0]!
    for (const line of CRASH_FIXTURE) crash.onLine(line)
    // en Android real crash_dump64 emite el tombstone con SU pid (19178 en el
    // fixture), no el de la app: la adjudicación va por `>>> pkg <<<` + memoria
    // del pid emisor para los frames siguientes
    const tomb = entries.filter((e) => e.tag === 'DEBUG')
    expect(tomb).toHaveLength(4)
    expect(tomb.every((e) => e.pid === 19178)).toBe(true)
    // completo: incluye el banner PREVIO a la línea `>>> pkg <<<` (retro-adjudicado)…
    expect(tomb[0]!.message).toStartWith('*** ***')
    expect(tomb[1]!.message).toStartWith('Build fingerprint:')
    expect(tomb[2]!.message).toContain('>>> com.evermore.oda.qa <<<')
    // …y el frame nativo posterior, que ya no menciona el package
    expect(tomb[3]!.message).toContain('#00 pc')
    expect(tomb[3]!.message).toEndWith('libil2cpp.so')
    // la línea `F libc: Fatal signal` sí llega con el pid de la app (19102)
    const libc = entries.filter((e) => e.tag === 'libc')
    expect(libc).toHaveLength(1)
    expect(libc[0]!.pid).toBe(19102)
  })
})

describe('LogcatCapture ciclo de vida', () => {
  test('setPid re-arma el app stream y el viejo queda mudo (generation guard)', () => {
    const { cap, streams, entries } = capture()
    const old = appStream(streams)[0]!
    cap.setPid(222)
    expect(old.stopped).toBe(true)
    expect(appStream(streams).map((s) => s.command)).toContain(LOGCAT_COMMANDS.app(222))
    // una línea rezagada del stream viejo (carrera del kill) no emite nada
    old.onLine('2026-07-31 10:15:02.087 18743 18790 I Unity   : zombie')
    expect(entries).toHaveLength(0)
  })

  test('setPid con el mismo pid es no-op (no re-arma por tick)', () => {
    const { cap, streams } = capture()
    cap.setPid(18743)
    cap.setPid(18743)
    expect(streams).toHaveLength(2) // app + crash originales, nada nuevo
  })

  test('setPid(null) — app muerta: corta el app stream, el crash stream sigue vivo', () => {
    const { cap, streams } = capture()
    cap.setPid(null)
    expect(appStream(streams)[0]!.stopped).toBe(true)
    expect(appStream(streams)).toHaveLength(1) // no se armó otro
    expect(crashStream(streams)[0]!.stopped).toBe(false)
  })

  test('logcat muere solo ⇒ re-arma con backoff; una línea resetea los intentos', async () => {
    const { streams } = capture()
    const app = appStream(streams)[0]!
    app.onExit?.(null) // murió sin que lo cortáramos
    expect(appStream(streams)).toHaveLength(1) // el retry espera el backoff
    await new Promise((r) => setTimeout(r, 30))
    const rearmed = appStream(streams)
    expect(rearmed).toHaveLength(2)
    expect(rearmed[1]!.command).toBe(LOGCAT_COMMANDS.app(18743))
  })

  test('una línea NO parseable no resetea el backoff (logcat que solo escupe separadores)', async () => {
    // backoff más ancho para que los sleeps distingan 1er delay (30) de 2do (60)
    const { t, streams } = stubTransport()
    new LogcatCapture(t, 'SERIAL', PKG, () => {}, { retryBaseMs: 30, retryMaxMs: 500 }).start(18743)
    appStream(streams)[0]!.onExit?.(null) // attempts 0→1, retry en 30 ms
    await new Promise((r) => setTimeout(r, 45))
    const rearmed = appStream(streams)[1]!
    rearmed.onLine('--------- beginning of main') // separador: el stream NO está sano
    rearmed.onExit?.(null) // sin reset ⇒ attempts 1→2, retry en 60 ms
    await new Promise((r) => setTimeout(r, 35))
    expect(appStream(streams)).toHaveLength(2) // con reset habría re-armado ya (30 ms)
    await new Promise((r) => setTimeout(r, 45))
    expect(appStream(streams)).toHaveLength(3) // el backoff siguió su curso
  })

  test("doble onExit del mismo proceso ('error' + 'close') programa UN solo retry", async () => {
    const { t, streams } = stubTransport()
    new LogcatCapture(t, 'SERIAL', PKG, () => {}, { retryBaseMs: 30, retryMaxMs: 500 }).start(18743)
    const app = appStream(streams)[0]!
    app.onExit?.(null) // 'error': attempts 0→1, retry en 30 ms
    app.onExit?.(null) // 'close' del MISMO proceso: ignorado (retry ya programado)
    await new Promise((r) => setTimeout(r, 45))
    expect(appStream(streams)).toHaveLength(2) // un solo re-arme, sin timer fantasma
    // la progresión del backoff no se infló: el próximo retry es 60 ms (no 120)
    appStream(streams)[1]!.onExit?.(null)
    await new Promise((r) => setTimeout(r, 80))
    expect(appStream(streams)).toHaveLength(3)
  })

  test('el re-arme no duplica la línea histórica que -T 1 re-entrega', async () => {
    const { streams, entries } = capture()
    const crash = crashStream(streams)[0]!
    const fatal =
      '2026-07-31 10:22:30.500 18743 18790 F libc    : Fatal signal 11 (SIGSEGV), code 1'
    crash.onLine(fatal)
    expect(entries).toHaveLength(1)
    crash.onExit?.(null) // el crash stream murió: re-arme con backoff
    await new Promise((r) => setTimeout(r, 30))
    const rearmed = crashStream(streams)[1]!
    rearmed.onLine(fatal) // histórico de -T 1: la MISMA línea ⇒ dedupeada
    expect(entries).toHaveLength(1)
    rearmed.onLine(fatal) // una repetición posterior real sí entra
    expect(entries).toHaveLength(2)
  })

  test('stop() corta los streams vivos y cancela reintentos pendientes', async () => {
    const { cap, streams } = capture()
    crashStream(streams)[0]!.onExit?.(null) // el crash stream murió solo: retry en vuelo
    cap.stop()
    await new Promise((r) => setTimeout(r, 30))
    expect(appStream(streams)[0]!.stopped).toBe(true) // el vivo se cortó
    expect(streams).toHaveLength(2) // el retry cancelado no armó nada nuevo
  })
})
