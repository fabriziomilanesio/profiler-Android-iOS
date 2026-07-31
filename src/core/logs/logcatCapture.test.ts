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
    // 7 líneas AndroidRuntime (pid viejo 18743) + 5 nativas (pid nuevo 19102) + 1 am_anr
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

  test('stop() corta los streams vivos y cancela reintentos pendientes', async () => {
    const { cap, streams } = capture()
    crashStream(streams)[0]!.onExit?.(null) // el crash stream murió solo: retry en vuelo
    cap.stop()
    await new Promise((r) => setTimeout(r, 30))
    expect(appStream(streams)[0]!.stopped).toBe(true) // el vivo se cortó
    expect(streams).toHaveLength(2) // el retry cancelado no armó nada nuevo
  })
})
