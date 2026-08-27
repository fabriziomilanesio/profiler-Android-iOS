// Harness del e2e (ticket 014, escenario de desconexión del 046).
//
// Levanta el LiveServer REAL con el dashboard REAL, contra un `pymobiledevice3` falso: el
// e2e no necesita un iPhone enchufado, y aun así ejercita el camino entero
// server → WebSocket → UI que los tests unitarios no tocan.
//
// Corre bajo Bun (el server usa `Bun.serve`); Playwright sólo maneja el browser y pega
// contra el puerto de control para simular el cable.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdbDevice, AdbTransport, ShellResult } from '../src/core/adb/AdbTransport'
import { LiveServer } from '../src/server/liveServer'

const PORT = Number(process.env['E2E_PORT'] ?? 8788)
const CONTROL_PORT = Number(process.env['E2E_CONTROL_PORT'] ?? 8789)
const UDID = 'UDID-E2E'
const PKG = 'com.sample.arcade'

const IOS_DEVICE: AdbDevice = {
  serial: UDID,
  state: 'device',
  description: 'model:iPhone15,3 ios:26.6 transport:USB',
  platform: 'ios',
}

const IOS_DEVICE_B: AdbDevice = {
  serial: 'UDID-E2E-B',
  state: 'device',
  description: 'model:iPhone16,2 ios:26.6 transport:USB',
  platform: 'ios',
}

/** adb que no ve nada: el escenario es 100 % iOS. */
const noAndroid: AdbTransport = {
  isAvailable: async () => true,
  version: async () => '1.0.41',
  devices: async () => [],
  trackDevices: () => () => {},
  streamShell: () => () => {},
  shell: async (): Promise<ShellResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
}

interface FakeStream {
  args: string[]
  onLine: (line: string) => void
  onExit?: ((err: Error | null) => void) | undefined
  stopped: boolean
}

const streams: FakeStream[] = []
/** el cable: con false, ni `devices()` ni `processes()` ven al iPhone. */
let plugged = true
/** empuja datos a los canales vivos para que el dashboard muestre valores reales. */
let feeder: ReturnType<typeof setInterval> | null = null

const live = (cmd: string): FakeStream[] =>
  streams.filter((s) => s.args.includes(cmd) && !s.stopped)

const iosTransport = {
  isAvailable: async () => true,
  devices: async () => (plugged ? [IOS_DEVICE, IOS_DEVICE_B] : []),
  processes: async () => (plugged ? [{ pid: 777, name: 'SampleApp' }] : null),
  appExecutable: async () => 'SampleApp',
  apps: async () => [{ id: PKG, label: 'Sample App', executable: 'SampleApp' }],
  systemInfo: async () => ({ ramTotalMb: 6144, cores: 6 }),
  stream: (
    _serial: string,
    args: string[],
    onLine: (l: string) => void,
    onExit?: (err: Error | null) => void,
  ): (() => void) => {
    const s: FakeStream = { args, onLine, onExit, stopped: false }
    streams.push(s)
    return () => {
      s.stopped = true
    }
  },
}

function startFeeder(): void {
  if (feeder !== null) return
  feeder = setInterval(() => {
    for (const s of live('graphics')) {
      s.onLine(
        '{"Device Utilization %": 42, "Renderer Utilization %": 40, ' +
          '"Tiler Utilization %": 38, "CoreAnimationFramesPerSecond": 58}',
      )
    }
    for (const s of live('battery')) {
      s.onLine(
        '{"InstantAmperage": -180, "Temperature": 3120, "IsCharging": false, ' +
          '"CurrentCapacity": 82}',
      )
    }
    for (const s of live('syslog')) {
      s.onLine('2026-08-27 12:00:00.000000 SampleApp{Unity}[777] <INFO>: dual log visible')
    }
  }, 500)
}

const server = new LiveServer({
  transport: noAndroid,
  iosTransport,
  packageName: PKG,
  uiRoot: join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui'),
  port: PORT,
  intervalMs: 1000,
  devicePollMs: 200,
  iosDevicePollMs: 200,
  iosGraceMs: 1500,
  iosProcessPollMs: 500,
})

await server.start()
startFeeder()

// Puerto de control: es lo que el spec usa para "desenchufar el cable" o matar un canal.
Bun.serve({
  port: CONTROL_PORT,
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/kill-vital') {
      // mata al hijo del canal vital como lo haría un túnel que se cae
      for (const s of live('graphics')) {
        s.stopped = true
        s.onExit?.(null)
      }
      return new Response('ok')
    }
    if (pathname === '/unplug') {
      plugged = false
      for (const s of live('graphics')) {
        s.stopped = true
        s.onExit?.(null)
      }
      return new Response('ok')
    }
    if (pathname === '/plug') {
      plugged = true
      return new Response('ok')
    }
    return new Response('not found', { status: 404 })
  },
})

console.log(`[e2e-harness] dashboard http://localhost:${PORT} · control :${CONTROL_PORT}`)
