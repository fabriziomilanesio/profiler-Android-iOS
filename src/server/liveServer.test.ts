// Tests del selector de apps del LiveServer: GET /api/packages (ranking + filtro),
// POST /api/app (validación de input hostil, switch en caliente, launch vía monkey).
// Transport fake en memoria; el server levanta en un puerto libre (port: 0).
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AdbDevice, AdbTransport, ShellResult } from '../core/adb/AdbTransport'
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

/** Stream long-running fake (logcat): el test le inyecta líneas a mano. */
interface FakeStream {
  command: string
  onLine: (line: string) => void
  stopped: boolean
}

/** Transport fake: apps "corriendo" por package, lista instalada, devices y log de comandos. */
function fakeTransport(
  running: Map<string, number>,
  installed: string[],
  deviceList: AdbDevice[] = [],
): {
  t: AdbTransport
  cmds: string[]
  streams: FakeStream[]
} {
  const cmds: string[] = []
  const streams: FakeStream[] = []
  const t: AdbTransport = {
    isAvailable: async () => true,
    version: async () => '1.0.41',
    devices: async () => deviceList,
    trackDevices: () => () => {},
    streamShell: (_serial, command, onLine) => {
      const s: FakeStream = { command, onLine, stopped: false }
      streams.push(s)
      return () => {
        s.stopped = true
      }
    },
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
  return { t, cmds, streams }
}

function memoryStore(): {
  data: AppStoreData
  select(pkg: string): void
  set(patch: Partial<AppStoreData>): void
  selected: string[]
} {
  const selected: string[] = []
  const store = {
    data: { ...defaultAppStoreData(), usage: { 'com.evermore.arcade': 7 } },
    select(pkg: string) {
      selected.push(pkg)
    },
    set(patch: Partial<AppStoreData>) {
      Object.assign(store.data, patch)
    },
    selected,
  }
  return store
}

async function startServer(
  running: Map<string, number>,
  installed: string[],
  deviceList: AdbDevice[] = [],
  serial: string | null = 'FAKE-SERIAL',
  extra: { sessionsDir?: string; reportsDir?: string } = {},
) {
  const { t, cmds, streams } = fakeTransport(running, installed, deviceList)
  const store = memoryStore()
  if (extra.reportsDir) store.data.reportsDir = extra.reportsDir
  const server = new LiveServer({
    transport: t,
    serial: serial ?? undefined,
    packageName: PKG,
    uiRoot: UI_ROOT,
    port: 0, // puerto libre: los tests no chocan con un live real
    intervalMs: 3_600_000, // sin ticks periódicos durante el test (el primero corre igual)
    devicePollMs: 25, // watcher rápido para el test de modo espera
    logFlushMs: 20, // batches de logs rápidos para los tests
    appStore: store,
    sessionsDir: extra.sessionsDir,
  })
  const { url } = await server.start()
  return { server, url, cmds, streams, store }
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

const DEVICES: AdbDevice[] = [
  { serial: 'SERIAL-A', state: 'device', description: 'model:SM_A155M' },
  { serial: 'SERIAL-B', state: 'device', description: 'model:Pixel_7' },
  { serial: 'SERIAL-C', state: 'unauthorized', description: '' },
]

interface DevicesBody {
  devices: AdbDevice[]
  current: string
}
interface DeviceSwitchBody {
  ok: boolean
  device: { serial: string }
  app: { packageName: string; pid: number | null; launched: boolean }
}

describe('LiveServer /api/devices', () => {
  test('lista los devices de adb en el momento + el activo', async () => {
    const { server, url } = await startServer(new Map([[PKG, 111]]), [], DEVICES)
    try {
      const res = await fetch(`${url}/api/devices`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as DevicesBody
      expect(body.devices).toEqual(DEVICES)
      expect(body.current).toBe('FAKE-SERIAL')
    } finally {
      await server.stop()
    }
  })
})

describe('LiveServer /api/device', () => {
  test('serial no conectado ⇒ 404; unauthorized ⇒ 409', async () => {
    const { server, url } = await startServer(new Map([[PKG, 111]]), [], DEVICES)
    try {
      const missing = await fetch(`${url}/api/device`, {
        method: 'POST',
        body: JSON.stringify({ serial: 'NO-EXISTE' }),
      })
      expect(missing.status).toBe(404)
      const unauthorized = await fetch(`${url}/api/device`, {
        method: 'POST',
        body: JSON.stringify({ serial: 'SERIAL-C' }),
      })
      expect(unauthorized.status).toBe(409)
    } finally {
      await server.stop()
    }
  })

  test('modo espera: arranca sin device, el watcher se engancha al primero que aparece', async () => {
    const devices: AdbDevice[] = [] // arranca vacío: el watcher polea esta misma lista
    const { server, url } = await startServer(new Map([[PKG, 111]]), [], devices, null)
    try {
      // sin device: /api/devices vacío y /api/app rechaza
      const before = (await (await fetch(`${url}/api/devices`)).json()) as DevicesBody
      expect(before.devices).toEqual([])
      expect(before.current).toBeNull()
      const rejected = await fetch(`${url}/api/app`, {
        method: 'POST',
        body: JSON.stringify({ package: PKG }),
      })
      expect(rejected.status).toBe(409)

      // "enchufar" el device: el watcher (25 ms) debe engancharse solo
      devices.push({ serial: 'SERIAL-A', state: 'device', description: 'model:SM_A155M' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const after = (await (await fetch(`${url}/api/devices`)).json()) as DevicesBody
      expect(after.current).toBe('SERIAL-A')
    } finally {
      await server.stop()
    }
  })

  test('switch de device: nueva ficha, re-engancha la app actual SIN contar uso', async () => {
    const running = new Map([
      [PKG, 111], // corriendo en ambos devices (el fake no distingue serial)
    ])
    const { server, url, store } = await startServer(running, [], DEVICES)
    try {
      const res = await fetch(`${url}/api/device`, {
        method: 'POST',
        body: JSON.stringify({ serial: 'SERIAL-B' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as DeviceSwitchBody
      expect(body.device.serial).toBe('SERIAL-B')
      expect(body.app.packageName).toBe(PKG)
      // cambiar de device no es elegir una app: el ranking de uso no se toca
      expect(store.selected).toEqual([])

      const after = (await (await fetch(`${url}/api/devices`)).json()) as DevicesBody
      expect(after.current).toBe('SERIAL-B')
    } finally {
      await server.stop()
    }
  })
})

describe('LiveServer export/config/sesiones', () => {
  test('GET /api/report?window=full descarga HTML con datos y guarda copia', async () => {
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const reportsDir = mkdtempSync(join(tmpdir(), 'reports-'))
    const { server, url } = await startServer(new Map([[PKG, 111]]), [], [], 'FAKE-SERIAL', {
      reportsDir,
    })
    try {
      await new Promise((r) => setTimeout(r, 150)) // el primer tick llena el buffer
      const res = await fetch(`${url}/api/report?window=full`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toContain('evermore-report-')
      const html = await res.text()
      expect(html).toContain('window.ReportData')
      expect(html).toContain(PKG)
      expect(readdirSync(reportsDir).some((f) => f.endsWith('.html'))).toBe(true)
    } finally {
      await server.stop()
      rmSync(reportsDir, { recursive: true, force: true })
    }
  })

  test('window inválida ⇒ 400; sin muestras (ventana diminuta tras switch) no explota', async () => {
    const { server, url } = await startServer(new Map([[PKG, 111]]), [])
    try {
      expect((await fetch(`${url}/api/report?window=abc`)).status).toBe(400)
      expect((await fetch(`${url}/api/report?window=99999`)).status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  test('historial: la corrida crea una sesión listable y exportable', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const sessionsDir = mkdtempSync(join(tmpdir(), 'sessions-'))
    const { server, url } = await startServer(new Map([[PKG, 111]]), [], [], 'FAKE-SERIAL', {
      sessionsDir,
    })
    try {
      await new Promise((r) => setTimeout(r, 150)) // primer tick → primer sample al JSONL
      const list = (await (await fetch(`${url}/api/sessions`)).json()) as {
        sessions: Array<{ id: string; packages: string[] }>
        current: string | null
      }
      expect(list.sessions).toHaveLength(1)
      expect(list.current).toBe(list.sessions[0]!.id)
      expect(list.sessions[0]!.packages).toContain(PKG)

      const rep = await fetch(`${url}/api/report?session=${list.sessions[0]!.id}`)
      expect(rep.status).toBe(200)
      expect(await rep.text()).toContain(PKG)

      expect((await fetch(`${url}/api/report?session=..%2Fevil`)).status).toBe(404)
    } finally {
      await server.stop()
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  test('config: GET devuelve defaults y PUT aplica filterTerm/theme en caliente', async () => {
    const { server, url, store } = await startServer(new Map([[PKG, 111]]), [])
    try {
      const before = (await (await fetch(`${url}/api/config`)).json()) as {
        config: { filterTerm: string; theme: string }
      }
      expect(before.config.filterTerm).toBe('evermore')

      const put = await fetch(`${url}/api/config`, {
        method: 'PUT',
        body: JSON.stringify({ filterTerm: 'oda', theme: 'dark' }),
      })
      expect(put.status).toBe(200)
      expect(store.data.filterTerm).toBe('oda')
      expect(store.data.theme).toBe('dark')

      // el selector de apps refleja el término nuevo al toque
      const pkgs = (await (await fetch(`${url}/api/packages`)).json()) as { filterTerm: string }
      expect(pkgs.filterTerm).toBe('oda')
    } finally {
      await server.stop()
    }
  })

  test('target de FPS (ticket 025): GET arranca en 30 y PUT lo aplica en caliente', async () => {
    const { server, url, store } = await startServer(new Map([[PKG, 111]]), [])
    try {
      const before = (await (await fetch(`${url}/api/config`)).json()) as {
        config: { fpsTarget: number }
      }
      expect(before.config.fpsTarget).toBe(30) // default del grilling (gama baja)

      const put = await fetch(`${url}/api/config`, {
        method: 'PUT',
        body: JSON.stringify({ fpsTarget: 60 }),
      })
      expect(put.status).toBe(200)
      const body = (await put.json()) as { config: { fpsTarget: number } }
      expect(body.config.fpsTarget).toBe(60) // el cliente re-pinta con esta respuesta
      expect(store.data.fpsTarget).toBe(60) // y quedó en el store (persistiría a disco)
    } finally {
      await server.stop()
    }
  })

  test('intervalo auto (ticket 023): device gama baja resuelve 2 s; manual lo pisa; auto lo restaura', async () => {
    const { t } = fakeTransport(new Map([[PKG, 111]]), [])
    // el device fake es gama baja: captureDeviceInfo lee este /proc/meminfo (3.6 GB)
    const orig = t.shell
    t.shell = async (serial, command) => {
      if (command === 'cat /proc/meminfo') return ok('MemTotal:  3754184 kB\n')
      return orig(serial, command)
    }
    const server = new LiveServer({
      transport: t,
      serial: 'FAKE-SERIAL',
      packageName: PKG,
      uiRoot: UI_ROOT,
      port: 0,
      // sin intervalMs explícito: se resuelve por config/device (el loop real corre
      // a 2 s durante el test — inofensivo contra el fake)
      appStore: memoryStore(),
    })
    const { url } = await server.start()
    try {
      type Cfg = { effectiveIntervalMs: number }
      const auto = (await (await fetch(`${url}/api/config`)).json()) as Cfg
      expect(auto.effectiveIntervalMs).toBe(2000) // < 4 GB ⇒ 2 s

      // manual (el memoryStore asigna el patch tal cual; el flip real vive en AppStore.set)
      const manual = (await (
        await fetch(`${url}/api/config`, {
          method: 'PUT',
          body: JSON.stringify({ intervalMs: 500, intervalAuto: false }),
        })
      ).json()) as Cfg
      expect(manual.effectiveIntervalMs).toBe(500)

      const back = (await (
        await fetch(`${url}/api/config`, {
          method: 'PUT',
          body: JSON.stringify({ intervalAuto: true }),
        })
      ).json()) as Cfg
      expect(back.effectiveIntervalMs).toBe(2000)
    } finally {
      await server.stop()
    }
  })
})

describe('LiveServer /api/inspector (toggle en caliente)', () => {
  test('ON setea el proxy del device; OFF restaura con ":0" + limpia host/port (API 36)', async () => {
    const running = new Map([[PKG, 4242]])
    const { t, cmds } = fakeTransport(running, [PKG])
    const server = new LiveServer({
      transport: t,
      serial: 'FAKE-SERIAL',
      packageName: PKG,
      uiRoot: UI_ROOT,
      port: 0,
      intervalMs: 3_600_000,
      appStore: memoryStore(),
      adbPath: 'true', // `true` acepta cualquier arg y sale 0: stub del adb reverse
      proxyPort: 0, // puerto libre para el proxy real del test
    })
    const { url } = await server.start()
    try {
      const before = (await (await fetch(`${url}/api/config`)).json()) as {
        inspector: { enabled: boolean; running: boolean }
      }
      expect(before.inspector.enabled).toBe(false)
      expect(before.inspector.running).toBe(false)

      const on = await fetch(`${url}/api/inspector`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      })
      expect(on.status).toBe(200)
      const onBody = (await on.json()) as { inspector: { enabled: boolean; running: boolean } }
      expect(onBody.inspector.enabled).toBe(true)
      expect(onBody.inspector.running).toBe(true)
      expect(cmds.some((c) => c.startsWith('settings put global http_proxy 127.0.0.1:'))).toBe(true)

      const off = await fetch(`${url}/api/inspector`, {
        method: 'POST',
        body: JSON.stringify({ enabled: false }),
      })
      expect(off.status).toBe(200)
      const offBody = (await off.json()) as { inspector: { enabled: boolean; running: boolean } }
      expect(offBody.inspector.enabled).toBe(false)
      expect(offBody.inspector.running).toBe(false)
      // restauración a prueba de API 36: ":0" explícito + borrar las claves hermanas
      // (un `delete global http_proxy` solo deja el device sin internet — visto en el A15)
      expect(cmds).toContain('settings put global http_proxy :0')
      expect(cmds).toContain('settings delete global global_http_proxy_host')
      expect(cmds).toContain('settings delete global global_http_proxy_port')
    } finally {
      await server.stop()
    }
  })

  test('enabled no-boolean ⇒ 400; sin device conectado ⇒ 409', async () => {
    const { server, url } = await startServer(new Map(), [], [], null)
    try {
      const bad = await fetch(`${url}/api/inspector`, {
        method: 'POST',
        body: JSON.stringify({ enabled: 'yes' }),
      })
      expect(bad.status).toBe(400)

      const noDevice = await fetch(`${url}/api/inspector`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      })
      expect(noDevice.status).toBe(409)
    } finally {
      await server.stop()
    }
  })
})

describe('LiveServer logs (ticket 027)', () => {
  const UNITY_LINE = (msg: string, pid = 111, tid = 190) =>
    `2026-07-31 10:15:02.087 ${pid} ${tid} I Unity   : ${msg}`

  test('con app corriendo arma logcat --pid + crash stream vía AdbTransport', async () => {
    const { server, streams } = await startServer(new Map([[PKG, 111]]), [])
    try {
      const cmds = streams.map((s) => s.command)
      expect(cmds).toContain('logcat -b main,system --pid=111 -v threadtime -v year -T 1')
      expect(cmds).toContain('logcat -b crash,events -v threadtime -v year -T 1')
    } finally {
      await server.stop()
    }
  })

  test('GET /api/logs devuelve las últimas N del ring; n inválido ⇒ 400', async () => {
    const { server, url, streams } = await startServer(new Map([[PKG, 111]]), [])
    try {
      const app = streams.find((s) => s.command.includes('--pid=111'))!
      for (let i = 1; i <= 5; i++) app.onLine(UNITY_LINE(`msg ${i}`))
      const body = (await (await fetch(`${url}/api/logs`)).json()) as {
        entries: Array<{ message: string; tag: string; source: string }>
      }
      expect(body.entries).toHaveLength(5)
      expect(body.entries[0]!).toMatchObject({ tag: 'Unity', message: 'msg 1', source: 'logcat' })
      const last2 = (await (await fetch(`${url}/api/logs?n=2`)).json()) as {
        entries: Array<{ message: string }>
      }
      expect(last2.entries.map((e) => e.message)).toEqual(['msg 4', 'msg 5'])
      expect((await fetch(`${url}/api/logs?n=0`)).status).toBe(400)
      expect((await fetch(`${url}/api/logs?n=abc`)).status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  test('WS: las líneas viajan en UN batch {type:"logs"} por flush, no una por una', async () => {
    const { server, url, streams } = await startServer(new Map([[PKG, 111]]), [])
    try {
      const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
      const batches: Array<{ entries: Array<{ message: string }> }> = []
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as { type: string; entries?: [] }
        if (msg.type === 'logs') batches.push(msg as never)
      }
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })
      const app = streams.find((s) => s.command.includes('--pid=111'))!
      for (let i = 1; i <= 3; i++) app.onLine(UNITY_LINE(`burst ${i}`))
      await new Promise((r) => setTimeout(r, 100)) // logFlushMs=20: sobra un flush
      expect(batches).toHaveLength(1)
      expect(batches[0]!.entries.map((e) => e.message)).toEqual(['burst 1', 'burst 2', 'burst 3'])
      ws.close()
    } finally {
      await server.stop()
    }
  })

  test('persistencia NDJSON: <id>.logs.jsonl hermano de la sesión en sessionsDir', async () => {
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const sessionsDir = mkdtempSync(join(tmpdir(), 'sessions-'))
    const { server, url, streams } = await startServer(
      new Map([[PKG, 111]]),
      [],
      [],
      'FAKE-SERIAL',
      {
        sessionsDir,
      },
    )
    try {
      const app = streams.find((s) => s.command.includes('--pid=111'))!
      app.onLine(UNITY_LINE('persistime'))
      await new Promise((r) => setTimeout(r, 60)) // flush del sink
      const list = (await (await fetch(`${url}/api/sessions`)).json()) as {
        current: string
      }
      const logsPath = join(sessionsDir, `${list.current}.logs.jsonl`)
      expect(existsSync(logsPath)).toBe(true)
      const { LogSink } = await import('../core/logs/logSink')
      const back = LogSink.read(sessionsDir, list.current)!
      expect(back).toHaveLength(1)
      expect(back[0]!).toMatchObject({ tag: 'Unity', message: 'persistime', source: 'logcat' })
    } finally {
      await server.stop()
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  test('switch de app re-arma logcat contra el pid nuevo y corta los streams viejos', async () => {
    const { server, url, streams } = await startServer(
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
      const old = streams.find((s) => s.command.includes('--pid=111'))!
      expect(old.stopped).toBe(true)
      const nuevo = streams.find((s) => s.command.includes('--pid=222'))
      expect(nuevo).toBeDefined()
      expect(nuevo!.stopped).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test('modo espera (sin device): cero streams de logcat, sin errores ruidosos', async () => {
    const { server, streams } = await startServer(new Map(), [], [], null)
    try {
      expect(streams.filter((s) => s.command.startsWith('logcat'))).toHaveLength(0)
    } finally {
      await server.stop()
    }
  })
})

describe('LiveServer /api/logs/export (ticket 029)', () => {
  const UNITY_LINE = (msg: string, pid = 111, tid = 190) =>
    `2026-07-31 10:15:02.087 ${pid} ${tid} I Unity   : ${msg}`

  const FILTERED_ENTRIES = [
    {
      ts: 1786000000000,
      level: 'E',
      tag: 'Unity',
      message: 'NullReferenceException: señal 💥',
      pid: 111,
      tid: 190,
      source: 'logcat',
    },
    {
      ts: 1786000000100,
      level: 'E',
      tag: 'AndroidRuntime',
      message: 'FATAL EXCEPTION: main',
      pid: 111,
      source: 'logcat',
      isCrash: true,
    },
  ]

  const exportReq = (url: string, body: unknown) =>
    fetch(`${url}/api/logs/export`, { method: 'POST', body: JSON.stringify(body) })

  test('scope filtered + txt: attachment -filtered.txt, crashes marcados, copia en reportes', async () => {
    const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const reportsDir = mkdtempSync(join(tmpdir(), 'reports-'))
    const { server, url } = await startServer(new Map([[PKG, 111]]), [], [], 'FAKE-SERIAL', {
      reportsDir,
    })
    try {
      const res = await exportReq(url, {
        scope: 'filtered',
        format: 'txt',
        entries: FILTERED_ENTRIES,
      })
      expect(res.status).toBe(200)
      const dispo = res.headers.get('content-disposition') ?? ''
      expect(dispo).toContain('evermore-logs-')
      expect(dispo).toContain('-filtered.txt')
      const txt = await res.text()
      expect(txt).toContain('E/Unity(111): NullReferenceException: señal 💥')
      expect(txt).toContain('[CRASH] ')
      expect(txt).toContain('E/AndroidRuntime(111): FATAL EXCEPTION: main')
      // copia en la carpeta de reportes, con el mismo contenido
      const copy = readdirSync(reportsDir).find((f) => f.endsWith('-filtered.txt'))
      expect(copy).toBeDefined()
      expect(readFileSync(join(reportsDir, copy!), 'utf8')).toBe(txt)
    } finally {
      await server.stop()
      rmSync(reportsDir, { recursive: true, force: true })
    }
  })

  test('scope filtered + jsonl: cada línea parsea a la LogEntry mandada', async () => {
    const { server, url } = await startServer(new Map([[PKG, 111]]), [])
    try {
      const res = await exportReq(url, {
        scope: 'filtered',
        format: 'jsonl',
        entries: FILTERED_ENTRIES,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/x-ndjson')
      const lines = (await res.text()).split('\n').filter(Boolean)
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toMatchObject({ tag: 'Unity', level: 'E', tid: 190 })
      expect(JSON.parse(lines[1]!)).toMatchObject({ tag: 'AndroidRuntime', isCrash: true })
    } finally {
      await server.stop()
    }
  })

  test('scope session (en curso): exporta el NDJSON de la sesión con el id en el nombre', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const sessionsDir = mkdtempSync(join(tmpdir(), 'sessions-'))
    const { server, url, streams } = await startServer(
      new Map([[PKG, 111]]),
      [],
      [],
      'FAKE-SERIAL',
      { sessionsDir },
    )
    try {
      const app = streams.find((s) => s.command.includes('--pid=111'))!
      app.onLine(UNITY_LINE('exportame'))
      await new Promise((r) => setTimeout(r, 60)) // flush del sink (logFlushMs=20)
      const list = (await (await fetch(`${url}/api/sessions`)).json()) as { current: string }
      const res = await exportReq(url, { scope: 'session', format: 'txt' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toContain(`evermore-logs-${list.current}.txt`)
      expect(await res.text()).toContain('I/Unity(111): exportame')
    } finally {
      await server.stop()
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  test('sesión pasada: exporta su .logs.jsonl vía LogSink; sin archivo ⇒ 404 claro', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const sessionsDir = mkdtempSync(join(tmpdir(), 'sessions-'))
    // sesión "vieja" pre-existente con logs
    const { LogSink } = await import('../core/logs/logSink')
    const oldId = '2026-07-30T09-00-00'
    new LogSink(sessionsDir, oldId).append([
      {
        ts: 1786000000000,
        level: 'W',
        tag: 'Unity',
        message: 'atlas no precargado',
        pid: 99,
        source: 'logcat',
      },
    ])
    const { server, url } = await startServer(new Map([[PKG, 111]]), [], [], 'FAKE-SERIAL', {
      sessionsDir,
    })
    try {
      const res = await exportReq(url, { scope: 'session', format: 'jsonl', sessionId: oldId })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toContain(`evermore-logs-${oldId}.jsonl`)
      expect(await res.text()).toContain('atlas no precargado')

      // sesión sin logs (sin <id>.logs.jsonl): 404 con mensaje, no error
      const missing = await exportReq(url, {
        scope: 'session',
        format: 'txt',
        sessionId: '2026-07-29T08-00-00',
      })
      expect(missing.status).toBe(404)
      expect(((await missing.json()) as { error: string }).error).toContain('no tiene logs')

      // path traversal en sessionId: LogSink valida el id ⇒ 404
      expect(
        (await exportReq(url, { scope: 'session', format: 'txt', sessionId: '../evil' })).status,
      ).toBe(404)
    } finally {
      await server.stop()
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  test('validación: format/scope/entries inválidos ⇒ 400; filtered vacío ⇒ 409', async () => {
    const { server, url } = await startServer(new Map([[PKG, 111]]), [])
    try {
      expect((await exportReq(url, { scope: 'filtered', format: 'pdf' })).status).toBe(400)
      expect((await exportReq(url, { scope: 'todo', format: 'txt' })).status).toBe(400)
      expect(
        (await exportReq(url, { scope: 'filtered', format: 'txt', entries: 'nope' })).status,
      ).toBe(400)
      expect(
        (
          await exportReq(url, {
            scope: 'filtered',
            format: 'txt',
            entries: [{ ts: 'x', level: 'I' }],
          })
        ).status,
      ).toBe(400)
      expect((await exportReq(url, { scope: 'filtered', format: 'txt', entries: [] })).status).toBe(
        409,
      )
    } finally {
      await server.stop()
    }
  })

  test('/api/sessions reporta hasLogs por sesión (habilita los botones del menú)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const sessionsDir = mkdtempSync(join(tmpdir(), 'sessions-'))
    const { server, url, streams } = await startServer(
      new Map([[PKG, 111]]),
      [],
      [],
      'FAKE-SERIAL',
      { sessionsDir },
    )
    try {
      await new Promise((r) => setTimeout(r, 150)) // primer tick crea la sesión
      const before = (await (await fetch(`${url}/api/sessions`)).json()) as {
        sessions: Array<{ hasLogs: boolean }>
      }
      expect(before.sessions[0]!.hasLogs).toBe(false) // sin logs todavía

      const app = streams.find((s) => s.command.includes('--pid=111'))!
      app.onLine(UNITY_LINE('ahora sí'))
      await new Promise((r) => setTimeout(r, 60))
      const after = (await (await fetch(`${url}/api/sessions`)).json()) as {
        sessions: Array<{ hasLogs: boolean }>
      }
      expect(after.sessions[0]!.hasLogs).toBe(true)
    } finally {
      await server.stop()
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })
})
