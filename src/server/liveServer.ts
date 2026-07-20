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
import { listPackages } from '../core/adb/listPackages'
import { isValidPackageName } from '../core/adb/packageName'
import { defaultAppStoreData, rankPackages, type AppStoreData } from '../core/appStore'
import {
  startHttpServer,
  isLocalOrigin,
  type RunningHttpServer,
  type WsClient,
} from '../runtime/httpServer'
import { resolveStaticFile } from './staticFiles'
import { deviceMessage, sampleMessage, flowMessage, appMessage, type AppStatus } from './messages'
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
  /** store del selector de apps (uso/última/filtro). Sin store, el selector anda sin persistir. */
  appStore?: { readonly data: AppStoreData; select(pkg: string): void }
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
  private appStatus: AppStatus | null = null
  private switching = false

  constructor(private readonly opts: LiveServerOptions) {}

  /** Arranca: captura device, levanta HTTP+WS, empieza el loop de sampling. */
  async start(): Promise<{ url: string; device: DeviceInfo }> {
    this.device = await captureDeviceInfo(this.opts.transport, this.opts.serial)

    const pid = await resolvePid(this.opts.transport, this.opts.serial, this.opts.packageName)
    const sampler = new Sampler(
      this.opts.transport,
      this.opts.serial,
      this.opts.packageName,
      pid ?? 0,
    )
    this.sampler = sampler
    this.appStatus = { packageName: this.opts.packageName, pid, launched: false }
    // habilitar timestats de SurfaceFlinger (FPS acumula desde acá)
    await sampler.init()

    const uiRoot = this.opts.uiRoot
    this.server = startHttpServer(this.opts.port ?? 4517, {
      fetch: (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/api/packages' && req.method === 'GET') {
          return this.handleListPackages(url)
        }
        if (url.pathname === '/api/app' && req.method === 'POST') {
          return this.handleSelectApp(req)
        }
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
        // Al conectar: mandar la ficha del device y la app profileada actual.
        if (this.device) client.send(deviceMessage(this.device))
        if (this.appStatus) client.send(appMessage(this.appStatus))
      },
    })

    // Inspector HTTP opcional: proxy pass-through + proxy del device por adb reverse.
    if (this.opts.inspectHttp) {
      await this.startInspector()
    }

    const interval = this.opts.intervalMs ?? 1000
    this.timer = setInterval(() => {
      void this.tick()
    }, interval)
    // primer sample enseguida (así el dashboard no arranca vacío)
    void this.tick()

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

  private async tick(): Promise<void> {
    // Sin este guard, un device lento (shells adb con timeout de varios segundos)
    // encola ticks concurrentes que pisan prevCpu/prevNet → deltas corruptos.
    if (this.ticking) return
    this.ticking = true
    try {
      // durante un switch de app el sampler viejo ya se descartó: no hay qué samplear
      const sampler = this.sampler
      if (!sampler) return
      // por si la app se reinició (nuevo pid); best-effort, barato cada tick.
      await sampler.refreshPid()
      // la app seleccionada estaba cerrada y recién aparece su proceso: avisar al dashboard
      if (this.appStatus && this.appStatus.pid === null && sampler.processId > 0) {
        this.appStatus = { ...this.appStatus, pid: sampler.processId }
        this.server?.broadcast(appMessage(this.appStatus))
      }
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

  /** GET /api/packages[?system=1] — instaladas + ranking de uso + término del chip. */
  private async handleListPackages(url: URL): Promise<Response> {
    const includeSystem = url.searchParams.get('system') === '1'
    const installed = await listPackages(this.opts.transport, this.opts.serial, { includeSystem })
    const store = this.opts.appStore?.data ?? defaultAppStoreData()
    const body = {
      packages: rankPackages(installed, store.usage),
      usage: store.usage,
      filterTerm: store.filterTerm,
      current: this.appStatus?.packageName ?? this.opts.packageName,
    }
    return Response.json(body)
  }

  /** POST /api/app {"package": "..."} — cambia la app profileada en caliente. */
  private async handleSelectApp(req: Request): Promise<Response> {
    // El fetch HTTP no está sujeto al check de origin del WS: sin esto, cualquier
    // página abierta en el browser podría disparar el switch (CSRF local).
    const origin = req.headers.get('origin')
    if (origin !== null && !isLocalOrigin(origin)) {
      return new Response('Forbidden origin', { status: 403 })
    }
    let pkg: unknown
    try {
      pkg = ((await req.json()) as { package?: unknown }).package
    } catch {
      return Response.json({ error: 'body inválido' }, { status: 400 })
    }
    // input hostil: viaja interpolado a `adb shell` (pidof/monkey/dumpsys)
    if (typeof pkg !== 'string' || !isValidPackageName(pkg)) {
      return Response.json({ error: 'package inválido' }, { status: 400 })
    }
    if (this.switching) {
      return Response.json({ error: 'switch en curso' }, { status: 409 })
    }
    this.switching = true
    try {
      const status = await this.switchApp(pkg)
      return Response.json({ ok: true, app: status })
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 })
    } finally {
      this.switching = false
    }
  }

  /**
   * Reinicia el sampling contra otro package. Si la app no está corriendo, la lanza
   * (monkey no requiere conocer la activity) y espera el pid ~5s; si no aparece,
   * queda en modo espera y refreshPid engancha cuando abra.
   */
  private async switchApp(pkg: string): Promise<AppStatus> {
    const { transport, serial } = this.opts
    const old = this.sampler
    this.sampler = null // los ticks pasan a no-op mientras dura el switch
    await old?.dispose()

    let launched = false
    let pid = await resolvePid(transport, serial, pkg)
    if (pid === null) {
      launched = true
      try {
        await transport.shell(serial, `monkey -p ${pkg} 1`)
      } catch {
        /* best-effort: si monkey falla, igual quedamos esperando el proceso */
      }
      pid = await this.waitForPid(pkg, 5000)
    }

    const sampler = new Sampler(transport, serial, pkg, pid ?? 0)
    await sampler.init()
    this.sampler = sampler
    this.appStatus = { packageName: pkg, pid, launched }
    this.opts.appStore?.select(pkg)
    this.server?.broadcast(appMessage(this.appStatus))
    return this.appStatus
  }

  /** Pollea el pid del package hasta timeout. null si no apareció. */
  private async waitForPid(pkg: string, timeoutMs: number): Promise<number | null> {
    const stepMs = 500
    for (let waited = 0; waited < timeoutMs; waited += stepMs) {
      const pid = await resolvePid(this.opts.transport, this.opts.serial, pkg)
      if (pid !== null) return pid
      await new Promise((resolve) => setTimeout(resolve, stepMs))
    }
    return null
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
