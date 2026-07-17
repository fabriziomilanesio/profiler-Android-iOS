import { describe, expect, test } from 'bun:test'
import type { AdbDevice, AdbTransport, ShellResult } from '../adb/AdbTransport'
import { Preflight, advance, type PreflightReport } from './preflight'

const PKG = 'com.evermore.oda.qa'

/**
 * Stub in-line del AdbTransport (NO es el fake-adb del ticket 009: acá alcanza
 * con respuestas enlatadas por escenario).
 */
function stubTransport(overrides: Partial<AdbTransport> = {}): AdbTransport {
  return {
    isAvailable: async () => true,
    version: async () => 'Android Debug Bridge version 1.0.41',
    devices: async () => [],
    shell: async (): Promise<ShellResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
    trackDevices: () => () => {},
    ...overrides,
  }
}

function device(serial: string, state: string, description = ''): AdbDevice {
  return { serial, state, description }
}

function linkById(report: PreflightReport, id: string) {
  const link = report.links.find((l) => l.id === id)
  if (!link) throw new Error(`link '${id}' no está en el report`)
  return link
}

describe('advance (transiciones puras de la máquina)', () => {
  test('Start → AdbMissing / AdbOk', () => {
    expect(advance('Start', { kind: 'adb', available: false })).toBe('AdbMissing')
    expect(advance('Start', { kind: 'adb', available: true })).toBe('AdbOk')
  })

  test('AdbOk → NoDevice / DeviceUnauthorized / DeviceOk', () => {
    expect(advance('AdbOk', { kind: 'devices', devices: [] })).toBe('NoDevice')
    expect(advance('AdbOk', { kind: 'devices', devices: [device('X', 'unauthorized')] })).toBe(
      'DeviceUnauthorized',
    )
    expect(advance('AdbOk', { kind: 'devices', devices: [device('X', 'device')] })).toBe('DeviceOk')
    // offline no cuenta como usable ni como unauthorized
    expect(advance('AdbOk', { kind: 'devices', devices: [device('X', 'offline')] })).toBe(
      'NoDevice',
    )
    // un usable gana aunque haya otro unauthorized
    expect(
      advance('AdbOk', {
        kind: 'devices',
        devices: [device('A', 'unauthorized'), device('B', 'device')],
      }),
    ).toBe('DeviceOk')
  })

  test('DeviceOk → AppMissing / Ready', () => {
    expect(advance('DeviceOk', { kind: 'app', installed: false })).toBe('AppMissing')
    expect(advance('DeviceOk', { kind: 'app', installed: true })).toBe('Ready')
  })

  test('observación que no corresponde al estado tira error', () => {
    expect(() => advance('Start', { kind: 'app', installed: true })).toThrow()
  })
})

describe('Preflight.check', () => {
  test('adb ausente → AdbMissing, con remedio y los demás eslabones skipped', async () => {
    const transport = stubTransport({ isAvailable: async () => false })
    const report = await new Preflight(transport, PKG).check()

    expect(report.state).toBe('AdbMissing')
    expect(report.ready).toBe(false)
    expect(linkById(report, 'adb').result).toBe('fail')
    expect(linkById(report, 'adb').remedy).toMatch(/platform-tools/i)
    expect(linkById(report, 'device').result).toBe('skipped')
    expect(linkById(report, 'app').result).toBe('skipped')
  })

  test('adb ok pero sin devices → NoDevice con remedio de depuración USB', async () => {
    const report = await new Preflight(stubTransport(), PKG).check()

    expect(report.state).toBe('NoDevice')
    expect(linkById(report, 'adb').result).toBe('ok')
    expect(linkById(report, 'adb').detail).toContain('1.0.41')
    expect(linkById(report, 'device').result).toBe('fail')
    expect(linkById(report, 'device').remedy).toMatch(/depuración USB/i)
    expect(linkById(report, 'app').result).toBe('skipped')
  })

  test('device unauthorized → explica el diálogo del teléfono', async () => {
    const transport = stubTransport({
      devices: async () => [device('R58M42XXXX', 'unauthorized')],
    })
    const report = await new Preflight(transport, PKG).check()

    expect(report.state).toBe('DeviceUnauthorized')
    expect(linkById(report, 'device').result).toBe('fail')
    expect(linkById(report, 'device').remedy).toMatch(/diálogo/i)
    expect(linkById(report, 'device').remedy).toMatch(/permitir depuración/i)
  })

  test('device ok pero app no instalada → AppMissing con remedio de install', async () => {
    const transport = stubTransport({
      devices: async () => [device('R58M42XXXX', 'device', 'model:SM_G973F')],
      shell: async () => ({ stdout: 'package:com.android.chrome\n', stderr: '', exitCode: 0 }),
    })
    const report = await new Preflight(transport, PKG).check()

    expect(report.state).toBe('AppMissing')
    expect(linkById(report, 'device').result).toBe('ok')
    expect(linkById(report, 'app').result).toBe('fail')
    expect(linkById(report, 'app').remedy).toContain(PKG)
  })

  test('todo verde → Ready, con el device elegido en el report', async () => {
    let shellCall: { serial: string; command: string } | undefined
    const transport = stubTransport({
      devices: async () => [device('R58M42XXXX', 'device', 'model:SM_G973F')],
      shell: async (serial, command) => {
        shellCall = { serial, command }
        return { stdout: `package:${PKG}\n`, stderr: '', exitCode: 0 }
      },
    })
    const report = await new Preflight(transport, PKG).check()

    expect(report.state).toBe('Ready')
    expect(report.ready).toBe(true)
    expect(report.device?.serial).toBe('R58M42XXXX')
    expect(report.links.every((l) => l.result === 'ok')).toBe(true)
    // el check de app va por pm list packages vía transport.shell
    expect(shellCall).toEqual({ serial: 'R58M42XXXX', command: `pm list packages ${PKG}` })
  })

  test('pm list matchea el package EXACTO, no por prefijo', async () => {
    const transport = stubTransport({
      devices: async () => [device('X', 'device')],
      // pm list packages <pkg> filtra por substring: puede devolver vecinos
      shell: async () => ({ stdout: `package:${PKG}.debug\n`, stderr: '', exitCode: 0 }),
    })
    const report = await new Preflight(transport, PKG).check()
    expect(report.state).toBe('AppMissing')
  })

  test('shell que falla (exit != 0) → AppMissing con el stderr como detalle', async () => {
    const transport = stubTransport({
      devices: async () => [device('X', 'device')],
      shell: async () => ({ stdout: '', stderr: 'error: closed', exitCode: 1 }),
    })
    const report = await new Preflight(transport, PKG).check()
    expect(report.state).toBe('AppMissing')
    expect(linkById(report, 'app').detail).toContain('error: closed')
  })
})
