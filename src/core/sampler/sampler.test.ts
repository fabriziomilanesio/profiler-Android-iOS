// Tests del sampler (ticket 021): loop de collectors sobre AdbTransport.shell(),
// arma el Sample, best-effort (un collector que falla ⇒ métrica null sin romper).
// Usa un stub in-line de AdbTransport que responde por comando (patrón del preflight).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdbTransport, ShellResult } from '../adb/AdbTransport'
import { Sampler, SHELL_COMMANDS } from './sampler'

const FIX = join(import.meta.dir, '../../../fixtures/sm-a155m-api36')
const read = (p: string): string => readFileSync(join(FIX, p), 'utf8')
const PKG = 'com.evermore.oda.qa'

/** Transport que responde por substring del comando con outputs de fixture. */
function fixtureTransport(routes: Array<[RegExp, string | (() => ShellResult)]>): AdbTransport {
  return {
    isAvailable: async () => true,
    version: async () => '1.0.41',
    devices: async () => [],
    trackDevices: () => () => {},
    streamShell: () => () => {},
    shell: async (_serial, command): Promise<ShellResult> => {
      for (const [re, out] of routes) {
        if (re.test(command)) {
          if (typeof out === 'function') return out()
          return { stdout: out, stderr: '', exitCode: 0 }
        }
      }
      return { stdout: '', stderr: 'no route', exitCode: 1 }
    },
  }
}

function happyRoutes(): Array<[RegExp, string]> {
  return [
    // `dumpsys meminfo` explícito: el cat combinado también contiene "/proc/meminfo"
    [/dumpsys meminfo/, read('oneshot/dumpsys-meminfo.txt')],
    [/gpu_busy/, read('oneshot/gpu-samsung-gpu-busy.txt')],
    [/thermalservice/, read('oneshot/dumpsys-thermalservice.txt')],
    [/timestats/, read('session/final/timestats-dump.txt')],
    [/dumpsys battery/, read('oneshot/dumpsys-battery.txt')],
    [/pidof/, '18078\n'],
    [/ps -A/, 'PID NAME\n1 init\n18078 ' + PKG + '\n'],
    // el comando real combina: `cat /proc/stat /proc/meminfo /proc/<pid>/stat /proc/<pid>/status`
    [
      /cat \/proc\/stat/,
      read('oneshot/proc-stat.txt') +
        '\n' +
        read('oneshot/proc-meminfo.txt') +
        '\n' +
        read('oneshot/proc-pid-stat.txt') +
        '\nName:\tevermore.oda.qa\nVmRSS:\t  204800 kB\n',
    ],
  ]
}

/** Envuelve el shell del transport para loguear cada comando. */
function logged(t: AdbTransport): { t: AdbTransport; calls: string[] } {
  const calls: string[] = []
  const orig = t.shell
  t.shell = async (serial, command) => {
    calls.push(command)
    return orig(serial, command)
  }
  return { t, calls }
}

describe('Sampler', () => {
  test('emite un Sample con números reales coherentes del fixture', async () => {
    const t = fixtureTransport(happyRoutes())
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078)
    const s = await sampler.sampleOnce()

    expect(s.mem.pss).toBeCloseTo(905, 0)
    expect(s.mem.graphics).toBeCloseTo(411.6, 0)
    expect(s.gpu).toBe(99)
    expect(s.tempC).toBeCloseTo(30.9, 1)
    expect(s.fps).toBeCloseTo(33.94, 2)
    expect(s.battery.levelPct).toBe(99)
    expect(s.battery.tempC).toBeCloseTo(25.7, 1)
    expect(s.battery.charging).toBe(true)
    expect(typeof s.ts).toBe('number')
    // RSS vivo del /proc/<pid>/status embebido en el cat combinado (204800 kB = 200 MB)
    expect(s.mem.rss).toBeCloseTo(200, 0)
    // frame-times del MISMO dump de timestats (ticket 024): sin comandos extra
    expect(s.frame.p50Ms).toBe(33)
    expect(s.frame.totalFrames).toBe(1178)
  })

  test('frame-times/jank usan el refreshHz del device (90 Hz ⇒ cadencia de 3 vsyncs)', async () => {
    const t = fixtureTransport(happyRoutes())
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078, { refreshHz: 90 })
    const s = await sampler.sampleOnce()
    // layer real: 1178 frames, 11 por encima de la cadencia (44 ms ×10 + 58 ms ×1)
    expect(s.frame.p50Ms).toBe(33)
    expect(s.frame.p90Ms).toBe(33)
    expect(s.frame.p99Ms).toBe(33)
    expect(s.frame.jankFrames).toBe(11)
    expect(s.frame.jankPct).toBeCloseTo((11 / 1178) * 100, 3)
  })

  test('timestats que falla ⇒ frame todo null (best-effort, sin romper el tick)', async () => {
    const routes = happyRoutes().filter(([re]) => !/timestats/.test(re.source))
    const t = fixtureTransport(routes) // el dump de FPS devuelve exitCode 1 vacío
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078, { refreshHz: 90 })
    const s = await sampler.sampleOnce()
    expect(s.fps).toBeNull()
    expect(s.frame.p50Ms).toBeNull()
    expect(s.frame.jankPct).toBeNull()
    expect(s.mem.pss).toBeCloseTo(905, 0) // el resto intacto
  })

  test('CPU sale null en la primera muestra (no hay snapshot previo) y número en la segunda', async () => {
    const t = fixtureTransport(happyRoutes())
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078)
    const first = await sampler.sampleOnce()
    expect(first.cpu).toBeNull() // sin previo
    expect(first.deviceCpu).toBeNull() // device CPU también es delta
    const second = await sampler.sampleOnce()
    expect(second.cpu).not.toBeNull() // ya hay delta (aunque sea 0)
    expect(second.cpu).toBeGreaterThanOrEqual(0)
    expect(second.deviceCpu).not.toBeNull()
    expect(second.deviceCpu!).toBeGreaterThanOrEqual(0)
    expect(second.deviceCpu!).toBeLessThanOrEqual(100)
  })

  test('deviceRamUsedMb sale del /proc/meminfo del cat combinado (primer tick ya)', async () => {
    const t = fixtureTransport(happyRoutes())
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078)
    const s = await sampler.sampleOnce()
    expect(s.deviceRamUsedMb).not.toBeNull()
    expect(s.deviceRamUsedMb!).toBeGreaterThan(0)
    expect(s.deviceRamUsedMb!).toBeLessThan(3667) // ≤ MemTotal del fixture
  })

  test('refreshPid detecta hijos y agrega su PSS al de la app', async () => {
    const psOut = ['PID NAME', '1 init', `18078 ${PKG}`, `18100 ${PKG}:service`].join('\n')
    const mainMem = read('oneshot/dumpsys-meminfo.txt') // TOTAL PSS ≈ 905 MB
    // hijo sintético con App Summary mínimo: TOTAL PSS 102400 KB = 100 MB
    const childMem = [
      'App Summary',
      '   Java Heap:    1024',
      '   TOTAL PSS:   102400       TOTAL RSS: 1 TOTAL SWAP PSS: 0',
    ].join('\n')
    const routes: Array<[RegExp, string]> = [
      [/dumpsys meminfo 18100/, childMem],
      [/dumpsys meminfo/, mainMem],
      [/ps -A/, psOut],
      [
        /cat \/proc\/stat/,
        read('oneshot/proc-stat.txt') + '\n' + read('oneshot/proc-pid-stat.txt'),
      ],
    ]
    const t = fixtureTransport(routes)
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078)
    const alive = await sampler.refreshPid()
    expect(alive).toBe(true)
    const s = await sampler.sampleOnce()
    expect(s.mem.pss).toBeCloseTo(905 + 100, 0) // main + hijo
    expect(s.mem.java).toBeCloseTo(12.64 + 1, 0)
  })

  test('refreshPid: proceso desaparecido ⇒ false y pid 0; ps que falla ⇒ null (sin concluir)', async () => {
    const t = fixtureTransport([[/ps -A/, 'PID NAME\n1 init\n']])
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078)
    expect(await sampler.refreshPid()).toBe(false)
    expect(sampler.processId).toBe(0)

    const broken = fixtureTransport([]) // ps devuelve exitCode 1 sin output útil
    const sampler2 = new Sampler(broken, 'REDACTED-SERIAL', PKG, 18078)
    expect(await sampler2.refreshPid()).toBeNull()
    expect(sampler2.processId).toBe(18078) // no tocó el pid
  })

  test('best-effort: un collector que falla ⇒ su métrica null, el resto sigue', async () => {
    // gpu_busy falla (err), lo demás ok
    const routes = happyRoutes().map(
      ([re, out]) =>
        [re, /gpu_busy/.test(re.source) ? 'cat: gpu_busy: No such file' : out] as [RegExp, string],
    )
    const t = fixtureTransport(routes)
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078)
    const s = await sampler.sampleOnce()
    expect(s.gpu).toBeNull() // colapsó a N/A
    expect(s.mem.pss).toBeCloseTo(905, 0) // el resto intacto
    expect(s.fps).toBeCloseTo(33.94, 2)
  })

  test('un shell que tira excepción no rompe el Sample entero', async () => {
    const t = fixtureTransport(happyRoutes())
    // envolver shell para que thermal explote
    const orig = t.shell
    t.shell = async (serial, command) => {
      if (/thermalservice/.test(command)) throw new Error('boom')
      return orig(serial, command)
    }
    const sampler = new Sampler(t, 'REDACTED-SERIAL', PKG, 18078)
    const s = await sampler.sampleOnce()
    expect(s.tempC).toBeNull()
    expect(s.mem.pss).toBeCloseTo(905, 0)
  })

  test('SHELL_COMMANDS expone los comandos (documentación viva de las fuentes)', () => {
    expect(SHELL_COMMANDS.gpu).toContain('/sys/kernel/gpu/gpu_busy')
    expect(SHELL_COMMANDS.fps).toContain('timestats')
    expect(SHELL_COMMANDS.cpu([42])).toContain('/proc/42/status') // VmRSS en el cat combinado
  })
})

describe('Sampler — carriles (ticket 023: el loop exigía al device)', () => {
  const meminfoCalls = (calls: string[]) =>
    calls.filter((c) => c.startsWith('dumpsys meminfo')).length
  const psCalls = (calls: string[]) => calls.filter((c) => c.startsWith('ps -A')).length

  test('meminfo/thermal/battery corren en el primer tick, carry-forward después, y de nuevo al vencer su ventana', async () => {
    let clock = 1_000_000
    const { t, calls } = logged(fixtureTransport(happyRoutes()))
    const sampler = new Sampler(t, 'S', PKG, 18078, { now: () => clock })

    const s1 = await sampler.sampleOnce()
    expect(s1.mem.pss).toBeCloseTo(905, 0)
    expect(meminfoCalls(calls)).toBe(1)
    const slowCalls = calls.length

    clock += 1000
    const s2 = await sampler.sampleOnce()
    expect(meminfoCalls(calls)).toBe(1) // dentro de la ventana: no re-corre
    expect(calls.slice(slowCalls).some((c) => c.includes('thermalservice'))).toBe(false)
    expect(calls.slice(slowCalls).some((c) => c.startsWith('dumpsys battery'))).toBe(false)
    // carry-forward: el Sample sigue completo para UI/reporte
    expect(s2.mem.pss).toBeCloseTo(905, 0)
    expect(s2.tempC).toBeCloseTo(30.9, 1)
    expect(s2.battery.levelPct).toBe(99)
    // lo rápido sí es fresco cada tick
    expect(s2.mem.rss).toBeCloseTo(200, 0)
    expect(s2.fps).toBeCloseTo(33.94, 2)

    clock += 15_000 // vence meminfoMs (15 s) y slowMs (10 s)
    await sampler.sampleOnce()
    expect(meminfoCalls(calls)).toBe(2)
  })

  test('la corrida lenta que falla vuelve a null (N/A honesto), no queda un valor viejo', async () => {
    let clock = 1_000_000
    let broken = false
    const base = fixtureTransport(happyRoutes())
    const orig = base.shell
    base.shell = async (serial, command) => {
      if (broken && command.startsWith('dumpsys meminfo')) {
        return { stdout: '', stderr: 'No process found', exitCode: 1 }
      }
      return orig(serial, command)
    }
    const sampler = new Sampler(base, 'S', PKG, 18078, { now: () => clock })
    expect((await sampler.sampleOnce()).mem.pss).toBeCloseTo(905, 0)
    broken = true
    clock += 16_000
    expect((await sampler.sampleOnce()).mem.pss).toBeNull()
  })

  test('refreshPid: ps -A corre al vencer psMs; entre medio la vida la sostiene el cat combinado', async () => {
    let clock = 1_000_000
    const { t, calls } = logged(fixtureTransport(happyRoutes()))
    const sampler = new Sampler(t, 'S', PKG, 18078, { now: () => clock })

    expect(await sampler.refreshPid()).toBe(true)
    expect(psCalls(calls)).toBe(1)
    clock += 1000
    expect(await sampler.refreshPid()).toBe(true) // gated: sin adb
    expect(psCalls(calls)).toBe(1)
    clock += 10_000
    expect(await sampler.refreshPid()).toBe(true)
    expect(psCalls(calls)).toBe(2)
  })

  test('muerte detectada por el carril rápido: el pid falta en el cat ⇒ el próximo refreshPid corre ps ya', async () => {
    let clock = 1_000_000
    const routes: Array<[RegExp, string]> = [
      // cat combinado SIN la línea del pid (proceso muerto): /proc/<pid>/stat falló
      [/cat \/proc\/stat/, read('oneshot/proc-stat.txt') + '\n' + read('oneshot/proc-meminfo.txt')],
      [/ps -A/, 'PID NAME\n1 init\n'],
      [/dumpsys meminfo/, ''],
    ]
    const { t, calls } = logged(fixtureTransport(routes))
    const sampler = new Sampler(t, 'S', PKG, 18078, { now: () => clock })

    // el sample ve que el pid no está en el cat; el refresh siguiente corre ps aunque
    // esté dentro de la ventana de psMs
    await sampler.sampleOnce()
    const before = psCalls(calls)
    clock += 1000
    expect(await sampler.refreshPid()).toBe(false) // corrió ps pese a estar dentro de la ventana
    expect(psCalls(calls)).toBe(before + 1)
    expect(sampler.processId).toBe(0)
  })
})
