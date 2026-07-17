import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdbDevice, AdbTransport, ShellResult } from '../adb/AdbTransport'
import { DeviceProxyController, type ProxyState } from './DeviceProxyController'

const SERIAL = 'R58M42XXXX'

const dirs: string[] = []
function freshBaseDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'evermore-proxy-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * FakeAdbTransport in-line (mismo patrón que el stub de preflight.test.ts):
 * registra cada `shell()` y responde según un mapa de comando→resultado, con
 * un default. `commands` guarda el orden exacto para aserciones.
 */
function fakeAdb(
  responder: (serial: string, command: string) => ShellResult,
): AdbTransport & { commands: Array<{ serial: string; command: string }> } {
  const commands: Array<{ serial: string; command: string }> = []
  return {
    commands,
    isAvailable: async () => true,
    version: async () => 'Android Debug Bridge version 1.0.41',
    devices: async (): Promise<AdbDevice[]> => [],
    shell: async (serial, command): Promise<ShellResult> => {
      commands.push({ serial, command })
      return responder(serial, command)
    },
    trackDevices: () => () => {},
  }
}

function ok(stdout: string): ShellResult {
  return { stdout, stderr: '', exitCode: 0 }
}

describe('DeviceProxyController.capturePrevious', () => {
  test('null → estado "none", persistido a proxy-restore.json', async () => {
    const baseDir = freshBaseDir()
    const adb = fakeAdb(() => ok('null\n'))
    const ctrl = new DeviceProxyController(adb, baseDir)

    const state = await ctrl.capturePrevious(SERIAL)

    expect(state).toEqual({ kind: 'none' } satisfies ProxyState)
    expect(adb.commands).toContainEqual({
      serial: SERIAL,
      command: 'settings get global http_proxy',
    })
    const restore = JSON.parse(readFileSync(join(baseDir, 'proxy-restore.json'), 'utf8'))
    expect(restore).toEqual({ serial: SERIAL, previous: { kind: 'none' } })
  })

  test(':0 (sin proxy explícito) → estado "none"', async () => {
    const adb = fakeAdb(() => ok(':0\n'))
    const state = await new DeviceProxyController(adb, freshBaseDir()).capturePrevious(SERIAL)
    expect(state).toEqual({ kind: 'none' })
  })

  test('un proxy real del usuario → estado "set" con host y port', async () => {
    const adb = fakeAdb(() => ok('10.0.0.5:8888\n'))
    const state = await new DeviceProxyController(adb, freshBaseDir()).capturePrevious(SERIAL)
    expect(state).toEqual({ kind: 'set', host: '10.0.0.5', port: 8888 })
  })
})

describe('DeviceProxyController.set', () => {
  test('emite settings put global http_proxy host:port', async () => {
    const adb = fakeAdb(() => ok(''))
    await new DeviceProxyController(adb, freshBaseDir()).set(SERIAL, '192.168.1.10', 8080)
    expect(adb.commands).toContainEqual({
      serial: SERIAL,
      command: 'settings put global http_proxy 192.168.1.10:8080',
    })
  })
})

describe('DeviceProxyController.restore', () => {
  test('previo "none" → settings delete + borra el restore file', async () => {
    const baseDir = freshBaseDir()
    const adb = fakeAdb(() => ok('null\n'))
    const ctrl = new DeviceProxyController(adb, baseDir)

    await ctrl.capturePrevious(SERIAL)
    await ctrl.set(SERIAL, '192.168.1.10', 8080)
    await ctrl.restore(SERIAL)

    expect(adb.commands.at(-1)).toEqual({
      serial: SERIAL,
      command: 'settings delete global http_proxy',
    })
    expect(existsSync(join(baseDir, 'proxy-restore.json'))).toBe(false)
  })

  test('previo era un proxy real → restaura EXACTAMENTE ese valor', async () => {
    const baseDir = freshBaseDir()
    const adb = fakeAdb(() => ok('10.0.0.5:8888\n'))
    const ctrl = new DeviceProxyController(adb, baseDir)

    await ctrl.capturePrevious(SERIAL)
    await ctrl.set(SERIAL, '192.168.1.10', 8080)
    await ctrl.restore(SERIAL)

    expect(adb.commands.at(-1)).toEqual({
      serial: SERIAL,
      command: 'settings put global http_proxy 10.0.0.5:8888',
    })
    expect(existsSync(join(baseDir, 'proxy-restore.json'))).toBe(false)
  })

  test('es idempotente: un segundo restore no re-emite ni rompe', async () => {
    const baseDir = freshBaseDir()
    const adb = fakeAdb(() => ok('null\n'))
    const ctrl = new DeviceProxyController(adb, baseDir)

    await ctrl.capturePrevious(SERIAL)
    await ctrl.restore(SERIAL)
    const countAfterFirst = adb.commands.length
    await ctrl.restore(SERIAL)
    expect(adb.commands.length).toBe(countAfterFirst)
  })

  test('restore sin capturePrevious previo no hace nada (no rompe)', async () => {
    const adb = fakeAdb(() => ok(''))
    await new DeviceProxyController(adb, freshBaseDir()).restore(SERIAL)
    expect(adb.commands.length).toBe(0)
  })
})

describe('DeviceProxyController.recoverOrphan', () => {
  test('un restore huérfano en disco (crash previo) se restaura y se limpia', async () => {
    const baseDir = freshBaseDir()
    // Simulamos una corrida anterior que crasheó: dejó el restore file y el
    // device quedó con NUESTRO proxy seteado.
    const first = fakeAdb(() => ok('10.0.0.5:8888\n'))
    const crashed = new DeviceProxyController(first, baseDir)
    await crashed.capturePrevious(SERIAL)
    await crashed.set(SERIAL, '192.168.1.10', 8080)
    // ...proceso muere sin restore. El restore file sigue en disco.
    expect(existsSync(join(baseDir, 'proxy-restore.json'))).toBe(true)

    // Nueva corrida de la tool: recupera el huérfano.
    const next = fakeAdb(() => ok(''))
    const ctrl = new DeviceProxyController(next, baseDir)
    const recovered = await ctrl.recoverOrphan()

    expect(recovered).toEqual({
      serial: SERIAL,
      previous: { kind: 'set', host: '10.0.0.5', port: 8888 },
    })
    expect(next.commands.at(-1)).toEqual({
      serial: SERIAL,
      command: 'settings put global http_proxy 10.0.0.5:8888',
    })
    expect(existsSync(join(baseDir, 'proxy-restore.json'))).toBe(false)
  })

  test('sin restore file → recoverOrphan devuelve null y no toca adb', async () => {
    const adb = fakeAdb(() => ok(''))
    const recovered = await new DeviceProxyController(adb, freshBaseDir()).recoverOrphan()
    expect(recovered).toBeNull()
    expect(adb.commands.length).toBe(0)
  })
})
