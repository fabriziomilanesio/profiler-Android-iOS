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
    [/meminfo/, read('oneshot/dumpsys-meminfo.txt')],
    [/gpu_busy/, read('oneshot/gpu-samsung-gpu-busy.txt')],
    [/thermalservice/, read('oneshot/dumpsys-thermalservice.txt')],
    [/timestats/, read('session/final/timestats-dump.txt')],
    [/dumpsys battery/, read('oneshot/dumpsys-battery.txt')],
    [/pidof|ps -A|pgrep/, '18078\n'],
    // el comando real combina ambos: `cat /proc/stat /proc/<pid>/stat`
    [/cat \/proc\/stat/, read('oneshot/proc-stat.txt') + '\n' + read('oneshot/proc-pid-stat.txt')],
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
    const second = await sampler.sampleOnce()
    expect(second.cpu).not.toBeNull() // ya hay delta (aunque sea 0)
    expect(second.cpu).toBeGreaterThanOrEqual(0)
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
