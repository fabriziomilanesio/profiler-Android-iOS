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
    // el comando real combina: `cat /proc/stat /proc/meminfo /proc/<pid>/stat`
    [
      /cat \/proc\/stat/,
      read('oneshot/proc-stat.txt') +
        '\n' +
        read('oneshot/proc-meminfo.txt') +
        '\n' +
        read('oneshot/proc-pid-stat.txt'),
    ],
  ]
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
  })
})
