// Ticket 046 — desconexión y reconexión de iOS, a nivel server.
//
// El fake de pymobiledevice3 permite lo que contra un iPhone real cuesta un cable: matar el
// canal vital, dejarlo mudo, sacar el device del bus y volver a enchufarlo. Lo que se
// verifica es el CONTRATO que salió del grilling — que el dashboard nunca vea un dato viejo
// como vivo, que un microcorte no cueste un teardown, y que la desconexión no se reporte
// como muerte de la app.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AdbDevice, AdbTransport, ShellResult } from '../core/adb/AdbTransport'
import type { IosProcess } from '../core/ios/deviceInfo'
import { LiveServer } from './liveServer'

const UI_ROOT = join(import.meta.dir, '../ui')
const PKG = 'com.sample.arcade'
// A propósito NO tiene forma de UDID real (8hex-16hex): el scrubber de fixtures lo
// tomaría por PII y bloquearía el commit, y acá el valor sólo tiene que ser una clave.
const UDID = 'UDID-DE-PRUEBA'
const GRAPHICS_LINE =
  '{"Device Utilization %": 46, "CoreAnimationFramesPerSecond": 59, "Renderer Utilization %": 45}'

const IOS_DEVICE: AdbDevice = {
  serial: UDID,
  state: 'device',
  description: 'iPhone15,3',
  platform: 'ios',
}

/** adb fake que no conoce ningún device: acá el camino es 100 % iOS. */
const noAndroid: AdbTransport = {
  isAvailable: async () => true,
  version: async () => '1.0.41',
  devices: async () => [],
  trackDevices: () => () => {},
  streamShell: () => () => {},
  shell: async (): Promise<ShellResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
}

interface FakeIosStream {
  args: string[]
  onLine: (line: string) => void
  onExit?: ((err: Error | null) => void) | undefined
  stopped: boolean
}

/**
 * pymobiledevice3 fake. `present` simula el cable: con false, `devices()` no lista nada y
 * `processes()` devuelve null (= "no pude preguntar", que es lo que hace el real cuando el
 * device no está).
 */
function fakeIos() {
  const state = { present: true, processes: [{ pid: 500, name: 'SampleApp' }] as IosProcess[] }
  const streams: FakeIosStream[] = []
  return {
    state,
    streams,
    graphics: () => streams.find((s) => s.args.includes('graphics') && !s.stopped),
    transport: {
      isAvailable: async () => true,
      devices: async () => (state.present ? [IOS_DEVICE] : []),
      processes: async () => (state.present ? state.processes : null),
      appExecutable: async () => 'SampleApp',
      apps: async () => [],
      systemInfo: async () => ({ ramTotalMb: 6144, cores: 6 }),
      stream: (
        _serial: string,
        args: string[],
        onLine: (l: string) => void,
        onExit?: (err: Error | null) => void,
      ): (() => void) => {
        const s: FakeIosStream = { args, onLine, onExit, stopped: false }
        streams.push(s)
        return () => {
          s.stopped = true
        }
      },
    },
  }
}

async function startIosServer(
  ios: ReturnType<typeof fakeIos>,
  opts: { graceMs?: number; processPollMs?: number } = {},
) {
  const server = new LiveServer({
    transport: noAndroid,
    iosTransport: ios.transport,
    packageName: PKG,
    uiRoot: UI_ROOT,
    port: 0,
    intervalMs: 3_600_000, // sin ticks de Android durante el test
    devicePollMs: 20,
    iosDevicePollMs: 20,
    logFlushMs: 20,
    iosGraceMs: opts.graceMs ?? 150,
    iosStaleMs: 3000,
    iosProcessPollMs: opts.processPollMs ?? 5000,
  })
  const { url } = await server.start()
  return { server, url }
}

/** Cliente WS que acumula los estados de conexión anunciados por el server. */
async function listen(url: string) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
  const states: string[] = []
  const apps: Array<{ pid: number | null }> = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      type: string
      state?: string
      app?: { pid: number | null }
    }
    if (msg.type === 'connection' && msg.state) states.push(msg.state)
    if (msg.type === 'app' && msg.app) apps.push(msg.app)
  }
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve()
  })
  return { ws, states, apps }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Espera activa a que se cumpla una condición (o falla por timeout del test). */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await wait(10)
}

describe('LiveServer — desconexión iOS (046)', () => {
  test('al abrir el dashboard se anuncia el estado del cable, no sólo la ficha del device', async () => {
    const ios = fakeIos()
    const { server, url } = await startIosServer(ios)
    try {
      await until(() => server !== null && ios.streams.length > 0)
      const { ws, states } = await listen(url)
      await until(() => states.length > 0)
      expect(states[0]).toBe('connected')
      ws.close()
    } finally {
      await server.stop()
    }
  })

  test('muerto el canal vital y con el device fuera del bus: reconnecting → lost', async () => {
    const ios = fakeIos()
    const { server, url } = await startIosServer(ios)
    try {
      await until(() => ios.graphics() !== undefined)
      const { ws, states } = await listen(url)
      await until(() => states.length > 0)

      ios.state.present = false // se fue el cable
      ios.graphics()?.onExit?.(null) // y con él, el hijo de graphics
      await until(() => states.includes('lost'))

      expect(states).toEqual(['connected', 'reconnecting', 'lost'])
      // teardown real: ningún proceso pmd3 sobreviviente
      expect(ios.streams.every((s) => s.stopped)).toBe(true)
      ws.close()
    } finally {
      await server.stop()
    }
  })

  test('un microcorte que se recupera dentro de la ventana no suelta el device', async () => {
    const ios = fakeIos()
    const { server, url } = await startIosServer(ios, { graceMs: 400 })
    try {
      await until(() => ios.graphics() !== undefined)
      const { ws, states } = await listen(url)
      await until(() => states.length > 0)
      const vital = ios.graphics()!

      vital.onExit?.(null)
      await until(() => states.includes('reconnecting'))
      vital.onLine(GRAPHICS_LINE) // el canal vuelve antes de que expire la gracia
      await wait(600) // más que la ventana: si fuera a soltar, ya habría soltado

      expect(states).toEqual(['connected', 'reconnecting', 'connected'])
      expect(states).not.toContain('lost')
      expect(vital.stopped).toBe(false)
      ws.close()
    } finally {
      await server.stop()
    }
  })

  test('perdido el device, el watcher lo re-engancha solo cuando vuelve', async () => {
    const ios = fakeIos()
    const { server, url } = await startIosServer(ios)
    try {
      await until(() => ios.graphics() !== undefined)
      const { ws, states } = await listen(url)
      await until(() => states.length > 0)

      ios.state.present = false
      ios.graphics()?.onExit?.(null)
      await until(() => states.includes('lost'))

      ios.state.present = true // lo vuelven a enchufar
      await until(() => states.lastIndexOf('connected') > states.indexOf('lost'))

      expect(states.at(-1)).toBe('connected')
      // canales nuevos vivos: el re-enganche pasó por el mismo camino del arranque
      expect(ios.graphics()).toBeDefined()
      ws.close()
    } finally {
      await server.stop()
    }
  })

  test('perder el device mientras el watch espera a processes() no tumba el server', async () => {
    // Regresión del crash encontrado contra el iPhone real: el watch chequeaba iosSource
    // ANTES del await de `processes ps` (hasta 30 s), y el teardown lo dejaba en null en el
    // medio → "null is not an object" → unhandledRejection → el CLI bajaba el server, así
    // que la reconexión nunca podía ocurrir.
    const ios = fakeIos()
    let releaseProcesses: () => void = () => {}
    let pollColgado = false
    const lento = {
      ...ios.transport,
      // processes() que no responde hasta que el test lo suelte: así el teardown cae justo
      // en el medio del await, que es la ventana donde estaba el bug.
      processes: async () => {
        pollColgado = true
        await new Promise<void>((r) => {
          releaseProcesses = r
        })
        return ios.state.present ? ios.state.processes : null
      },
    }
    const server = new LiveServer({
      transport: noAndroid,
      iosTransport: lento,
      packageName: PKG,
      uiRoot: UI_ROOT,
      port: 0,
      intervalMs: 3_600_000,
      devicePollMs: 20,
      iosDevicePollMs: 20,
      logFlushMs: 20,
      iosGraceMs: 50,
      iosProcessPollMs: 20,
    })
    const errores: unknown[] = []
    const onRejection = (e: unknown): void => {
      errores.push(e)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const { url } = await server.start()
      await until(() => ios.graphics() !== undefined && pollColgado)
      const { ws, states } = await listen(url)
      await until(() => states.length > 0)

      ios.state.present = false
      ios.graphics()?.onExit?.(null)
      await until(() => states.includes('lost')) // teardown con el poll colgado del await
      releaseProcesses() // recién ahora contesta: la fuente ya no existe
      await wait(100)

      expect(errores).toEqual([])
      expect(states).toContain('lost')
      ws.close()
    } finally {
      process.off('unhandledRejection', onRejection)
      await server.stop()
    }
  })

  test('una desconexión NO se reporta como muerte de la app', async () => {
    // El bug: processes() devolvía [] cuando no se podía preguntar, y a los 3 polls el
    // server declaraba muerta una app que seguía perfectamente viva del otro lado del cable.
    // Acá el watch poléa cada 20 ms con el device ausente: con el bug, la muerte se
    // anunciaría al dashboard como {type:'app', pid:null}.
    const ios = fakeIos()
    const { server, url } = await startIosServer(ios, { processPollMs: 20 })
    try {
      await until(() => ios.graphics() !== undefined)
      const { ws, apps } = await listen(url)
      expect(await ios.transport.processes()).not.toBeNull()

      ios.state.present = false // se cae el cable; el canal vital NO muere
      expect(await ios.transport.processes()).toBeNull() // "no pude preguntar"
      await wait(200) // ~10 polls: de sobra para los 3 del debounce

      expect(apps.filter((a) => a.pid === null)).toHaveLength(0)
      ws.close()
    } finally {
      await server.stop()
    }
  })
})
