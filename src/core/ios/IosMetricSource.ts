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
}

/**
 * Últimos valores recibidos por cada canal. El tick los combina en un `Sample`.
 *
 * Se guarda el último valor en vez de promediar la ventana porque los dos canales emiten a
 * ritmos distintos (graphics ~1 Hz, sysmon ~1,5 Hz) y desalineados: promediar exigiría
 * ventanas por canal y no aporta nada a 1 Hz.
 */
interface LastValues {
  graphics: IosGraphicsSample | null
  process: IosProcessSample | null
  battery: BatterySample | null
}

export class IosMetricSource {
  private stopGraphics: (() => void) | null = null
  private stopSysmon: (() => void) | null = null
  private stopBattery: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly assembler = new SysmonAssembler()
  private readonly last: LastValues = { graphics: null, process: null, battery: null }
  private processName: string | null = null
  private t = 0

  constructor(private readonly opts: IosMetricSourceOptions) {}

  start(): void {
    const { transport, serial } = this.opts

    // Canal de gráficos: FPS y GPU son del compositor del device, no del proceso. Arranca
    // siempre, incluso con la app cerrada — igual que el dashboard de Android sigue
    // tickeando con el proceso muerto.
    this.stopGraphics = transport.stream(serial, ['developer', 'dvt', 'graphics'], (line) => {
      const s = parseGraphicsLine(line)
      if (s !== null) this.last.graphics = s
    })

    // Batería: canal LOCKDOWN, no DTX — no depende del túnel ni del proceso de la app,
    // así que arranca siempre y es de los más baratos del stack.
    this.stopBattery = transport.stream(serial, ['diagnostics', 'battery', 'monitor'], (line) => {
      const b = parseBatteryLine(line)
      if (b !== null) this.last.battery = b
    })

    if (this.opts.processName !== undefined) this.setProcessName(this.opts.processName)
    this.timer = setInterval(() => this.emit(), this.opts.intervalMs ?? 1000)
  }

  /**
   * (Re)engancha el canal de proceso. Lo llama el server cuando la app aparece o cambia
   * de pid — el equivalente de `refreshPid()` del sampler de Android.
   *
   * Idempotente: con el mismo nombre no re-arma el stream, porque volver a levantarlo
   * cuesta decenas de segundos de handshake del túnel.
   */
  setProcessName(processName: string): void {
    if (processName === this.processName) return
    this.processName = processName
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
        if (s !== null) this.last.process = s
      },
    )
  }

  /** Nombre de proceso enganchado ahora mismo (null = la app no está corriendo). */
  get attachedProcess(): string | null {
    return this.processName
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.stopGraphics?.()
    this.stopSysmon?.()
    this.stopBattery?.()
    this.stopGraphics = null
    this.stopSysmon = null
    this.stopBattery = null
  }

  /** true cuando algún canal ya entregó datos — lo usa el server para no emitir en vacío. */
  get hasData(): boolean {
    return this.last.graphics !== null || this.last.process !== null || this.last.battery !== null
  }

  private emit(): void {
    const g = this.last.graphics
    const p = this.last.process
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
      battery: this.last.battery ?? { levelPct: null, tempC: null, mA: null, charging: null },
      netRxKb: null,
      netTxKb: null,
    }
    this.t += 1
    this.opts.onSample(sample)
  }
}
