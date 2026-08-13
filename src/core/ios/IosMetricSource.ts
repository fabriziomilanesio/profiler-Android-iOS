// Fuente de métricas iOS (tickets 035/038): produce los mismos `Sample` que el Sampler de
// Android, y de ahí para arriba TODO se reusa sin tocar — sesiones, veredicto, reporte,
// server y UI.
//
// Por qué no reusa el `Sampler`: el de Android es un loop que ejecuta comandos por tick en
// dos carriles, un diseño que existe porque `dumpsys meminfo` contiende con el proceso del
// juego en gama baja (ticket 023). iOS no funciona así — son SUSCRIPCIONES que empujan
// datos. Acá los streams se abren una vez y el tick sólo lee el último valor conocido.
//
// Los streams son largos a propósito: el spike 033 midió que levantar el túnel userspace
// tarda decenas de segundos. Abrir un proceso por tick sería pagar ese handshake cada vez.
import type { Sample } from '../schema'
import type { IosTransport } from './IosTransport'
import { ResilientStream } from './resilientStream'
import { parseGraphicsLine, type IosGraphicsSample } from './parseGraphics'
import { SysmonAssembler, type IosProcessSample } from './parseSysmon'
import { parseBatteryLine } from './parseBattery'
import type { BatterySample } from '../schema'

export interface IosMetricSourceOptions {
  transport: Pick<IosTransport, 'stream'>
  /** UDID del device. Va por env en cada comando: con varios devices, pymobiledevice3 aborta. */
  serial: string
  /**
   * Nombre de PROCESO de la app (iOS 26 no expone bundleIdentifier en sysmontap).
   * Puede faltar: con la app cerrada el canal de gráficos —que es del DEVICE, no de la
   * app— igual funciona, y el de proceso se engancha después con `setProcessName`.
   */
  processName?: string
  onSample: (s: Sample) => void
  /** ms entre Samples emitidos (default 1000, igual que Android). */
  intervalMs?: number
  /**
   * Ventana de frescura por canal (ticket 046): un valor más viejo que esto sale `null` en
   * el Sample en vez de repetirse. Default 3000 ms = 3× la cadencia de graphics (1 Hz).
   */
  staleMs?: number
  /**
   * El canal VITAL (graphics) se cayó: o murió su hijo, o dejó de entregar hace `staleMs`.
   * El server lo usa para arrancar la ventana de gracia y, si no vuelve, rehacer el
   * enganche entero. FPS y GPU son la razón de ser del profiler: sin ese canal no hay
   * sesión que valga, así que no se degrada en silencio como los otros.
   */
  onVitalDown?: () => void
  /** El canal vital volvió a entregar (cancela la ventana de gracia del server). */
  onVitalUp?: () => void
  /** clock inyectable (tests); default Date.now. */
  now?: () => number
  /** escalera de reintento del canal de batería (los tests la bajan a milisegundos). */
  backoffMs?: number[]
}

/**
 * Último valor recibido por un canal, con el instante en que llegó.
 *
 * El timestamp es la mitad importante: sin él, un canal mudo (túnel degradado, hijo vivo
 * que dejó de escribir) seguía repitiendo su último valor con un `ts` fresco cada segundo
 * — dato viejo disfrazado de medición nueva, que además se persistía y llegaba al reporte.
 */
interface Fresh<T> {
  value: T
  at: number
}

/**
 * Últimos valores recibidos por cada canal. El tick los combina en un `Sample`.
 *
 * Se guarda el último valor en vez de promediar la ventana porque los dos canales emiten a
 * ritmos distintos (graphics ~1 Hz, sysmon ~1,5 Hz) y desalineados: promediar exigiría
 * ventanas por canal y no aporta nada a 1 Hz.
 */
interface LastValues {
  graphics: Fresh<IosGraphicsSample> | null
  process: Fresh<IosProcessSample> | null
  battery: Fresh<BatterySample> | null
}

/** ms de frescura por defecto: 3× la cadencia de graphics (1 Hz). */
export const DEFAULT_STALE_MS = 3000

export class IosMetricSource {
  private stopGraphics: (() => void) | null = null
  private stopSysmon: (() => void) | null = null
  /** canal de batería, con reintento propio (lockdown: reponerlo es barato). */
  private battery: ResilientStream | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly assembler = new SysmonAssembler()
  private readonly last: LastValues = { graphics: null, process: null, battery: null }
  private processName: string | null = null
  private t = 0
  private readonly staleMs: number
  private readonly now: () => number
  /** el canal vital ya se dio por caído (no volver a avisar hasta que reviva). */
  private vitalDown = false
  /** el hijo de sysmon sigue vivo; si murió hay que re-armar aunque el nombre no cambie. */
  private sysmonAlive = false
  /** stop() ya corrió: los onExit que provoca son esperados, no una caída. */
  private stopped = false
  /** generación del stream de sysmon: el onExit del hijo viejo no habla por el nuevo. */
  private sysmonGen = 0

  constructor(private readonly opts: IosMetricSourceOptions) {
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS
    this.now = opts.now ?? Date.now
  }

  start(): void {
    const { transport, serial } = this.opts

    // Canal de gráficos: FPS y GPU son del compositor del device, no del proceso. Arranca
    // siempre, incluso con la app cerrada — igual que el dashboard de Android sigue
    // tickeando con el proceso muerto.
    this.stopGraphics = transport.stream(
      serial,
      ['developer', 'dvt', 'graphics'],
      (line) => {
        const s = parseGraphicsLine(line)
        if (s === null) return
        this.last.graphics = { value: s, at: this.now() }
        this.markVitalUp()
      },
      // Hijo muerto: no vuelve solo y no hay TTL que esperar — el server se entera ya.
      () => this.markVitalDown(),
    )

    // Batería: canal LOCKDOWN, no DTX — no depende del túnel ni del proceso de la app,
    // así que arranca siempre y es de los más baratos del stack. Y por lo mismo se repone
    // solo: verificado contra el iPhone real, matar su proceso dejaba la temperatura en N/A
    // hasta el próximo enganche del device, y la temperatura es lo único térmico que iOS da.
    this.battery = new ResilientStream({
      ...(this.opts.backoffMs !== undefined ? { backoffMs: this.opts.backoffMs } : {}),
      start: (onExit) =>
        transport.stream(
          serial,
          ['diagnostics', 'battery', 'monitor'],
          (line) => {
            const b = parseBatteryLine(line)
            if (b === null) return
            this.last.battery = { value: b, at: this.now() }
            this.battery?.noteData()
          },
          onExit,
        ),
    })
    this.battery.start()

    if (this.opts.processName !== undefined) this.setProcessName(this.opts.processName)
    this.timer = setInterval(() => this.emit(), this.opts.intervalMs ?? 1000)
  }

  /**
   * (Re)engancha el canal de proceso. Lo llama el server cuando la app aparece o cambia
   * de pid — el equivalente de `refreshPid()` del sampler de Android.
   *
   * Idempotente: con el mismo nombre no re-arma el stream, porque volver a levantarlo
   * cuesta decenas de segundos de handshake del túnel.
   *
   * **Salvo que el stream esté muerto** (ticket 046). La idempotencia miraba sólo el
   * nombre, así que un sysmon caído con la app llamándose igual no se re-armaba nunca y el
   * canal de proceso quedaba mudo para el resto de la sesión. El watch de procesos del
   * server llama acá cada 5 s: con la salud del stream en la condición, ese mismo latido
   * es el que lo repone.
   */
  setProcessName(processName: string): void {
    if (processName === this.processName && this.sysmonAlive) return
    this.processName = processName
    this.sysmonAlive = true
    // Generación del stream: matar al hijo viejo dispara SU onExit un rato después, y sin
    // esto ese cadáver apagaría la bandera del stream nuevo. El watch lo vería muerto,
    // re-armaría, y cada vuelta de 5 s pagaría un handshake de túnel para nada.
    const gen = ++this.sysmonGen
    this.stopSysmon?.()
    this.last.process = null
    const { transport, serial } = this.opts
    this.stopSysmon = transport.stream(
      serial,
      [
        'developer',
        'dvt',
        'sysmon',
        'process',
        'monitor',
        'process',
        '--filter',
        `name=${processName}`,
        // sin esto aborta listando todos los matches en vez de elegir uno
        '--choose',
        'first',
        '--key',
        'pid',
        '--key',
        'name',
        '--key',
        'cpuUsage',
        '--key',
        'physFootprint',
        '--key',
        'memResidentSize',
        '--key',
        'memCompressed',
        '--key',
        'threadCount',
      ],
      (line) => {
        const s = this.assembler.push(line)
        if (s !== null) this.last.process = { value: s, at: this.now() }
      },
      () => {
        if (gen === this.sysmonGen) this.sysmonAlive = false
      },
    )
  }

  /** Nombre de proceso enganchado ahora mismo (null = la app no está corriendo). */
  get attachedProcess(): string | null {
    return this.processName
  }

  stop(): void {
    // ANTES de matar a los hijos: al hacerlo salta su `onExit`, que sin este flag avisaría
    // "canal vital caído" en pleno teardown y le arrancaría al server una ventana de
    // gracia por un device que él mismo acaba de soltar.
    this.stopped = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.stopGraphics?.()
    this.stopSysmon?.()
    this.battery?.stop()
    this.stopGraphics = null
    this.stopSysmon = null
    this.battery = null
  }

  /** true cuando algún canal ya entregó datos — lo usa el server para no emitir en vacío. */
  get hasData(): boolean {
    return this.last.graphics !== null || this.last.process !== null || this.last.battery !== null
  }

  /** El canal vital está caído ahora mismo (hijo muerto o TTL vencido). */
  get isVitalDown(): boolean {
    return this.vitalDown
  }

  /** Valor del canal si llegó dentro de la ventana de frescura; si no, null. */
  private fresh<T>(entry: Fresh<T> | null): T | null {
    if (entry === null) return null
    return this.now() - entry.at <= this.staleMs ? entry.value : null
  }

  private markVitalDown(): void {
    if (this.vitalDown || this.stopped) return
    this.vitalDown = true
    this.opts.onVitalDown?.()
  }

  private markVitalUp(): void {
    if (!this.vitalDown || this.stopped) return
    this.vitalDown = false
    this.opts.onVitalUp?.()
  }

  private emit(): void {
    // El TTL sólo corre DESPUÉS de la primera línea: levantar el túnel tarda decenas de
    // segundos (spike 033) y no se puede dar por caído un canal que todavía no arrancó.
    // El handshake que nunca llega no se detecta acá — sí lo detecta la muerte del hijo.
    if (this.last.graphics !== null && this.fresh(this.last.graphics) === null) {
      this.markVitalDown()
    }
    const g = this.fresh(this.last.graphics)
    const p = this.fresh(this.last.process)
    const sample: Sample = {
      t: this.t,
      ts: Date.now(),
      cpu: p?.cpuUsage ?? null,
      // sysmontap por proceso no da el CPU del device entero; sale null y la UI lo oculta.
      deviceCpu: null,
      deviceRamUsedMb: null,
      mem: {
        // pss es de Android por definición: en iOS queda null y el total va en footprint.
        pss: null,
        footprint: p?.footprintMb ?? null,
        compressed: p?.compressedMb ?? null,
        rss: p?.residentMb ?? null,
        java: null,
        native: null,
        graphics: null,
        code: null,
        stack: null,
        other: null,
      },
      fps: g?.fps ?? null,
      // Sin histograma de frame-times en graphics.opengl (spike 033): todo null, y la UI
      // esconde el tile porque la capability `frameTimes` es false en iOS.
      frame: {
        p50Ms: null,
        p90Ms: null,
        p99Ms: null,
        jankPct: null,
        jankFrames: null,
        totalFrames: null,
      },
      gpu: g?.gpu ?? null,
      // Temperatura de SoC: no existe en iOS sin entitlements privados.
      tempC: null,
      // Temperatura DE BATERÍA (no del SoC — eso no existe en iOS).
      battery: this.fresh(this.last.battery) ?? {
        levelPct: null,
        tempC: null,
        mA: null,
        charging: null,
      },
      netRxKb: null,
      netTxKb: null,
    }
    this.t += 1
    this.opts.onSample(sample)
  }
}
