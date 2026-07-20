// Tests del selector de apps del LiveServer: GET /api/packages (ranking + filtro),
// POST /api/app (validación de input hostil, switch en caliente, launch vía monkey).
// Transport fake en memoria; el server levanta en un puerto libre (port: 0).
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AdbTransport, ShellResult } from '../core/adb/AdbTransport'
import { defaultAppStoreData, type AppStoreData } from '../core/appStore'
import { LiveServer } from './liveServer'

const UI_ROOT = join(import.meta.dir, '../ui')
const PKG = 'com.evermore.oda.qa'

const ok = (stdout: string): ShellResult => ({ stdout, stderr: '', exitCode: 0 })

interface PackagesBody {
  packages: string[]
  filterTerm: string
  current: string
}
interface SelectBody {
  app: { packageName: string; pid: number | null; launched: boolean }
}

/** Transport fake: apps "corriendo" por package, lista instalada, y log de comandos. */
function fakeTransport(
  running: Map<string, number>,
  installed: string[],
): {
  t: AdbTransport
  cmds: string[]
} {
  const cmds: string[] = []
  const t: AdbTransport = {
    isAvailable: async () => true,
    version: async () => '1.0.41',
    devices: async () => [],
    trackDevices: () => () => {},
    shell: async (_serial, command): Promise<ShellResult> => {
      cmds.push(command)
      if (command.startsWith('pidof ')) {
        const pkg = command.slice('pidof '.length).trim()
        const pid = running.get(pkg)
        return pid ? ok(String(pid)) : { stdout: '', stderr: '', exitCode: 1 }
      }
      if (command.startsWith('pm list packages')) {
        return ok(installed.map((p) => `package:${p}`).join('\n'))
      }
      if (command.startsWith('monkey -p ')) {
        // lanzar la app: aparece su proceso
        const pkg = command.split(' ')[2]!
        running.set(pkg, 4242)
        return ok('Events injected: 1')
      }
      return ok('')
    },
  }
  return { t, cmds }
}

function memoryStore(): { data: AppStoreData; select(pkg: string): void; selected: string[] } {
  const selected: string[] = []
  const store = {
    data: { ...defaultAppStoreData(), usage: { 'com.evermore.arcade': 7 } },
    select(pkg: string) {
      selected.push(pkg)
    },
    selected,
  }
  return store
}

async function startServer(running: Map<string, number>, installed: string[]) {
  const { t, cmds } = fakeTransport(running, installed)
  const store = memoryStore()
  const server = new LiveServer({
    transport: t,
    serial: 'FAKE-SERIAL',
    packageName: PKG,
    uiRoot: UI_ROOT,
    port: 0, // puerto libre: los tests no chocan con un live real
    intervalMs: 3_600_000, // sin ticks durante el test
    appStore: store,
  })
  const { url } = await server.start()
  return { server, url, cmds, store }
}

describe('LiveServer /api/packages', () => {
  test('lista instaladas rankeadas por uso, con filterTerm y current', async () => {
    const { server, url } = await startServer(new Map([[PKG, 111]]), [
      'com.aaa.app',
      'com.evermore.arcade',
      'com.zzz.app',
    ])
    try {
      const res = await fetch(`${url}/api/packages`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as PackagesBody
      // com.evermore.arcade tiene usage 7 ⇒ primera; el resto alfabético
      expect(body.packages).toEqual(['com.evermore.arcade', 'com.aaa.app', 'com.zzz.app'])
      expect(body.filterTerm).toBe('evermore')
      expect(body.current).toBe(PKG)
    } finally {
      await server.stop()
    }
  })

  test('?system=1 usa pm list packages sin -3', async () => {
    const { server, url, cmds } = await startServer(new Map([[PKG, 111]]), ['com.android.settings'])
    try {
      await fetch(`${url}/api/packages?system=1`)
      expect(cmds).toContain('pm list packages')
    } finally {
      await server.stop()
    }
  })
})

describe('LiveServer /api/app', () => {
  test('package inválido (inyección) ⇒ 400 y nunca llega a adb shell', async () => {
    const { server, url, cmds } = await startServer(new Map([[PKG, 111]]), [])
    try {
      const evil = 'com.x;rm -rf /'
      const res = await fetch(`${url}/api/app`, {
        method: 'POST',
        body: JSON.stringify({ package: evil }),
      })
      expect(res.status).toBe(400)
      expect(cmds.some((c) => c.includes('rm -rf'))).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test('switch a una app corriendo: pid real, launched false, persiste selección', async () => {
    const { server, url, store } = await startServer(
      new Map([
        [PKG, 111],
        ['com.evermore.arcade', 222],
      ]),
      [],
    )
    try {
      const res = await fetch(`${url}/api/app`, {
        method: 'POST',
        body: JSON.stringify({ package: 'com.evermore.arcade' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as SelectBody
      expect(body.app).toEqual({ packageName: 'com.evermore.arcade', pid: 222, launched: false })
      expect(store.selected).toEqual(['com.evermore.arcade'])
    } finally {
      await server.stop()
    }
  })

  test('switch a una app cerrada: la lanza vía monkey y espera el pid', async () => {
    const { server, url, cmds } = await startServer(new Map([[PKG, 111]]), [])
    try {
      const res = await fetch(`${url}/api/app`, {
        method: 'POST',
        body: JSON.stringify({ package: 'com.evermore.arcade' }),
      })
      const body = (await res.json()) as SelectBody
      expect(cmds).toContain('monkey -p com.evermore.arcade 1')
      expect(body.app).toEqual({ packageName: 'com.evermore.arcade', pid: 4242, launched: true })
    } finally {
      await server.stop()
    }
  })
})
