import { describe, expect, test } from 'bun:test'
import type { AdbTransport, ShellResult } from './AdbTransport'
import { listPackages, parsePackageList } from './listPackages'

const PM_OUT = [
  'package:com.evermore.oda.qa',
  'package:com.android.chrome',
  'package:com.evermore.arcade',
  '', // línea vacía
  'garbage line without prefix',
  'package:', // prefijo sin nombre
  'package:org.fdroid.fdroid  ', // trailing whitespace
].join('\n')

describe('parsePackageList', () => {
  test('extrae solo las líneas package: y ordena alfabéticamente', () => {
    expect(parsePackageList(PM_OUT)).toEqual([
      'com.android.chrome',
      'com.evermore.arcade',
      'com.evermore.oda.qa',
      'org.fdroid.fdroid',
    ])
  })

  test('output vacío ⇒ lista vacía', () => {
    expect(parsePackageList('')).toEqual([])
  })

  test('descarta nombres que no validan como package (defensa contra output raro)', () => {
    expect(parsePackageList('package:pelotudeces con espacios\npackage:com.ok.app')).toEqual([
      'com.ok.app',
    ])
  })
})

function transportWith(expectCmd: RegExp, stdout: string): { t: AdbTransport; cmds: string[] } {
  const cmds: string[] = []
  const t: AdbTransport = {
    isAvailable: async () => true,
    version: async () => '1.0.41',
    devices: async () => [],
    trackDevices: () => () => {},
    shell: async (_serial, command): Promise<ShellResult> => {
      cmds.push(command)
      if (expectCmd.test(command)) return { stdout, stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'no route', exitCode: 1 }
    },
  }
  return { t, cmds }
}

describe('listPackages', () => {
  test('por default lista solo apps de terceros (pm list packages -3)', async () => {
    const { t, cmds } = transportWith(/pm list packages -3/, PM_OUT)
    const pkgs = await listPackages(t, 'SERIAL', {})
    expect(pkgs).toContain('com.evermore.oda.qa')
    expect(cmds[0]).toBe('pm list packages -3')
  })

  test('includeSystem ⇒ pm list packages sin -3', async () => {
    const { t, cmds } = transportWith(/pm list packages$/, 'package:com.android.settings')
    const pkgs = await listPackages(t, 'SERIAL', { includeSystem: true })
    expect(pkgs).toEqual(['com.android.settings'])
    expect(cmds[0]).toBe('pm list packages')
  })

  test('transporte que falla ⇒ lista vacía (best-effort)', async () => {
    const t: AdbTransport = {
      isAvailable: async () => true,
      version: async () => '1.0.41',
      devices: async () => [],
      trackDevices: () => () => {},
      shell: async () => {
        throw new Error('device offline')
      },
    }
    expect(await listPackages(t, 'SERIAL', {})).toEqual([])
  })
})
