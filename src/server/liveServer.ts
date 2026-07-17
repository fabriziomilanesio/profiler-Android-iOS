// Live server (ticket 021): levanta HTTP+WS, sirve el dashboard desde uiRoot y
// streamea Samples en vivo. Corre el Sampler a 1 Hz y hace broadcast de cada Sample;
// al conectar un cliente le manda la ficha del device.
//
// Costuras respetadas: adb solo por AdbTransport (via Sampler); runtime solo por
// src/runtime/httpServer (Bun aislado). Opcionalmente appendea los Samples a un JSONL.
import { appendFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import type { AdbTransport } from '../core/adb/AdbTransport'
import type { DeviceInfo, Sample } from '../core/schema'
import { Sampler, resolvePid } from '../core/sampler/sampler'
import { parseDeviceInfo } from '../core/collectors/deviceInfo'
import { startHttpServer, type RunningHttpServer, type WsClient } from '../runtime/httpServer'
import { resolveStaticFile } from './staticFiles'
import { deviceMessage, sampleMessage, flowMessage } from './messages'
import { InspectorProxy } from './inspectorProxy'
import { run } from '../runtime/spawn'

export interface LiveServerOptions {
  transport: AdbTransport
  serial: string
  packageName: string
  uiRoot: string
  port?: number
  intervalMs?: number
  /** ruta de un JSONL donde appendear cada Sample (opcional). */
  jsonlPath?: string
  /** callback por cada Sample (para logs/smoke). */
  onSample?: (s: Sample) => void
  /** habilita el inspector HTTP (proxy pass-through + tabla de requests en vivo). */
  inspectHttp?: boolean
  /** puerto del proxy del inspector (default 8899). */
  proxyPort?: number
  /** ruta a adb (para `adb reverse`); si falta, se asume 'adb' en PATH. */
  adbPath?: string
}

/** Captura la ficha del device una vez (getprop + /proc/meminfo + SurfaceFlinger GLES). */
export async function captureDeviceInfo(
  transport: AdbTransport,
  serial: string,
): Promise<DeviceInfo> {
  const safe = async (cmd: string): Promise<string> => {
    try {
      return (await transport.shell(serial, cmd)).stdout
    } catch {
      return ''
    }
  }
  const [getprop, procMeminfo, sf] = await Promise.all([
    safe('getprop'),
    safe('cat /proc/meminfo'),
    // grep de la línea GLES: (aparece varias líneas abajo, no en el header)
    safe('dumpsys SurfaceFlinger | grep -m1 "GLES:"'),
  ])
  return parseDeviceInfo({ getprop, procMeminfo, surfaceflingerGles: sf, serial })
}

export class LiveServer {
  private server: RunningHttpServer | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private device: DeviceInfo | null = null
  private sampler: Sampler | null = null
  private inspector: InspectorProxy | null = null
  private proxyPrev: string | null = null
  private proxyApplied = false
  private ticking = false

  constructor(private readonly opts: LiveServerOptions) {}

  /** Arranca: captura device, levanta HTTP+WS, empieza el loop de sampling. */
  async start(): Promise<{ url: string; device: DeviceInfo }> {
    this.device = await captureDeviceInfo(this.opts.transport, this.opts.serial)

    const pid =
      (await resolvePid(this.opts.transport, this.opts.serial, this.opts.packageName)) ?? 0
    const sampler = new Sampler(this.opts.transport, this.opts.serial, this.opts.packageName, pid)
    this.sampler = sampler
    // habilitar timestats de SurfaceFlinger (FPS acumula desde acá)
    await sampler.init()

    const uiRoot = this.opts.uiRoot
    this.server = startHttpServer(this.opts.port ?? 4517, {
      fetch: (req) => {
        const url = new URL(req.url)
        const resolved = resolveStaticFile(uiRoot, url.pathname)
        if (!resolved) return new Response('Not found', { status: 404 })
        try {
          const body = readFileSync(resolved.path)
          return new Response(body, { headers: { 'content-type': resolved.contentType } })
        } catch {
          return new Response('Not found', { status: 404 })
        }
      },
      onOpen: (client: WsClient) => {
        // Al conectar: mandar la ficha del device.
        if (this.device) client.send(deviceMessage(this.device))
      },
    })

    // Inspector HTTP opcional: proxy pass-through + proxy del device por adb reverse.
    if (this.opts.inspectHttp) {
      await this.startInspector()
    }

    const interval = this.opts.intervalMs ?? 1000
    this.timer = setInterval(() => {
      void this.tick(sampler)
    }, interval)
    // primer sample enseguida (así el dashboard no arranca vacío)
    void this.tick(sampler)

    const url = `http://localhost:${this.server.port}`
    return { url, device: this.device }
  }

  /** Levanta el proxy pass-through, lo cablea al device (reverse + http_proxy) y streamea flows. */
  private async startInspector(): Promise<void> {
    const port = this.opts.proxyPort ?? 8899
    const adb = this.opts.adbPath ?? 'adb'
    const serial = this.opts.serial
    const inspector = new InspectorProxy(port, (flow) => this.server?.broadcast(flowMessage(flow)))
    await inspector.start()
    this.inspector = inspector
    // adb reverse: el device alcanza 127.0.0.1:<port> de esta máquina
    await run(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`])
    // guardar el proxy previo del device ANTES de tocar nada (restauración exacta en stop)
    try {
      const prev = (
        await this.opts.transport.shell(serial, 'settings get global http_proxy')
      ).stdout.trim()
      this.proxyPrev = prev && prev !== 'null' && prev !== ':0' ? prev : null
    } catch {
      this.proxyPrev = null
    }
    await this.opts.transport.shell(serial, `settings put global http_proxy 127.0.0.1:${port}`)
    this.proxyApplied = true
  }

  /** Restaura el proxy del device y baja el reverse + el proxy. Idempotente/best-effort. */
  private async stopInspector(): Promise<void> {
    const port = this.opts.proxyPort ?? 8899
    const adb = this.opts.adbPath ?? 'adb'
    const serial = this.opts.serial
    try {
      // Solo restaurar si llegamos a pisar el proxy: si start() falló antes del
      // `settings put`, borrar acá destruiría un proxy pre-existente del usuario.
      if (this.proxyApplied) {
        if (this.proxyPrev) {
          await this.opts.transport.shell(
            serial,
            `settings put global http_proxy ${this.proxyPrev}`,
          )
        } else {
          await this.opts.transport.shell(serial, 'settings delete global http_proxy')
        }
        this.proxyApplied = false
      }
      await run(adb, ['-s', serial, 'reverse', '--remove', `tcp:${port}`])
    } catch {
      /* best-effort */
    }
    this.inspector?.stop()
    this.inspector = null
  }

  private async tick(sampler: Sampler): Promise<void> {
    // Sin este guard, un device lento (shells adb con timeout de varios segundos)
    // encola ticks concurrentes que pisan prevCpu/prevNet → deltas corruptos.
    if (this.ticking) return
    this.ticking = true
    try {
      // por si la app se reinició (nuevo pid); best-effort, barato cada tick.
      await sampler.refreshPid()
      const sample = await sampler.sampleOnce()
      const msg = sampleMessage(sample)
      this.server?.broadcast(msg)
      if (this.opts.jsonlPath) {
        try {
          appendFileSync(this.opts.jsonlPath, JSON.stringify(sample) + '\n')
        } catch {
          /* no romper el loop por un fallo de escritura */
        }
      }
      this.opts.onSample?.(sample)
    } catch {
      /* un tick que explota no debe matar el loop */
    } finally {
      this.ticking = false
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.inspector) await this.stopInspector() // restaura el proxy del device
    await this.sampler?.dispose() // sin await, el -disable de timestats muere a mitad de vuelo
    this.server?.stop()
    this.timer = null
    this.server = null
  }
}
