// Live server (ticket 021): levanta HTTP+WS, sirve el dashboard desde uiRoot y
// streamea Samples en vivo. Corre el Sampler a 1 Hz y hace broadcast de cada Sample;
// al conectar un cliente le manda la ficha del device.
//
// Costuras respetadas: adb solo por AdbTransport (via Sampler); runtime solo por
// src/runtime/httpServer (Bun aislado). Opcionalmente appendea los Samples a un JSONL.
import { appendFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import type { AdbDevice, AdbTransport } from '../core/adb/AdbTransport'
import type { IosTransport } from '../core/ios/IosTransport'
import { IosMetricSource } from '../core/ios/IosMetricSource'
import { IosLogCapture } from '../core/ios/IosLogCapture'
import { capabilitiesFor, type Capabilities } from '../core/platform'
import { iosDeviceInfo, resolveIosProcess } from '../core/ios/deviceInfo'
import type { DeviceInfo, Sample } from '../core/schema'
import { Sampler, resolvePid } from '../core/sampler/sampler'
import { parseDeviceInfo } from '../core/collectors/deviceInfo'
import { listPackages } from '../core/adb/listPackages'
import { isValidPackageName } from '../core/adb/packageName'
import { isValidBundleId } from '../core/ios/bundleId'
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
  connectionMessage,
  type DashboardPane,
  type AppStatus,
  type ConnectionState,
} from './messages'
import { InspectorProxy } from './inspectorProxy'
import { run } from '../runtime/spawn'

export interface LiveServerOptions {
  transport: AdbTransport
  /**
   * Fuente de devices iOS (ticket 035). Opcional a propósito: sin ella el server se
   * comporta exactamente como antes, y así el camino Android — el que hoy funciona — no
   * depende de que Python esté instalado.
   */
  // `isAvailable` va aparte y opcional: el watcher lo usa para no arrancar un proceso
  // Python cada pocos segundos en una máquina que sólo perfila Android, pero los mocks de
  // los tests no tienen por qué implementarlo.
  iosTransport?: Pick<
    IosTransport,
    'devices' | 'stream' | 'processes' | 'systemInfo' | 'apps' | 'appExecutable'
  > &
    Partial<Pick<IosTransport, 'isAvailable'>>
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
  /**
   * Cadencia del poll de iOS dentro del watcher (default 6000 ms). Va aparte del de
   * Android porque cada consulta arranca un proceso Python de ~1.2 s; los tests lo bajan.
   */
  iosDevicePollMs?: number
  /** directorio del historial de sesiones (JSONL). Sin él, no se persiste en disco. */
  sessionsDir?: string
  /** cadencia del batch de logs al WS en ms (default 250; tests lo bajan). */
  logFlushMs?: number
  /**
   * Ventana de gracia iOS antes de dar el device por perdido (default 3000 ms). Un
   * microcorte del túnel no debe costar un teardown más un handshake de decenas de segundos.
   */
  iosGraceMs?: number
  /** Frescura máxima de un canal iOS antes de que su valor salga null (default 3000 ms). */
  iosStaleMs?: number
  /** Cadencia del watch de procesos iOS (default 5000 ms; los tests lo bajan). */
  iosProcessPollMs?: number
}

/**
 * El dashboard se sirve SIN cache (ticket 035).
 *
 * Sin estas cabeceras el browser aplica cache heurístico sobre el JS/CSS: se edita
 * `src/ui/`, se refresca, y sigue corriendo la copia vieja. Nos pasó justo al agregar
 * los devices iOS a la lista — el server ya los devolvía y la UI no los mostraba.
 * Es un server local de una tool de desarrollo: no hay nada que ganar cacheando.
 */
export function staticHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': 'no-store, must-revalidate',
  }
}

/** Si el batch pendiente supera esto, se flushea ya (no esperar el timer). */
const LOG_BATCH_MAX = 500

function paneFromUrl(url: URL): DashboardPane {
  return url.searchParams.get('pane') === 'secondary' ? 'secondary' : 'primary'
}

/** Estado deliberadamente acotado del segundo panel: métricas y logs en vivo, sin
 * duplicar exportes ni el inspector HTTP (que siguen perteneciendo a la sesión A). */
interface SecondaryLane {
  serial: string | null
  device: DeviceInfo | null
  sampler: Sampler | null
  iosSource: IosMetricSource | null
  app: AppStatus | null
  capabilities: Capabilities
  timer: ReturnType<typeof setInterval> | null
  iosProcessTimer: ReturnType<typeof setInterval> | null
  logCapture: LogcatCapture | null
  iosLogCapture: IosLogCapture | null
  logRing: LogRing
  pendingLogs: LogEntry[]
  ticking: boolean
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
  /** Snapshot compartido por todos los paneles: evita lanzar varios procesos de discovery
   * iOS cuando A y B abren el selector al mismo tiempo. */
  private deviceListCache: { devices: AdbDevice[]; updatedAt: number } | null = null
  private deviceListRefresh: Promise<AdbDevice[]> | null = null
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
  /** fuente de métricas iOS; no-null ⇒ el device activo es un iPhone (ticket 038). */
  private iosSource: IosMetricSource | null = null
  /** poll del proceso de la app en iOS (análogo de refreshPid en Android). */
  private iosProcessWatch: ReturnType<typeof setInterval> | null = null
  /** captura de syslog en iOS (ticket 039); alimenta el MISMO ring y panel que logcat. */
  private iosLogCapture: IosLogCapture | null = null
  /**
   * CFBundleExecutable de la app iOS elegida — el nombre EXACTO de su proceso. Se cachea
   * porque el watch corre cada 5 s y resolverlo cuesta un `apps query` por vuelta.
   */
  private iosExecutable: string | null = null
  /** capacidades del device activo — la UI esconde lo que no existe en la plataforma. */
  private capabilities: Capabilities = capabilitiesFor('android')
  /**
   * Estado del vínculo con el device (ticket 046). Arranca en `lost` cuando no hay serial:
   * el modo espera ES no tener device, y el dashboard debe decirlo desde el primer frame.
   */
  private connState: ConnectionState
  /**
   * Ventana de gracia en curso (iOS). El token se cancela si el canal vital revive o si
   * alguien cambia de device/app a mano, así una ventana vieja no tira un device nuevo.
   */
  private iosGrace: { cancelled: boolean } | null = null
  /** Segundo muestreador independiente, activado únicamente por la UI dual. */
  private secondary: SecondaryLane = {
    serial: null,
    device: null,
    sampler: null,
    iosSource: null,
    app: null,
    capabilities: capabilitiesFor('android'),
    timer: null,
    iosProcessTimer: null,
    logCapture: null,
    iosLogCapture: null,
    logRing: new LogRing(),
    pendingLogs: [],
    ticking: false,
  }
  /** Serial concreto que B está espejando. El mirror no debe seguir a A si A cambia. */
  private secondaryMirrorSerial: string | null = null

  constructor(private readonly opts: LiveServerOptions) {
    this.serial = opts.serial ?? null
    this.intervalMs = this.resolveIntervalMs()
    this.inspectorEnabled = opts.inspectHttp ?? false
    this.connState = this.serial === null ? 'lost' : 'connected'
  }

  /** Transición de estado del vínculo: sólo avisa al dashboard cuando de verdad cambió. */
  private setConnState(state: ConnectionState): void {
    if (this.connState === state) return
    this.connState = state
    this.server?.broadcast(connectionMessage(state, this.serial))
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
          return this.handleListDevices(url)
        }
        if (url.pathname === '/api/device' && req.method === 'POST') {
          return this.handleSelectDevice(req)
        }
        if (url.pathname === '/api/dual' && req.method === 'POST') {
          return this.handleDualMode(req)
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
          return new Response(body, { headers: staticHeaders(resolved.contentType) })
        } catch {
          // Binario compilado: src/ui no existe en disco — servir el asset embebido.
          const embedded = EMBEDDED_UI[resolved.rel]
          if (!embedded) return new Response('Not found', { status: 404 })
          try {
            const body = readFileSync(embedded)
            return new Response(body, { headers: staticHeaders(resolved.contentType) })
          } catch {
            return new Response('Not found', { status: 404 })
          }
        }
      },
      onOpen: (client: WsClient) => {
        // Al conectar: mandar la ficha del device y la app profileada actual.
        if (this.device) client.send(deviceMessage(this.device, this.capabilities))
        if (this.appStatus) client.send(appMessage(this.appStatus))
        // …y el estado del cable. La ficha de arriba es del ÚLTIMO device conocido: sin
        // esto, un dashboard abierto con el teléfono desenchufado pinta un device fantasma.
        client.send(connectionMessage(this.connState, this.serial))
        // El panel B se inicializa vacío hasta que el usuario el elige. Si ya existe,
        // un iframe abierto tarde recibe su estado completo antes del primer tick.
        if (this.secondary.device) {
          client.send(
            deviceMessage(this.secondary.device, this.secondary.capabilities, 'secondary'),
          )
        }
        if (this.secondary.app) client.send(appMessage(this.secondary.app, 'secondary'))
        client.send(
          connectionMessage(
            this.secondary.serial ? 'connected' : 'lost',
            this.secondary.serial,
            'secondary',
          ),
        )
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
   * Polea las DOS plataformas hasta encontrar un device usable y se engancha (mismo
   * camino que POST /api/device). Corre solo mientras no hay serial activo.
   *
   * Las dos fuentes se consultan a ritmos distintos a propósito. `adb devices` es una
   * llamada al daemon ya corriendo (milisegundos), pero cada consulta de iOS lanza un
   * proceso Python que tarda ~1.2 s: al ritmo de Android tendríamos un intérprete
   * arrancando y muriendo el 60% del tiempo, para un modo espera que puede durar horas.
   * Android se pregunta en cada tick; iOS, cada `iosPollMs`.
   *
   * Que una plataforma falle (adb caído, pymobiledevice3 ausente) nunca impide enganchar
   * un device de la otra: el modo espera es justamente donde el QA todavía no instaló todo.
   */
  private startDeviceWatch(): void {
    const pollMs = this.opts.devicePollMs ?? 2000
    const iosPollMs = this.opts.iosDevicePollMs ?? 6000
    let lastIosPoll = 0
    let lastIosDevices: AdbDevice[] = []
    // ¿Vale la pena preguntarle a iOS? En una máquina Android sin Python, cada consulta es
    // un proceso que arranca sólo para fallar. Se pregunta UNA vez y, si no está el
    // toolchain, el watcher se queda con adb — exactamente el comportamiento de antes.
    let iosUsable: boolean | null = null
    this.deviceWatch = setInterval(() => {
      void (async () => {
        if (this.serial || this.switching) return
        const android = await this.opts.transport.devices().catch(() => [] as AdbDevice[])
        // iOS a su propio ritmo; entre consultas vale la última respuesta conocida.
        const now = Date.now()
        if (iosUsable === null && this.opts.iosTransport?.isAvailable) {
          iosUsable = await this.opts.iosTransport.isAvailable().catch(() => false)
        }
        if (this.opts.iosTransport && iosUsable !== false && now - lastIosPoll >= iosPollMs) {
          lastIosPoll = now
          lastIosDevices = await this.opts.iosTransport.devices().catch(() => [] as AdbDevice[])
        }
        const target = [...android, ...lastIosDevices].find((d) => d.state === 'device')
        if (!target) return
        this.switching = true
        try {
          if (target.platform === 'ios') await this.switchToIosDevice(target)
          else await this.switchDevice(target.serial)
          if (this.deviceWatch) clearInterval(this.deviceWatch)
          this.deviceWatch = null
        } catch {
          this.serial = null // attach fallido (¿lo desenchufaron?): seguir esperando
          lastIosDevices = [] // no reintentar contra una foto vieja del mismo device
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

  /** Los logs de B tienen ring y canal WS propios. No se persisten en la sesión A. */
  private onSecondaryLogEntry(e: LogEntry): void {
    this.secondary.logRing.push(e)
    this.secondary.pendingLogs.push(e)
    if (this.secondary.pendingLogs.length >= LOG_BATCH_MAX) this.flushLogs()
  }

  /** Batch por tick del flush timer: un mensaje WS con N entries + un append NDJSON. */
  private flushLogs(): void {
    if (this.pendingWsLogs.length > 0) {
      this.server?.broadcast(logsMessage(this.pendingWsLogs))
      this.pendingWsLogs = []
    }
    if (this.secondary.pendingLogs.length > 0) {
      this.server?.broadcast(logsMessage(this.secondary.pendingLogs, 'secondary'))
      this.secondary.pendingLogs = []
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
    const ring = paneFromUrl(url) === 'secondary' ? this.secondary.logRing : this.logRing
    return Response.json({ entries: ring.last(n) })
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
      this.pushSample(sample)
    } catch {
      /* un tick que explota no debe matar el loop */
    } finally {
      this.ticking = false
    }
  }

  /**
   * Camino común de un Sample, venga del Sampler de Android o del IosMetricSource
   * (ticket 038): persistir, broadcastear y notificar. Que las dos plataformas pasen por
   * acá es lo que hace que sesiones, reporte y dashboard se reusen sin tocar nada.
   */
  private pushSample(sample: Sample): void {
    // Registrar en el buffer (export en vivo) y en el historial en disco — solo con
    // la app viva. Con el proceso muerto el dashboard sigue en vivo (broadcast),
    // pero no se persisten horas de ticks null: quedan los eventos died/restarted.
    if (this.appStatus && this.serial && !this.appDead) {
      const entry = { sample, pkg: this.appStatus.packageName, serial: this.serial }
      this.buffer.push(entry)
      this.sessionLog?.appendSample(entry)
    }
    this.server?.broadcast(sampleMessage(sample))
    if (this.opts.jsonlPath) {
      try {
        appendFileSync(this.opts.jsonlPath, JSON.stringify(sample) + '\n')
      } catch {
        /* no romper el loop por un fallo de escritura */
      }
    }
    this.opts.onSample?.(sample)
  }

  /** Tick aislado del panel B. No comparte la guarda del panel A: una shell lenta en
   * un teléfono no puede frenar el streaming ni la UI del otro. */
  private async tickSecondary(): Promise<void> {
    const lane = this.secondary
    if (lane.ticking || !lane.sampler) return
    lane.ticking = true
    try {
      await lane.sampler.refreshPid()
      lane.logCapture?.setPid(lane.sampler.processId > 0 ? lane.sampler.processId : null)
      const sample = await lane.sampler.sampleOnce()
      this.server?.broadcast(sampleMessage(sample, 'secondary'))
    } catch {
      /* un device B desconectado no debe afectar el muestreo principal */
    } finally {
      lane.ticking = false
    }
  }

  private stopSecondaryTimer(): void {
    if (this.secondary.timer) clearInterval(this.secondary.timer)
    this.secondary.timer = null
    if (this.secondary.iosProcessTimer) clearInterval(this.secondary.iosProcessTimer)
    this.secondary.iosProcessTimer = null
  }

  /** Libera por completo el segundo device; es idempotente para que apagar el modo
   * dual siempre devuelva exactamente al dashboard normal del device A. */
  private async stopSecondary(): Promise<void> {
    this.stopSecondaryTimer()
    this.secondary.iosSource?.stop()
    this.secondary.iosSource = null
    this.secondary.logCapture?.stop()
    this.secondary.logCapture = null
    this.secondary.iosLogCapture?.stop()
    this.secondary.iosLogCapture = null
    this.secondary.logRing = new LogRing()
    this.secondary.pendingLogs = []
    const sampler = this.secondary.sampler
    this.secondary.sampler = null
    await sampler?.dispose()
    this.secondary.serial = null
    this.secondary.device = null
    this.secondary.app = null
    this.secondary.ticking = false
  }

  /** Inicializa un sampler adicional para Android o una fuente Instruments para iOS. */
  private async startSecondary(
    serial: string,
    packageName = this.appStatus?.packageName ?? this.opts.packageName,
    selectedDevice?: AdbDevice,
  ): Promise<{ device: DeviceInfo; app: AppStatus }> {
    if (serial === this.serial) throw new Error('el dispositivo B debe ser distinto del A')
    const pkg = packageName
    const target = selectedDevice ?? (await this.resolveConnectedDevice(serial))
    if (!target) throw new Error('device no conectado')
    if (target.state !== 'device') throw new Error(`device en estado "${target.state}"`)

    // Resolver y validar ANTES de liberar B: un discovery lento/fallido no debe dejar el
    // panel vacío ni cortar sus streams actuales.
    await this.stopSecondary()
    const iosDevice = target.platform === 'ios' ? target : null

    this.secondary.serial = serial
    if (iosDevice) {
      this.secondary.capabilities = capabilitiesFor('ios')
      this.secondary.device = iosDeviceInfo(iosDevice)
      const executable =
        (await this.opts.iosTransport?.appExecutable?.(serial, pkg).catch(() => null)) ?? null
      const processes = (await this.opts.iosTransport?.processes?.(serial).catch(() => null)) ?? []
      const proc = resolveIosProcess(processes, pkg, executable)
      this.secondary.app = { packageName: pkg, pid: proc?.pid ?? null, launched: false }
      this.secondary.iosSource = new IosMetricSource({
        transport: { stream: this.opts.iosTransport!.stream!.bind(this.opts.iosTransport) },
        serial,
        ...(proc ? { processName: proc.name } : {}),
        intervalMs: this.intervalMs,
        onSample: (sample) => this.server?.broadcast(sampleMessage(sample, 'secondary')),
        ...(this.opts.iosStaleMs !== undefined ? { staleMs: this.opts.iosStaleMs } : {}),
      })
      this.secondary.iosSource.start()
      if (this.opts.iosTransport?.stream) {
        this.secondary.iosLogCapture = new IosLogCapture({
          transport: { stream: this.opts.iosTransport.stream.bind(this.opts.iosTransport) },
          serial,
          pid: proc?.pid ?? null,
          processName: proc?.name ?? executable,
          onEntries: (entries) => {
            for (const entry of entries) this.onSecondaryLogEntry(entry)
          },
        })
        this.secondary.iosLogCapture.start()
      }
      // iOS no tiene equivalente a monkey: si la app B se abre después, enganchar el
      // proceso sin recrear Instruments ni bloquear el panel A.
      this.secondary.iosProcessTimer = setInterval(() => {
        const lane = this.secondary
        if (!lane.serial || lane.serial !== serial || !lane.iosSource || !lane.app) return
        void this.opts.iosTransport
          ?.processes(serial)
          .then((processes) => {
            if (
              this.secondary.serial !== serial ||
              !this.secondary.iosSource ||
              !this.secondary.app
            )
              return
            const current = resolveIosProcess(
              processes ?? [],
              this.secondary.app.packageName,
              executable,
            )
            this.secondary.iosSource.setProcessName(current?.name ?? '')
            this.secondary.iosLogCapture?.setPid(current?.pid ?? null)
            if (this.secondary.app.pid !== (current?.pid ?? null)) {
              this.secondary.app = { ...this.secondary.app, pid: current?.pid ?? null }
              this.server?.broadcast(appMessage(this.secondary.app, 'secondary'))
            }
          })
          .catch(() => {})
      }, this.opts.iosProcessPollMs ?? 5000)
      // La RAM total llega aparte: no bloquear el primer frame de B por una consulta lenta.
      void this.opts.iosTransport?.systemInfo?.(serial).then((sys) => {
        if (this.secondary.serial !== serial || !this.secondary.device) return
        this.secondary.device = {
          ...this.secondary.device,
          ramTotalMb: sys.ramTotalMb,
          cores: sys.cores,
        }
        this.server?.broadcast(
          deviceMessage(this.secondary.device, this.secondary.capabilities, 'secondary'),
        )
      })
    } else {
      this.secondary.capabilities = capabilitiesFor('android')
      this.secondary.device = await captureDeviceInfo(this.opts.transport, serial)
      const pid = await resolvePid(this.opts.transport, serial, pkg)
      const sampler = new Sampler(this.opts.transport, serial, pkg, pid ?? 0, {
        refreshHz: this.secondary.device.refreshHz ?? null,
      })
      await sampler.init()
      this.secondary.sampler = sampler
      this.secondary.app = { packageName: pkg, pid, launched: false }
      this.secondary.logCapture = new LogcatCapture(this.opts.transport, serial, pkg, (entry) =>
        this.onSecondaryLogEntry(entry),
      )
      this.secondary.logCapture.start(pid)
      this.secondary.timer = setInterval(() => void this.tickSecondary(), this.intervalMs)
      void this.tickSecondary()
    }
    this.server?.broadcast(
      deviceMessage(this.secondary.device, this.secondary.capabilities, 'secondary'),
    )
    this.server?.broadcast(appMessage(this.secondary.app, 'secondary'))
    this.server?.broadcast(connectionMessage('connected', serial, 'secondary'))
    return { device: this.secondary.device, app: this.secondary.app }
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

  /**
   * GET /api/packages[?system=1] — instaladas + ranking de uso + término del chip.
   *
   * Rutea por plataforma: con un iPhone enganchado, `pm list packages` se ejecutaba por
   * adb contra un serial que adb no conoce, fallaba y devolvía lista vacía — el selector
   * quedaba mudo y, sin app elegida, el canal de sysmon por proceso nunca se enganchaba,
   * así que CPU y memoria de la app salían null. Las apps de iOS salen por lockdown.
   */
  private async handleListPackages(url: URL): Promise<Response> {
    const pane = paneFromUrl(url)
    const includeSystem = url.searchParams.get('system') === '1'
    let installed: string[] = []
    const lane = pane === 'secondary' ? this.secondary : null
    const serial = lane ? lane.serial : this.serial
    const device = lane ? lane.device : this.device
    const app = lane ? lane.app : this.appStatus
    if (serial) {
      installed =
        device?.platform === 'ios'
          ? ((await this.opts.iosTransport?.apps(serial, { includeSystem })) ?? []).map((a) => a.id)
          : await listPackages(this.opts.transport, serial, { includeSystem })
    }
    const store = this.opts.appStore?.data ?? defaultAppStoreData()
    const body = {
      packages: rankPackages(installed, store.usage),
      usage: store.usage,
      filterTerm: store.filterTerm,
      current: app?.packageName ?? this.opts.packageName,
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
    let body: { package?: unknown; pane?: unknown }
    try {
      body = (await req.json()) as { package?: unknown; pane?: unknown }
    } catch {
      return Response.json({ error: 'body inválido' }, { status: 400 })
    }
    // Input hostil: en Android viaja interpolado a `adb shell` (pidof/monkey/dumpsys), así
    // que la validación es estricta. En iOS la forma es otra — los bundle ids admiten
    // guiones (`LB-Software.PhotoEraser`) y el validador de Android los rechazaba con 400,
    // dejando esas apps imposibles de elegir desde el dashboard.
    const pkg = body.package
    const pane: DashboardPane = body.pane === 'secondary' ? 'secondary' : 'primary'
    if (typeof pkg !== 'string') {
      return Response.json({ error: 'package inválido' }, { status: 400 })
    }
    const appId: string = pkg
    const targetDevice = pane === 'secondary' ? this.secondary.device : this.device
    const validId =
      targetDevice?.platform === 'ios' ? isValidBundleId(appId) : isValidPackageName(appId)
    if (!validId) {
      return Response.json({ error: 'package inválido' }, { status: 400 })
    }
    const targetSerial = pane === 'secondary' ? this.secondary.serial : this.serial
    if (!targetSerial) {
      return Response.json({ error: 'sin device conectado' }, { status: 409 })
    }
    if (this.switching) {
      return Response.json({ error: 'switch en curso' }, { status: 409 })
    }
    this.switching = true
    try {
      if (pane === 'secondary') {
        const result = await this.startSecondary(targetSerial, appId)
        return Response.json({ ok: true, ...result })
      }
      const status = await this.switchApp(appId)
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
    // Un iPhone no entiende nada de lo que sigue (pidof, monkey, Sampler sobre adb): tiene
    // su propio camino. Sin esto, elegir una app en iOS devolvía 200 con pid null y
    // launched true — el dashboard mostraba la app elegida pero el canal de sysmon seguía
    // apuntando a la anterior, así que CPU y memoria nunca cambiaban.
    if (this.device?.platform === 'ios') return this.switchIosApp(pkg, recordUsage)
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

  /**
   * Cambia la app profileada en un iPhone. Gemelo de `switchApp` para iOS.
   *
   * Diferencias con Android que justifican un camino propio:
   *  - No hay `pidof`: el proceso se resuelve contra la lista real del device.
   *  - No se LANZA la app. En Android `monkey` la abre sin conocer la activity; el
   *    equivalente iOS (`ProcessControl.launch` por DVT) exige levantar el túnel — decenas
   *    de segundos — para algo que el QA hace con un toque en el teléfono. Si la app está
   *    cerrada se engancha igual y el watch la toma cuando aparezca.
   *  - El nombre del proceso sale del CFBundleExecutable, no de adivinar sobre el bundle id.
   */
  private async switchIosApp(pkg: string, recordUsage: boolean): Promise<AppStatus> {
    const serial = this.serial
    const transport = this.opts.iosTransport
    if (!serial) throw new Error('switchIosApp sin device activo')

    // El ejecutable se resuelve UNA vez por app y queda cacheado: el watch de procesos
    // corre cada 5 s y no puede pagar un `apps query` en cada vuelta.
    this.iosExecutable = (await transport?.appExecutable?.(serial, pkg).catch(() => null)) ?? null
    // `null` (no se pudo preguntar) y `[]` (no está corriendo) coinciden acá: en ambos casos
    // la app queda sin proceso enganchado y el watch la toma cuando aparezca.
    const processes = (await transport?.processes?.(serial).catch(() => null)) ?? []
    const proc = resolveIosProcess(processes, pkg, this.iosExecutable)

    this.appStatus = { packageName: pkg, pid: proc?.pid ?? null, launched: false }
    this.appDead = proc === null
    this.deadTicks = 0
    if (recordUsage) this.opts.appStore?.select(pkg)

    // Re-apuntar los canales vivos en vez de recrear la fuente: el stream de graphics es
    // del device (no cambia con la app) y volver a levantarlo costaría el handshake.
    if (proc !== null) this.iosSource?.setProcessName(proc.name)

    // El syslog SÍ se re-arma: su `--process-name` filtra EN EL DEVICE y quedó fijado con
    // la app anterior. Sólo cambiar el pid del lado del host dejaba el panel de logs vacío
    // — el teléfono seguía mandando (o filtrando) las líneas de la app de antes.
    if (transport?.stream) {
      this.iosLogCapture?.stop()
      this.iosLogCapture = new IosLogCapture({
        transport: { stream: transport.stream.bind(transport) },
        serial,
        pid: proc?.pid ?? null,
        processName: proc?.name ?? null,
        onEntries: (entries) => {
          for (const e of entries) this.onLogEntry(e)
        },
      })
      this.iosLogCapture.start()
    }

    const ev = { ts: Date.now(), kind: 'app' as const, pkg, serial }
    this.buffer.addEvent(ev)
    this.sessionLog?.appendEvent(ev)
    this.server?.broadcast(appMessage(this.appStatus))
    return this.appStatus
  }

  /**
   * GET /api/devices — lista unificada Android + iOS (ticket 035).
   *
   * Las dos fuentes son independientes y se consultan en paralelo: que falte
   * `pymobiledevice3`, o que adb esté caído, nunca puede vaciar la lista de la otra
   * plataforma. Los iOS llegan con `platform: 'ios'`; los de adb no traen el campo y la
   * UI los asume Android.
   */
  private refreshDeviceList(): Promise<AdbDevice[]> {
    if (this.deviceListRefresh) return this.deviceListRefresh
    const cached = this.deviceListCache?.devices ?? this.knownDevices()
    const cachedAndroid = cached.filter((device) => device.platform !== 'ios')
    const cachedIos = cached.filter((device) => device.platform === 'ios')
    const refresh = Promise.all([
      this.opts.transport.devices().catch(() => cachedAndroid),
      this.opts.iosTransport?.devices().catch(() => cachedIos) ?? Promise.resolve([]),
    ])
      .then(([android, ios]) => {
        const devices = [...android, ...ios]
        this.deviceListCache = { devices, updatedAt: Date.now() }
        return devices
      })
      .finally(() => {
        if (this.deviceListRefresh === refresh) this.deviceListRefresh = null
      })
    this.deviceListRefresh = refresh
    return refresh
  }

  /** Fichas ya conocidas: permiten abrir el selector inmediatamente mientras discovery
   * actualiza la lista completa en background. */
  private knownDevices(): AdbDevice[] {
    const known = [this.device, this.secondary.device].filter(
      (device): device is DeviceInfo => device !== null,
    )
    return known
      .filter(
        (device, index) => known.findIndex((other) => other.serial === device.serial) === index,
      )
      .map((device) => ({
        serial: device.serial,
        state: 'device',
        description:
          `model:${(device.model ?? device.serial).replace(/\s+/g, '_')}` +
          (device.platform === 'ios' && device.androidRelease
            ? ` ios:${device.androidRelease}`
            : ''),
        ...(device.platform ? { platform: device.platform } : {}),
      }))
  }

  /** Resuelve un serial desde el snapshot que la UI acaba de mostrar. Sólo si es un
   * serial desconocido paga discovery; así seleccionar un item visible nunca vuelve a
   * lanzar adb + usbmux ni queda detrás de una búsqueda lenta en background. */
  private async resolveConnectedDevice(serial: string): Promise<AdbDevice | null> {
    const snapshot = [...(this.deviceListCache?.devices ?? []), ...this.knownDevices()]
    const cached = snapshot.find((device) => device.serial === serial)
    if (cached) return cached
    const refreshed = await this.refreshDeviceList()
    return refreshed.find((device) => device.serial === serial) ?? null
  }

  private async handleListDevices(url: URL): Promise<Response> {
    const force = url.searchParams.get('refresh') === '1'
    const cacheFresh =
      this.deviceListCache !== null && Date.now() - this.deviceListCache.updatedAt < 3000
    let devices: AdbDevice[]
    if (force) {
      void this.refreshDeviceList()
      devices = this.deviceListCache?.devices ?? this.knownDevices()
    } else if (cacheFresh) {
      devices = this.deviceListCache!.devices
    } else {
      void this.refreshDeviceList()
      devices = this.deviceListCache?.devices ?? this.knownDevices()
    }
    return Response.json({
      devices,
      current: this.serial,
      secondary: this.secondary.serial,
      refreshing: this.deviceListRefresh !== null,
    })
  }

  /** POST /api/dual {enabled}. Desactivarlo corta y libera B antes de que la UI oculte
   * su panel, evitando timers/streams huérfanos. */
  private async handleDualMode(req: Request): Promise<Response> {
    const origin = req.headers.get('origin')
    if (origin !== null && !isLocalOrigin(origin))
      return new Response('Forbidden origin', { status: 403 })
    let enabled: unknown
    try {
      enabled = ((await req.json()) as { enabled?: unknown }).enabled
    } catch {
      return Response.json({ error: 'body inválido' }, { status: 400 })
    }
    if (typeof enabled !== 'boolean')
      return Response.json({ error: 'enabled debe ser boolean' }, { status: 400 })
    if (!enabled) {
      await this.stopSecondary()
      this.secondaryMirrorSerial = null
      this.server?.broadcast(connectionMessage('lost', null, 'secondary'))
    }
    return Response.json({ ok: true, enabled, secondary: this.secondary.serial })
  }

  /** POST /api/device {"serial": "..."} — cambia el device profileado en caliente. */
  private async handleSelectDevice(req: Request): Promise<Response> {
    const origin = req.headers.get('origin')
    if (origin !== null && !isLocalOrigin(origin)) {
      return new Response('Forbidden origin', { status: 403 })
    }
    let body: { serial?: unknown; pane?: unknown }
    try {
      body = (await req.json()) as { serial?: unknown; pane?: unknown }
    } catch {
      return Response.json({ error: 'body inválido' }, { status: 400 })
    }
    // Se valida contra el snapshot producido por discovery: sólo un serial observado y
    // autorizado es elegible, sin volver a pagar adb + usbmux al hacer clic.
    const serial = body.serial
    const pane: DashboardPane = body.pane === 'secondary' ? 'secondary' : 'primary'
    if (typeof serial !== 'string' || !serial) {
      return Response.json({ error: 'serial inválido' }, { status: 400 })
    }
    if (this.switching) {
      return Response.json({ error: 'switch en curso' }, { status: 409 })
    }
    this.switching = true
    try {
      if (pane === 'secondary') {
        // QA mirror: B puede apuntar al mismo device que A, pero nunca abrimos un segundo
        // sampler/stream contra el teléfono. La UI recarga B leyendo el carril primario.
        if (serial === this.serial) {
          await this.stopSecondary()
          this.secondaryMirrorSerial = serial
          return Response.json({
            ok: true,
            mirror: true,
            device: this.device,
            app: this.appStatus,
          })
        }
        if (serial === this.secondary.serial) {
          return Response.json({ ok: true, device: this.secondary.device, app: this.secondary.app })
        }
        const target = await this.resolveConnectedDevice(serial)
        if (!target) return Response.json({ error: 'device no conectado' }, { status: 404 })
        if (target.state !== 'device') {
          return Response.json({ error: `device en estado "${target.state}"` }, { status: 409 })
        }
        const result = await this.startSecondary(serial, undefined, target)
        this.secondaryMirrorSerial = null
        return Response.json({ ok: true, ...result })
      }
      if (serial === this.serial) {
        return Response.json({ ok: true, device: this.device, app: this.appStatus })
      }
      const mirroredSerial =
        this.secondaryMirrorSerial === this.serial ? this.secondaryMirrorSerial : null
      const mirroredPackage = this.appStatus?.packageName ?? this.opts.packageName
      const mirroredDevice = mirroredSerial
        ? this.knownDevices().find((device) => device.serial === mirroredSerial)
        : undefined
      const target = await this.resolveConnectedDevice(serial)
      if (!target) return Response.json({ error: 'device no conectado' }, { status: 404 })
      if (target.state !== 'device') {
        return Response.json({ error: `device en estado "${target.state}"` }, { status: 409 })
      }
      const mirrorSecondary = serial === this.secondary.serial
      if (mirrorSecondary) {
        await this.stopSecondary()
        this.secondaryMirrorSerial = serial
      }
      const result =
        target.platform === 'ios'
          ? await this.switchToIosDevice(target)
          : await this.switchDevice(serial)
      let detachSecondaryMirror = false
      if (mirroredSerial && mirroredDevice) {
        // B estaba espejando el device anterior de A. Al mover A, conservar ese device
        // como B independiente en vez de hacer que el mirror siga al nuevo A.
        this.secondaryMirrorSerial = null
        detachSecondaryMirror = true
        try {
          await this.startSecondary(mirroredSerial, mirroredPackage, mirroredDevice)
        } catch {
          // El switch de A ya terminó y no debe revertirse porque el device anterior se
          // haya desconectado. B vuelve igual a modo independiente, mostrando espera.
          await this.stopSecondary()
        }
      }
      return Response.json({ ok: true, mirrorSecondary, detachSecondaryMirror, ...result })
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
  /**
   * Engancha un iPhone (tickets 035/038).
   *
   * Corta todo lo de Android — Sampler, logcat, inspector — y arranca el
   * `IosMetricSource`, que emite los MISMOS `Sample` por el mismo camino
   * (`pushSample`), así sesiones, reporte y dashboard se reusan sin tocar nada.
   *
   * El nombre del proceso NO se adivina desde el bundle id: se resuelve contra la lista
   * real de procesos del device (ver `resolveIosProcess`). Si la app está cerrada, el
   * device igual se engancha y las métricas de proceso quedan null hasta que se abra —
   * mismo comportamiento que Android con la app muerta.
   */
  private async switchToIosDevice(
    device: AdbDevice,
  ): Promise<{ device: DeviceInfo; app: AppStatus }> {
    const pkg = this.appStatus?.packageName ?? this.opts.packageName
    if (this.inspector) await this.stopInspector()
    this.logCapture?.stop()
    this.logCapture = null
    const oldSampler = this.sampler
    this.sampler = null
    await oldSampler?.dispose()
    this.teardownIos()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    this.serial = device.serial
    this.capabilities = capabilitiesFor('ios')
    // --inspect pudo haber quedado prendido de un device Android anterior: en iOS la
    // intención se descarta, no queda "pendiente" esperando volver a Android.
    this.inspectorEnabled = false
    this.device = iosDeviceInfo(device)
    this.server?.broadcast(deviceMessage(this.device, this.capabilities))

    // RAM total del device: sin ella las barras de memoria no tienen denominador. Se pide
    // una sola vez (no cambia) y en paralelo, para no demorar el enganche del dashboard.
    void this.opts.iosTransport
      ?.systemInfo?.(device.serial)
      .then((sys) => {
        if (this.device === null || this.device.serial !== device.serial) return
        this.device = { ...this.device, ramTotalMb: sys.ramTotalMb, cores: sys.cores }
        this.applyInterval()
        this.server?.broadcast(deviceMessage(this.device, this.capabilities))
        this.sessionLog?.appendDevice(this.device)
      })
      .catch(() => {
        /* sin RAM total el dashboard degrada a valores absolutos, no rompe */
      })

    const transport = this.opts.iosTransport
    // Ejecutable primero: es lo que hace que el proceso se encuentre de verdad (el bundle
    // id solo no alcanza — `com.github.stormbreaker.prod` corre como `GitHub`).
    this.iosExecutable =
      (await transport?.appExecutable?.(device.serial, pkg).catch(() => null)) ?? null
    // acá `null` (no se pudo preguntar) y `[]` (la app no corre) llevan al mismo lado: sin
    // proceso enganchado. La distinción importa en el watch, que es quien declara muertes.
    const processes = (await transport?.processes?.(device.serial).catch(() => null)) ?? []
    const proc = resolveIosProcess(processes, pkg, this.iosExecutable)
    this.appStatus = { packageName: pkg, pid: proc?.pid ?? null, launched: false }
    this.appDead = proc === null
    this.server?.broadcast(appMessage(this.appStatus))

    const ev = { ts: Date.now(), kind: 'device' as const, pkg, serial: device.serial }
    this.buffer.addEvent(ev)
    this.sessionLog?.appendEvent(ev)
    this.sessionLog?.appendDevice(this.device)

    if (transport?.stream) {
      // Arranca SIEMPRE, con la app abierta o cerrada: FPS y GPU son del compositor del
      // device, no del proceso. Con la app cerrada el dashboard sigue vivo y las métricas
      // de proceso quedan null — igual que Android con el proceso muerto.
      this.iosSource = new IosMetricSource({
        transport: { stream: transport.stream.bind(transport) },
        serial: device.serial,
        ...(proc !== null ? { processName: proc.name } : {}),
        intervalMs: this.intervalMs,
        onSample: (sample) => this.pushSample(sample),
        ...(this.opts.iosStaleMs !== undefined ? { staleMs: this.opts.iosStaleMs } : {}),
        // graphics es el canal vital: FPS y GPU son la razón de ser del profiler. Si se
        // cae, no se degrada — se abre la ventana de gracia y, si no vuelve, se rehace el
        // enganche entero (decisión del grilling 2026-08-13).
        onVitalDown: () => this.startIosGrace(),
        onVitalUp: () => this.cancelIosGrace(true),
      })
      this.iosSource.start()
      // Los logs entran al mismo ring y panel que los de logcat: el LogEntry del ticket
      // 027 nació genérico justamente para esto.
      this.iosLogCapture = new IosLogCapture({
        transport: { stream: transport.stream.bind(transport) },
        serial: device.serial,
        pid: proc?.pid ?? null,
        processName: proc?.name ?? null,
        onEntries: (entries) => {
          for (const e of entries) this.onLogEntry(e)
        },
      })
      this.iosLogCapture.start()
      this.startIosProcessWatch()
    }
    this.setConnState('connected')
    return { device: this.device, app: this.appStatus }
  }

  /**
   * Equivalente iOS de `refreshPid()`: poléa la lista de procesos y engancha el canal de
   * sysmon cuando la app aparece (o cambia de pid). Va en su propio timer y no en el tick
   * porque `processes ps` es un comando lockdown completo — no algo que se pague a 1 Hz.
   */
  private startIosProcessWatch(): void {
    if (this.iosProcessWatch) clearInterval(this.iosProcessWatch)
    const poll = async (): Promise<void> => {
      const transport = this.opts.iosTransport
      const serial = this.serial
      const source = this.iosSource
      if (!transport?.processes || !serial || !source) return
      const pkg = this.appStatus?.packageName ?? this.opts.packageName
      const processes = await transport.processes(serial).catch(() => null)
      // `processes ps` tarda hasta 30 s: en ese hueco el device se pudo perder y el
      // teardown ya soltó la fuente. Verificado contra el iPhone real — matar el canal
      // vital tiraba el server entero con "null is not an object" y por eso NADA
      // reconectaba. Chequear antes del await no alcanza: hay que revalidar después.
      if (this.iosSource !== source || this.serial !== serial) return
      // `null` = no pudimos preguntar (device desenchufado, lockdown caído). Antes esto
      // caía a `[]` y a los 3 polls declaraba muerta a la app: cada desconexión dejaba un
      // `app-died` falso en el historial. `trackAppLife(null)` ya sabe no concluir nada.
      if (processes === null) {
        this.trackAppLife(null)
        return
      }
      const proc = resolveIosProcess(processes, pkg, this.iosExecutable)
      this.trackAppLife(proc !== null)
      if (proc === null) return
      source.setProcessName(proc.name)
      // filtrar por pid del lado del host: cambiar de pid es asignar una variable, no
      // relanzar el stream (que en iOS costaría el handshake del túnel entero)
      this.iosLogCapture?.setPid(proc.pid)
      if (this.appStatus && this.appStatus.pid !== proc.pid) {
        this.appStatus = { ...this.appStatus, pid: proc.pid }
        this.server?.broadcast(appMessage(this.appStatus))
      }
    }
    // `.catch` obligatorio: el CLI mata el proceso ante un unhandledRejection, así que una
    // excepción en el watch no debe poder tumbar el server (nos pasó, ver arriba).
    this.iosProcessWatch = setInterval(
      () => void poll().catch(() => {}),
      this.opts.iosProcessPollMs ?? 5000,
    )
  }

  /**
   * El canal vital (graphics) se cayó: ventana de gracia antes de soltar el device
   * (ticket 046).
   *
   * No se destruye nada todavía — un microcorte del túnel costaría el teardown más un
   * handshake de decenas de segundos para volver. Mientras corre la ventana, los valores
   * del canal ya salen null por su TTL, así que el dashboard no muestra nada viejo.
   *
   * El árbitro (`usbmux list`) se sondea EN SECUENCIA porque cada sonda es un proceso
   * Python de ~1,2 s. Su aporte es cortar la espera cuando el device efectivamente se fue:
   * si sigue en el bus, se agota la ventana igual, porque sin graphics no hay sesión.
   */
  private startIosGrace(): void {
    if (this.iosGrace) return
    const token = { cancelled: false }
    this.iosGrace = token
    this.setConnState('reconnecting')
    const deadline = Date.now() + (this.opts.iosGraceMs ?? 3000)
    void (async () => {
      while (!token.cancelled && Date.now() < deadline) {
        const devices = (await this.opts.iosTransport?.devices().catch(() => [])) ?? []
        if (token.cancelled) return
        const present = devices.some((d) => d.serial === this.serial && d.state === 'device')
        if (!present) break // el device no está: no hay nada que esperar
        // respiro entre sondas: contra el device real cada una ya tarda ~1,2 s, pero un
        // transporte instantáneo (tests) haría girar este loop sin freno
        await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))))
      }
      if (token.cancelled) return
      this.iosGrace = null
      this.loseIosDevice()
    })().catch(() => {
      // mismo motivo que el watch de procesos: un throw acá llegaría a unhandledRejection
      // y el CLI baja el server — justo cuando lo que hace falta es que siga para reconectar
      this.iosGrace = null
    })
  }

  /** Cancela la ventana en curso (el canal volvió, o el usuario cambió de device/app). */
  private cancelIosGrace(recovered: boolean): void {
    if (this.iosGrace) this.iosGrace.cancelled = true
    this.iosGrace = null
    if (recovered) this.setConnState('connected')
  }

  /**
   * Se acabó la gracia: soltar el iPhone y volver al modo espera.
   *
   * El re-enganche NO tiene camino propio — se revive `startDeviceWatch()`, que engancha
   * por el mismo `switchToIosDevice` del arranque. Con el device suelto no hay timer de
   * sampling ni streams vivos, así que el dashboard deja de recibir samples: el hueco es
   * real, no una fila de valores viejos.
   */
  private loseIosDevice(): void {
    this.teardownIos()
    this.serial = null
    this.iosExecutable = null
    this.appDead = true
    if (this.appStatus && this.appStatus.pid !== null) {
      this.appStatus = { ...this.appStatus, pid: null }
      this.server?.broadcast(appMessage(this.appStatus))
    }
    this.setConnState('lost')
    if (!this.deviceWatch) this.startDeviceWatch()
  }

  /** Corta los cuatro procesos pmd3 y el watch de procesos. Idempotente. */
  private teardownIos(): void {
    this.cancelIosGrace(false)
    this.iosSource?.stop()
    this.iosSource = null
    this.iosLogCapture?.stop()
    this.iosLogCapture = null
    if (this.iosProcessWatch) clearInterval(this.iosProcessWatch)
    this.iosProcessWatch = null
  }

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

    // volver a Android desde un iPhone: cortar la fuente iOS y restaurar el loop propio
    this.teardownIos()
    this.capabilities = capabilitiesFor('android')
    if (!this.timer) this.startTimer()

    this.serial = serial
    this.device = await captureDeviceInfo(this.opts.transport, serial)
    this.applyInterval() // la RAM del device nuevo puede cambiar el intervalo auto
    this.server?.broadcast(deviceMessage(this.device, this.capabilities))
    const ev = { ts: Date.now(), kind: 'device' as const, pkg, serial }
    this.buffer.addEvent(ev)
    this.sessionLog?.appendEvent(ev)
    this.sessionLog?.appendDevice(this.device)
    // en modo espera con el inspector prendido nunca llegó a arrancar: acá se cablea
    if (this.inspectorEnabled) await this.startInspector()
    const app = await this.switchApp(pkg, false)
    this.setConnState('connected')
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
    // Guarda del lado del SERVER, no sólo de la UI: en iOS el inspector no se puede
    // ofrecer. En Android la tool setea el proxy del device sola
    // (`settings put global http_proxy`) y lo restaura al salir; iOS no tiene ese
    // equivalente — hay que configurar el proxy de la Wi-Fi a mano y confiar la CA en
    // Ajustes. Un toggle que promete algo que no puede cumplir es peor que no estar.
    if (!this.capabilities.httpInspector) {
      return Response.json(
        {
          error:
            'el inspector HTTP no está disponible en iOS: el proxy del device y la confianza de la CA se configuran a mano en Ajustes',
          platform: this.device?.platform ?? 'ios',
        },
        { status: 501 },
      )
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
    // Sin esto quedan procesos de pymobiledevice3 huérfanos con su túnel abierto: el
    // dashboard se cierra y el iPhone sigue con dos sesiones de Instruments colgadas.
    // Cancela además la ventana de gracia, que si no seguiría sondeando después del cierre.
    this.teardownIos()
    this.deviceWatch = null
    if (this.logFlushTimer) clearInterval(this.logFlushTimer)
    this.logFlushTimer = null
    this.logCapture?.stop()
    this.logCapture = null
    await this.stopSecondary()
    this.flushLogs() // lo pendiente va a disco antes de cerrar
    if (this.inspector) await this.stopInspector() // restaura el proxy del device
    await this.sampler?.dispose() // sin await, el -disable de timestats muere a mitad de vuelo
    this.server?.stop()
    this.timer = null
    this.server = null
  }
}
