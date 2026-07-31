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
import {
  autoIntervalMs,
  defaultAppStoreData,
  rankPackages,
  type AppStoreData,
  type ConfigPatch,
} from '../core/appStore'
import { SessionBuffer } from '../core/session/sessionBuffer'
import { SessionLog, sessionId } from '../core/session/sessionLog'
import { LogcatCapture } from '../core/logs/logcatCapture'
import { LogRing, DEFAULT_LOG_CAP } from '../core/logs/logRing'
import { LogSink } from '../core/logs/logSink'
import type { LogEntry } from '../core/logs/logEntry'
import {
  logsExportFilename,
  parseExportEntries,
  serializeLogsJsonl,
  serializeLogsTxt,
} from '../core/logs/exportLogs'
import { buildReportSession } from '../core/session/stats'
import { generateReportHtml, reportFilename } from '../report/generateReport'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  startHttpServer,
  isLocalOrigin,
  type RunningHttpServer,
  type WsClient,
} from '../runtime/httpServer'
import { resolveStaticFile } from './staticFiles'
import { EMBEDDED_UI } from './embeddedUi'
import {
  deviceMessage,
  sampleMessage,
  flowMessage,
  appMessage,
  logsMessage,
  type AppStatus,
} from './messages'
import { InspectorProxy } from './inspectorProxy'
import { run } from '../runtime/spawn'

export interface LiveServerOptions {
  transport: AdbTransport
  /** serial inicial; sin serial arranca en modo espera y se engancha al primer device. */
  serial?: string
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
  /** store de config del profiler (selector de apps, tema, intervalo, reportes). */
  appStore?: {
    readonly data: AppStoreData
    select(pkg: string): void
    set?(patch: ConfigPatch): void
  }
  /** intervalo del watcher de devices en modo espera (default 2000 ms). */
  devicePollMs?: number
  /** directorio del historial de sesiones (JSONL). Sin él, no se persiste en disco. */
  sessionsDir?: string
  /** cadencia del batch de logs al WS en ms (default 250; tests lo bajan). */
  logFlushMs?: number
}

/** Si el batch pendiente supera esto, se flushea ya (no esperar el timer). */
const LOG_BATCH_MAX = 500

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
  const [getprop, procMeminfo, sf, nproc, sfLatency] = await Promise.all([
    safe('getprop'),
    safe('cat /proc/meminfo'),
    // grep de la línea GLES: (aparece varias líneas abajo, no en el header)
    safe('dumpsys SurfaceFlinger | grep -m1 "GLES:"'),
    safe('nproc'),
    // refresh rate del panel (ticket 024): la 1ª línea es el período de vsync en ns
    safe('dumpsys SurfaceFlinger --latency'),
  ])
  return parseDeviceInfo({
    getprop,
    procMeminfo,
    surfaceflingerGles: sf,
    nproc,
    surfaceflingerLatency: sfLatency,
    serial,
  })
}

export class LiveServer {
  private server: RunningHttpServer | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private device: DeviceInfo | null = null
  private sampler: Sampler | null = null
  private inspector: InspectorProxy | null = null
  /** intención del usuario (toggle del dashboard o --inspect); el proxy real puede
   *  no estar corriendo aún (modo espera sin device). */
  private inspectorEnabled = false
  private inspectorBusy = false
  private proxyPrev: string | null = null
  private proxyApplied = false
  private ticking = false
  private appStatus: AppStatus | null = null
  /** app sin proceso vivo: se sigue sampleando/broadcasteando pero NO se persiste. */
  private appDead = false
  /** debounce: recién tras N refresh consecutivos sin proceso se declara muerta. */
  private deadTicks = 0
  private switching = false
  /** serial del device activo; null = modo espera (el watcher engancha al primero). */
  private serial: string | null
  private deviceWatch: ReturnType<typeof setInterval> | null = null
  /** buffer de sesión en memoria (export) + espejo en disco (historial). */
  private readonly buffer = new SessionBuffer()
  private sessionLog: SessionLog | null = null
  private intervalMs: number
  /** captura de logcat (ticket 027): app stream + crash stream, fuera del tick. */
  private logCapture: LogcatCapture | null = null
  private readonly logRing = new LogRing()
  private logSink: LogSink | null = null
  /** batches pendientes: WS (todo) y disco (pausado con la app muerta, salvo crashes). */
  private pendingWsLogs: LogEntry[] = []
  private pendingSinkLogs: LogEntry[] = []
  private logFlushTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: LiveServerOptions) {
    this.serial = opts.serial ?? null
    this.intervalMs = this.resolveIntervalMs()
    this.inspectorEnabled = opts.inspectHttp ?? false
  }

  private config(): AppStoreData {
    return this.opts.appStore?.data ?? defaultAppStoreData()
  }

  /**
   * Intervalo efectivo del carril rápido: flag del CLI (opts) > config manual del
   * usuario > auto según la RAM del device (ticket 023: gama baja → 2 s). Se
   * re-resuelve al capturar/cambiar device y en cada PUT /api/config.
   */
  private resolveIntervalMs(): number {
    if (this.opts.intervalMs !== undefined) return this.opts.intervalMs
    const cfg = this.config()
    if (!cfg.intervalAuto) return cfg.intervalMs
    return autoIntervalMs(this.device?.ramTotalMb ?? null)
  }

  /** Aplica el intervalo resuelto; reinicia el loop solo si cambió y ya corre. */
  private applyInterval(): void {
    const effective = this.resolveIntervalMs()
    if (effective === this.intervalMs) return
    this.intervalMs = effective
    if (this.timer) this.startTimer()
  }

  /**
   * Arranca: captura device, levanta HTTP+WS, empieza el loop de sampling.
   * Sin serial, levanta el dashboard en modo espera: los selectores de device/app
   * funcionan y el watcher se engancha solo al primer device autorizado que aparezca.
   */
  async start(): Promise<{ url: string; device: DeviceInfo | null }> {
    if (this.serial) {
      this.device = await captureDeviceInfo(this.opts.transport, this.serial)

      const pid = await resolvePid(this.opts.transport, this.serial, this.opts.packageName)
      const sampler = new Sampler(
        this.opts.transport,
        this.serial,
        this.opts.packageName,
        pid ?? 0,
        { refreshHz: this.device?.refreshHz ?? null },
      )
      this.sampler = sampler
      // habilitar timestats de SurfaceFlinger (FPS acumula desde acá)
      await sampler.init()
    }
    // sin proceso al arrancar: persistencia en pausa hasta que la app aparezca
    this.appDead = !(this.sampler && this.sampler.processId > 0)
    this.appStatus = {
      packageName: this.opts.packageName,
      pid: this.sampler?.processId || null,
      launched: false,
    }

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
        if (url.pathname === '/api/devices' && req.method === 'GET') {
          return this.handleListDevices()
        }
        if (url.pathname === '/api/device' && req.method === 'POST') {
          return this.handleSelectDevice(req)
        }
        if (url.pathname === '/api/report' && req.method === 'GET') {
          return this.handleReport(url)
        }
        if (url.pathname === '/api/sessions' && req.method === 'GET') {
          return this.handleListSessions()
        }
        if (url.pathname === '/api/logs' && req.method === 'GET') {
          return this.handleLogs(url)
        }
        if (url.pathname === '/api/logs/export' && req.method === 'POST') {
          return this.handleLogsExport(req)
        }
        if (url.pathname === '/api/config' && req.method === 'GET') {
          return Response.json({
            config: this.config(),
            effectiveIntervalMs: this.intervalMs,
            inspector: this.inspectorStatus(),
          })
        }
        if (url.pathname === '/api/config' && req.method === 'PUT') {
          return this.handlePutConfig(req)
        }
        if (url.pathname === '/api/inspector' && req.method === 'POST') {
          return this.handleSetInspector(req)
        }
        const resolved = resolveStaticFile(uiRoot, url.pathname)
        if (!resolved) return new Response('Not found', { status: 404 })
        try {
          const body = readFileSync(resolved.path)
          return new Response(body, { headers: { 'content-type': resolved.contentType } })
        } catch {
          // Binario compilado: src/ui no existe en disco — servir el asset embebido.
          const embedded = EMBEDDED_UI[resolved.rel]
          if (!embedded) return new Response('Not found', { status: 404 })
          try {
            const body = readFileSync(embedded)
            return new Response(body, { headers: { 'content-type': resolved.contentType } })
          } catch {
            return new Response('Not found', { status: 404 })
          }
        }
      },
      onOpen: (client: WsClient) => {
        // Al conectar: mandar la ficha del device y la app profileada actual.
        if (this.device) client.send(deviceMessage(this.device))
        if (this.appStatus) client.send(appMessage(this.appStatus))
      },
    })

    // Inspector HTTP opcional: proxy pass-through + proxy del device por adb reverse.
    // Arranca según --inspect; después el dashboard lo prende/apaga en caliente.
    if (this.inspectorEnabled && this.serial) {
      await this.startInspector()
    }

    // Modo espera: watchear adb hasta que aparezca un device autorizado y engancharse.
    if (!this.serial) this.startDeviceWatch()

    // Historial en disco: una sesión JSONL por corrida del server.
    if (this.opts.sessionsDir) {
      const started = new Date()
      this.sessionLog = new SessionLog(
        this.opts.sessionsDir,
        sessionId(started),
        started.toISOString(),
        this.opts.packageName,
        this.device,
      )
      // logs hermanos de la sesión: <id>.logs.jsonl en el mismo directorio
      this.logSink = new LogSink(this.opts.sessionsDir, this.sessionLog.id)
    }

    // Captura de logcat (ticket 027): stream aparte del tick del sampler.
    // Sin device no hay stream (el switchApp del enganche posterior lo arma).
    if (this.serial) this.startLogCapture()
    this.logFlushTimer = setInterval(() => this.flushLogs(), this.opts.logFlushMs ?? 250)

    // con la ficha del device ya capturada, el modo auto puede haber cambiado el intervalo
    this.intervalMs = this.resolveIntervalMs()
    this.startTimer()
    // primer sample enseguida (así el dashboard no arranca vacío)
    void this.tick()

    const url = `http://localhost:${this.server.port}`
    return { url, device: this.device }
  }

  /** (Re)arranca el loop de sampling con el intervalo configurado actual. */
  private startTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
  }

  /**
   * Polea `adb devices` hasta encontrar un device autorizado y se engancha
   * (mismo camino que POST /api/device). Corre solo mientras no hay serial activo.
   */
  private startDeviceWatch(): void {
    const pollMs = this.opts.devicePollMs ?? 2000
    this.deviceWatch = setInterval(() => {
      void (async () => {
        if (this.serial || this.switching) return
        let candidates: Awaited<ReturnType<AdbTransport['devices']>> = []
        try {
          candidates = await this.opts.transport.devices()
        } catch {
          return // adb caído: reintentar en el próximo poll
        }
        const target = candidates.find((d) => d.state === 'device')
        if (!target) return
        this.switching = true
        try {
          await this.switchDevice(target.serial)
          if (this.deviceWatch) clearInterval(this.deviceWatch)
          this.deviceWatch = null
        } catch {
          this.serial = null // attach fallido (¿lo desenchufaron?): seguir esperando
        } finally {
          this.switching = false
        }
      })()
    }, pollMs)
  }

  /** Levanta el proxy pass-through, lo cablea al device (reverse + http_proxy) y streamea flows. */
  private async startInspector(): Promise<void> {
    const port = this.opts.proxyPort ?? 8899
    const adb = this.opts.adbPath ?? 'adb'
    const serial = this.serial
    if (!serial) return
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
    const serial = this.serial
    if (!serial) {
      this.inspector?.stop()
      this.inspector = null
      return
    }
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
          // `:0` = "sin proxy" explícito. Verificado en el SM-A155M (API 36): un
          // `delete global http_proxy` solo NO alcanza — global_http_proxy_host/port
          // sobreviven y dejan el device sin internet hasta limpiarlos a mano.
          await this.opts.transport.shell(serial, 'settings put global http_proxy :0')
          await this.opts.transport.shell(serial, 'settings delete global global_http_proxy_host')
          await this.opts.transport.shell(serial, 'settings delete global global_http_proxy_port')
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

  /**
   * (Re)arma la captura de logcat contra el serial/app/pid actuales. Se llama al
   * arrancar con device y tras cada switch de app/device. Sin device ⇒ no-op
   * (sin errores ruidosos, igual que el resto del modo espera).
   */
  private startLogCapture(): void {
    this.logCapture?.stop()
    this.logCapture = null
    const serial = this.serial
    if (!serial) return
    const pkg = this.appStatus?.packageName ?? this.opts.packageName
    const capture = new LogcatCapture(this.opts.transport, serial, pkg, (e) => this.onLogEntry(e))
    this.logCapture = capture
    const pid = this.appStatus?.pid ?? null
    capture.start(pid)
  }

  /** Cada entrada capturada: al ring (memoria), al batch WS y — con la app viva
   *  o si es crash — al batch de persistencia NDJSON. */
  private onLogEntry(e: LogEntry): void {
    this.logRing.push(e)
    this.pendingWsLogs.push(e)
    // la persistencia pausa con la app muerta (no inflar el archivo), pero los
    // crashes/ANR se persisten siempre: son exactamente el evento que importa
    if (!this.appDead || e.isCrash) this.pendingSinkLogs.push(e)
    if (this.pendingWsLogs.length >= LOG_BATCH_MAX) this.flushLogs()
  }

  /** Batch por tick del flush timer: un mensaje WS con N entries + un append NDJSON. */
  private flushLogs(): void {
    if (this.pendingWsLogs.length > 0) {
      this.server?.broadcast(logsMessage(this.pendingWsLogs))
      this.pendingWsLogs = []
    }
    if (this.pendingSinkLogs.length > 0) {
      this.logSink?.append(this.pendingSinkLogs)
      this.pendingSinkLogs = []
    }
  }

  /** GET /api/logs?n=500 — últimas N entradas del ring (bootstrap del panel 028). */
  private handleLogs(url: URL): Response {
    const nParam = url.searchParams.get('n')
    let n = 500
    if (nParam !== null) {
      n = Number(nParam)
      if (!Number.isInteger(n) || n <= 0 || n > DEFAULT_LOG_CAP) {
        return Response.json({ error: 'n inválido' }, { status: 400 })
      }
    }
    return Response.json({ entries: this.logRing.last(n) })
  }

  /**
   * POST /api/logs/export (ticket 029) — serializa logs a .txt legible o .jsonl,
   * guarda copia en la carpeta de reportes y devuelve el archivo como attachment
   * (mismo doble destino que /api/report). Body:
   *   { scope: 'session'|'filtered', format: 'txt'|'jsonl', sessionId?, entries? }
   *
   * Decisión de arquitectura: para scope 'filtered' el CLIENTE manda las entries
   * visibles (LogsPanel.getFilteredEntries) en el body — no una spec de filtro que
   * el server re-aplique sobre su ring. El buffer del cliente es el único que sabe
   * exactamente qué se ve: se limpia al cambiar de app/device mientras el ring del
   * server conserva líneas de la app anterior (limitación documentada del 028), y
   * el dedup bootstrap↔WS también vive del lado del cliente. El peor caso (50k
   * entries ≈ 12 MB) viaja por localhost: irrelevante para una tool local.
   */
  private async handleLogsExport(req: Request): Promise<Response> {
    const origin = req.headers.get('origin')
    if (origin !== null && !isLocalOrigin(origin)) {
      return new Response('Forbidden origin', { status: 403 })
    }
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return Response.json({ error: 'body inválido' }, { status: 400 })
    }
    const format = body['format']
    if (format !== 'txt' && format !== 'jsonl') {
      return Response.json({ error: 'format inválido (txt|jsonl)' }, { status: 400 })
    }
    const scope = body['scope']
    if (scope !== 'session' && scope !== 'filtered') {
      return Response.json({ error: 'scope inválido (session|filtered)' }, { status: 400 })
    }

    let entries: LogEntry[]
    let sessionId: string | null = null
    if (scope === 'filtered') {
      // input hostil: viene del browser y termina escrito a disco — validar/normalizar
      const parsed = parseExportEntries(body['entries'], DEFAULT_LOG_CAP)
      if (parsed === null) {
        return Response.json({ error: 'entries inválidas' }, { status: 400 })
      }
      if (parsed.length === 0) {
        return Response.json({ error: 'sin logs para exportar' }, { status: 409 })
      }
      entries = parsed
    } else {
      const requested = body['sessionId']
      if (requested !== undefined && typeof requested !== 'string') {
        return Response.json({ error: 'sessionId inválido' }, { status: 400 })
      }
      this.flushLogs() // lo pendiente va a disco antes de leer el NDJSON
      if (requested !== undefined && requested !== this.sessionLog?.id) {
        // sesión pasada: solo existe en el NDJSON hermano (LogSink valida el id)
        if (!this.opts.sessionsDir) {
          return Response.json({ error: 'sin historial' }, { status: 404 })
        }
        const read = LogSink.read(this.opts.sessionsDir, requested)
        if (read === null || read.length === 0) {
          return Response.json({ error: 'la sesión no tiene logs' }, { status: 404 })
        }
        entries = read
        sessionId = requested
      } else {
        // sesión en curso: lo persistido; sin sessionsDir cae al ring en memoria
        sessionId = this.sessionLog?.id ?? null
        const read =
          this.opts.sessionsDir && sessionId ? LogSink.read(this.opts.sessionsDir, sessionId) : null
        entries = read ?? this.logRing.last(DEFAULT_LOG_CAP)
        if (entries.length === 0) {
          return Response.json({ error: 'la sesión no tiene logs' }, { status: 404 })
        }
      }
    }

    const content = format === 'txt' ? serializeLogsTxt(entries) : serializeLogsJsonl(entries)
    const filename = logsExportFilename({
      format,
      filtered: scope === 'filtered',
      sessionId,
      now: new Date(),
    })
    // copia en la carpeta de reportes (best-effort: el download no depende del disco)
    try {
      const dir = this.config().reportsDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, filename), content)
    } catch {
      /* sin copia local */
    }
    return new Response(content, {
      headers: {
        'content-type':
          format === 'txt' ? 'text/plain; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    })
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
      const alive = await sampler.refreshPid()
      this.trackAppLife(alive)
      // la app seleccionada estaba cerrada y recién aparece su proceso: avisar al dashboard
      if (this.appStatus && this.appStatus.pid === null && sampler.processId > 0) {
        this.appStatus = { ...this.appStatus, pid: sampler.processId }
        this.server?.broadcast(appMessage(this.appStatus))
      }
      // logcat sigue al pid vivo (muerte/renacimiento incluidos): setPid es
      // idempotente — solo re-arma el stream cuando el pid realmente cambió
      if (sampler.processId > 0) this.logCapture?.setPid(sampler.processId)
      const sample = await sampler.sampleOnce()
      // Registrar en el buffer (export en vivo) y en el historial en disco — solo con
      // la app viva. Con el proceso muerto el dashboard sigue en vivo (broadcast),
      // pero no se persisten horas de ticks null: quedan los eventos died/restarted.
      if (this.appStatus && this.serial && !this.appDead) {
        const entry = { sample, pkg: this.appStatus.packageName, serial: this.serial }
        this.buffer.push(entry)
        this.sessionLog?.appendSample(entry)
      }
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

  /**
   * Debounce de vida del proceso (3 refresh seguidos sin verlo = muerto): pausa la
   * persistencia y deja eventos app-died/app-restarted en el historial, así el
   * timeline muestra el hueco honesto en vez de horas de samples null.
   */
  private trackAppLife(alive: boolean | null): void {
    if (alive === null) return // adb no contestó: no concluir nada este tick
    const pkg = this.appStatus?.packageName ?? this.opts.packageName
    const serial = this.serial
    if (alive) {
      this.deadTicks = 0
      if (this.appDead) {
        this.appDead = false
        if (serial) {
          const ev = { ts: Date.now(), kind: 'app-restarted' as const, pkg, serial }
          this.buffer.addEvent(ev)
          this.sessionLog?.appendEvent(ev)
        }
      }
      return
    }
    this.deadTicks++
    if (this.appDead || this.deadTicks < 3) return
    this.appDead = true
    // app muerta: cortar el stream por pid (ya no existe); el crash stream queda
    // vivo para capturar el stacktrace/ANR de esta muerte
    this.logCapture?.setPid(null)
    const wasAlive = this.appStatus?.pid != null
    if (this.appStatus) {
      this.appStatus = { ...this.appStatus, pid: null }
      this.server?.broadcast(appMessage(this.appStatus))
    }
    // sin pid previo no hubo vida que registrar (app nunca lanzada): no es una muerte
    if (wasAlive && serial) {
      const ev = { ts: Date.now(), kind: 'app-died' as const, pkg, serial }
      this.buffer.addEvent(ev)
      this.sessionLog?.appendEvent(ev)
    }
  }

  /** GET /api/packages[?system=1] — instaladas + ranking de uso + término del chip. */
  private async handleListPackages(url: URL): Promise<Response> {
    const includeSystem = url.searchParams.get('system') === '1'
    const installed = this.serial
      ? await listPackages(this.opts.transport, this.serial, { includeSystem })
      : []
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
    if (!this.serial) {
      return Response.json({ error: 'sin device conectado' }, { status: 409 })
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
   * recordUsage=false cuando el switch no es una elección de app del usuario
   * (p.ej. re-enganchar la misma app tras cambiar de device).
   */
  private async switchApp(pkg: string, recordUsage = true): Promise<AppStatus> {
    const { transport } = this.opts
    const serial = this.serial
    if (!serial) throw new Error('switchApp sin device activo')
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
      pid = await this.waitForPid(serial, pkg, 5000)
    }

    const sampler = new Sampler(transport, serial, pkg, pid ?? 0, {
      refreshHz: this.device?.refreshHz ?? null,
    })
    await sampler.init()
    this.sampler = sampler
    // estado de vida fresco: sin proceso arranca en pausa (no persistir nulls de espera)
    this.appDead = pid === null
    this.deadTicks = 0
    this.appStatus = { packageName: pkg, pid, launched }
    if (recordUsage) this.opts.appStore?.select(pkg)
    const ev = { ts: Date.now(), kind: 'app' as const, pkg, serial }
    this.buffer.addEvent(ev)
    this.sessionLog?.appendEvent(ev)
    this.server?.broadcast(appMessage(this.appStatus))
    // logcat de la app nueva (package cambió ⇒ captura nueva, streams re-armados)
    this.startLogCapture()
    return this.appStatus
  }

  /** GET /api/devices — lista `adb devices` en el momento (refresh = re-pedir esto). */
  private async handleListDevices(): Promise<Response> {
    let devices: Awaited<ReturnType<AdbTransport['devices']>> = []
    try {
      devices = await this.opts.transport.devices()
    } catch {
      /* adb caído ⇒ lista vacía; el dashboard muestra el error */
    }
    return Response.json({ devices, current: this.serial })
  }

  /** POST /api/device {"serial": "..."} — cambia el device profileado en caliente. */
  private async handleSelectDevice(req: Request): Promise<Response> {
    const origin = req.headers.get('origin')
    if (origin !== null && !isLocalOrigin(origin)) {
      return new Response('Forbidden origin', { status: 403 })
    }
    let serial: unknown
    try {
      serial = ((await req.json()) as { serial?: unknown }).serial
    } catch {
      return Response.json({ error: 'body inválido' }, { status: 400 })
    }
    // Se valida contra la lista real de adb: solo un device presente y autorizado
    // es elegible (y de paso nunca viaja un serial arbitrario a adb).
    if (typeof serial !== 'string' || !serial) {
      return Response.json({ error: 'serial inválido' }, { status: 400 })
    }
    if (this.switching) {
      return Response.json({ error: 'switch en curso' }, { status: 409 })
    }
    this.switching = true
    try {
      const devices = await this.opts.transport.devices()
      const target = devices.find((d) => d.serial === serial)
      if (!target) {
        return Response.json({ error: 'device no conectado' }, { status: 404 })
      }
      if (target.state !== 'device') {
        return Response.json({ error: `device en estado "${target.state}"` }, { status: 409 })
      }
      if (serial === this.serial) {
        return Response.json({ ok: true, device: this.device, app: this.appStatus })
      }
      const result = await this.switchDevice(serial)
      return Response.json({ ok: true, ...result })
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 })
    } finally {
      this.switching = false
    }
  }

  /**
   * Cambia el device activo: restaura el inspector en el device viejo, re-captura
   * la ficha, recablea el inspector al nuevo y re-engancha la app actual
   * (lanzándola si está cerrada). El dashboard recibe {device} y luego {app}.
   */
  private async switchDevice(serial: string): Promise<{ device: DeviceInfo; app: AppStatus }> {
    const pkg = this.appStatus?.packageName ?? this.opts.packageName
    // el proxy del inspector quedó seteado en el device viejo: restaurar ANTES de soltarlo
    if (this.inspector) await this.stopInspector()
    // los streams de logcat apuntan al device viejo: cortarlos (switchApp re-arma)
    this.logCapture?.stop()
    this.logCapture = null
    const old = this.sampler
    this.sampler = null
    await old?.dispose()

    this.serial = serial
    this.device = await captureDeviceInfo(this.opts.transport, serial)
    this.applyInterval() // la RAM del device nuevo puede cambiar el intervalo auto
    this.server?.broadcast(deviceMessage(this.device))
    const ev = { ts: Date.now(), kind: 'device' as const, pkg, serial }
    this.buffer.addEvent(ev)
    this.sessionLog?.appendEvent(ev)
    this.sessionLog?.appendDevice(this.device)
    // en modo espera con el inspector prendido nunca llegó a arrancar: acá se cablea
    if (this.inspectorEnabled) await this.startInspector()
    const app = await this.switchApp(pkg, false)
    return { device: this.device, app }
  }

  /**
   * GET /api/report — genera el HTML standalone y lo baja como attachment.
   *   ?window=full | <minutos>   → de la sesión viva (recortada a la app actual)
   *   ?session=<id>              → de una sesión pasada del historial (último tramo)
   * Además guarda una copia en la carpeta de reportes configurada.
   */
  private async handleReport(url: URL): Promise<Response> {
    const sessionParam = url.searchParams.get('session')
    let samples: import('../core/schema').Sample[]
    let trimmed: boolean
    let pkg: string
    let device: DeviceInfo | null
    let intervalMs = this.intervalMs

    if (sessionParam) {
      if (!this.opts.sessionsDir) return Response.json({ error: 'sin historial' }, { status: 404 })
      const data = SessionLog.read(this.opts.sessionsDir, sessionParam)
      if (!data || data.entries.length === 0) {
        return Response.json({ error: 'sesión no encontrada o vacía' }, { status: 404 })
      }
      // último tramo continuo de la sesión (misma regla que el export en vivo)
      const last = data.entries[data.entries.length - 1]!
      let from = data.entries.length - 1
      while (
        from > 0 &&
        data.entries[from - 1]!.pkg === last.pkg &&
        data.entries[from - 1]!.serial === last.serial
      ) {
        from--
      }
      samples = data.entries.slice(from).map((e) => e.sample)
      trimmed = from > 0
      pkg = last.pkg
      device = data.device
      if (samples.length >= 2) {
        intervalMs = Math.max(250, samples[1]!.ts - samples[0]!.ts)
      }
    } else {
      if (!this.serial || !this.appStatus) {
        return Response.json({ error: 'sin device activo' }, { status: 409 })
      }
      const windowParam = url.searchParams.get('window') ?? 'full'
      let windowMs: number | undefined
      if (windowParam !== 'full') {
        const minutes = Number(windowParam)
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 480) {
          return Response.json({ error: 'window inválida' }, { status: 400 })
        }
        windowMs = minutes * 60_000
      }
      const seg = this.buffer.currentSegment(this.appStatus.packageName, this.serial, windowMs)
      samples = seg.samples
      trimmed = seg.trimmed
      pkg = this.appStatus.packageName
      device = this.device
    }

    if (samples.length === 0) {
      return Response.json({ error: 'sin muestras en la ventana pedida' }, { status: 409 })
    }
    // Logs para marcas + sección del reporte (ticket 030): mismo camino que el
    // export del 029 — NDJSON hermano de la sesión; la sesión en curso flushea lo
    // pendiente primero y sin sessionsDir cae al ring en memoria. Sesión sin logs
    // ⇒ null ⇒ el reporte sale sin sección (nunca rompe). El recorte a la ventana
    // lo hace buildReportSession con los ts de los samples.
    let logEntries: LogEntry[] | null = null
    if (sessionParam) {
      logEntries = this.opts.sessionsDir ? LogSink.read(this.opts.sessionsDir, sessionParam) : null
    } else {
      this.flushLogs()
      const sid = this.sessionLog?.id ?? null
      const read = this.opts.sessionsDir && sid ? LogSink.read(this.opts.sessionsDir, sid) : null
      logEntries = read ?? this.logRing.last(DEFAULT_LOG_CAP)
    }
    const session = buildReportSession({
      samples,
      packageName: pkg,
      device,
      intervalMs,
      trimmed,
      // el veredicto del reporte usa el target configurado al momento de exportar
      fpsTarget: this.config().fpsTarget,
      logEntries,
    })
    const html = generateReportHtml(session, this.config().theme, new Date())
    const filename = reportFilename(session, new Date())
    // copia en la carpeta de reportes (best-effort: el download no depende del disco)
    try {
      const dir = this.config().reportsDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, filename), html)
    } catch {
      /* sin copia local */
    }
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  /** GET /api/sessions — historial en disco, más recientes primero.
   *  `hasLogs` habilita/deshabilita los botones de export de logs del menú (029). */
  private handleListSessions(): Response {
    const dir = this.opts.sessionsDir
    this.flushLogs() // que la sesión en curso reporte hasLogs al día
    const sessions = dir
      ? SessionLog.list(dir).map((s) => ({
          ...s,
          hasLogs: existsSync(join(dir, `${s.id}.logs.jsonl`)),
        }))
      : []
    return Response.json({ sessions, current: this.sessionLog?.id ?? null })
  }

  /** Estado del inspector para el dashboard (enabled = intención; running = proxy vivo). */
  private inspectorStatus(): { enabled: boolean; running: boolean; port: number } {
    return {
      enabled: this.inspectorEnabled,
      running: this.inspector !== null,
      port: this.opts.proxyPort ?? 8899,
    }
  }

  /**
   * POST /api/inspector {"enabled": true|false} — prende/apaga el inspector HTTP en
   * caliente: proxy pass-through + `adb reverse` + http_proxy del device al prender;
   * al apagar restaura el proxy del device (el teléfono vuelve a navegar normal).
   */
  private async handleSetInspector(req: Request): Promise<Response> {
    const origin = req.headers.get('origin')
    if (origin !== null && !isLocalOrigin(origin)) {
      return new Response('Forbidden origin', { status: 403 })
    }
    let enabled: unknown
    try {
      enabled = ((await req.json()) as { enabled?: unknown }).enabled
    } catch {
      return Response.json({ error: 'body inválido' }, { status: 400 })
    }
    if (typeof enabled !== 'boolean') {
      return Response.json({ error: 'enabled debe ser boolean' }, { status: 400 })
    }
    if (this.switching || this.inspectorBusy) {
      return Response.json({ error: 'operación en curso' }, { status: 409 })
    }
    if (enabled && !this.serial) {
      return Response.json({ error: 'sin device conectado' }, { status: 409 })
    }
    this.inspectorBusy = true
    try {
      if (enabled) {
        this.inspectorEnabled = true
        if (!this.inspector) await this.startInspector()
      } else {
        this.inspectorEnabled = false
        await this.stopInspector() // restaura el proxy del device; idempotente
      }
      return Response.json({ ok: true, inspector: this.inspectorStatus() })
    } catch (err) {
      // enable fallido a mitad (p.ej. adb reverse): limpiar lo aplicado para NO dejar
      // el device con un proxy roto (la lección del SM-A155M sin internet).
      this.inspectorEnabled = false
      try {
        await this.stopInspector()
      } catch {
        /* best-effort */
      }
      return Response.json({ error: String(err) }, { status: 500 })
    } finally {
      this.inspectorBusy = false
    }
  }

  /** PUT /api/config — aplica configuración en caliente y la persiste. */
  private async handlePutConfig(req: Request): Promise<Response> {
    const origin = req.headers.get('origin')
    if (origin !== null && !isLocalOrigin(origin)) {
      return new Response('Forbidden origin', { status: 403 })
    }
    let patch: ConfigPatch
    try {
      patch = (await req.json()) as ConfigPatch
    } catch {
      return Response.json({ error: 'body inválido' }, { status: 400 })
    }
    this.opts.appStore?.set?.(patch)
    const cfg = this.config()
    // el intervalo aplica en caliente (manual o auto): re-resolver y reiniciar si cambió
    this.applyInterval()
    return Response.json({ ok: true, config: cfg, effectiveIntervalMs: this.intervalMs })
  }

  /** Pollea el pid del package hasta timeout. null si no apareció. */
  private async waitForPid(serial: string, pkg: string, timeoutMs: number): Promise<number | null> {
    const stepMs = 500
    for (let waited = 0; waited < timeoutMs; waited += stepMs) {
      const pid = await resolvePid(this.opts.transport, serial, pkg)
      if (pid !== null) return pid
      await new Promise((resolve) => setTimeout(resolve, stepMs))
    }
    return null
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.deviceWatch) clearInterval(this.deviceWatch)
    this.deviceWatch = null
    if (this.logFlushTimer) clearInterval(this.logFlushTimer)
    this.logFlushTimer = null
    this.logCapture?.stop()
    this.logCapture = null
    this.flushLogs() // lo pendiente va a disco antes de cerrar
    if (this.inspector) await this.stopInspector() // restaura el proxy del device
    await this.sampler?.dispose() // sin await, el -disable de timestats muere a mitad de vuelo
    this.server?.stop()
    this.timer = null
    this.server = null
  }
}
