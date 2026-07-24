// Sampler (tickets 021/023): corre los collectors sobre AdbTransport.shell() en cada
// tick, arma un Sample y lo emite. Best-effort: cada collector se envuelve en
// try/catch; si falla (comando N/A del device o excepción de transporte), su métrica
// queda null y el tick sigue — nunca se reintenta dentro del mismo tick.
//
// Dos carriles (ticket 023 — el profiler exigía al device en gama baja):
//  - RÁPIDO (cada tick): solo cats de /proc y /sys + el dump de FPS. Incluye RSS
//    de la app (VmRSS de /proc/<pid>/status, ya dentro del cat combinado — gratis).
//  - LENTO (cada N segundos, carry-forward entre corridas): `dumpsys meminfo`
//    (~cientos de ms en gama baja y contiende con el proceso del juego vía
//    mmap_lock — el observer effect que motivó el ticket), `dumpsys
//    thermalservice`, `dumpsys battery` y el `ps -A` de refreshPid. Entre corridas
//    el Sample repite el último valor conocido; cuando la corrida programada
//    falla, el valor vuelve a null (N/A honesto, igual que antes).
// La muerte del proceso se detecta gratis en el carril rápido (el pid desaparece
// del cat combinado) y fuerza el `ps -A` en el próximo refreshPid.
//
// Multi-proceso: la app puede correr procesos hijos (`pkg:servicio`, WebView sandbox).
// refreshPid los detecta vía `ps -A`; CPU, RSS y PSS agregan main + hijos.
//
// La costura: TODO acceso a adb pasa por AdbTransport (inyectado). El sampler no
// conoce el binario adb ni el runtime.
import type { AdbTransport } from '../adb/AdbTransport'
import type { BatterySample, MemSample, Sample } from '../schema'
import { parseMeminfo, mergeMemSamples, parseVmRssMb } from '../collectors/meminfo'
import { parseCpu, parseDeviceCpu, type CpuSnapshot } from '../collectors/cpu'
import { parseDeviceMemUsedMb } from '../collectors/deviceMem'
import { parseFps } from '../collectors/fps'
import { parseTemp } from '../collectors/temp'
import { parseGpu } from '../collectors/gpu'
import { parseBattery } from '../collectors/battery'
import { parseNetDev, netThroughputKb, type NetSnapshot } from '../collectors/netdev'

/** Comandos shell por métrica (fuentes confirmadas en el SM-A155M / API 36). */
export const SHELL_COMMANDS = {
  meminfo: (pkg: string) => `dumpsys meminfo ${pkg}`,
  /** meminfo de un proceso hijo puntual (los hijos no matchean por nombre de package) */
  meminfoPid: (pid: number) => `dumpsys meminfo ${pid}`,
  // /proc/stat (CPU device + base del share), /proc/meminfo (RAM device), y por cada
  // proceso de la app su /proc/<pid>/stat (CPU) y /proc/<pid>/status (VmRSS) —
  // UNA sola llamada. Ninguno de los archivos pisa las claves de los otros.
  cpu: (pids: number[]) =>
    [
      'cat /proc/stat /proc/meminfo',
      ...pids.map((p) => `/proc/${p}/stat`),
      ...pids.map((p) => `/proc/${p}/status`),
    ].join(' '),
  /** main + hijos del package en un comando (reemplaza a pidof en el loop) */
  pids: 'ps -A -o PID,NAME',
  // primaria del device (kgsl y mali fallan acá → ver research §5 para fallbacks)
  gpu: 'cat /sys/kernel/gpu/gpu_busy',
  temp: 'dumpsys thermalservice',
  // -dump -clear: reporta averageFPS desde el último clear y resetea, así cada tick
  // mide ~el último segundo. Sin -clear, averageFPS acumula toda la sesión y a los
  // minutos deja de reaccionar a caídas de FPS.
  fps: 'dumpsys SurfaceFlinger --timestats -dump -clear',
  fpsEnable: 'dumpsys SurfaceFlinger --timestats -enable -clear',
  fpsDisable: 'dumpsys SurfaceFlinger --timestats -disable',
  battery: 'dumpsys battery',
  // red realtime device-wide (per-app no existe sin root en API 36 — ver netdev.ts)
  net: 'cat /proc/net/dev',
} as const

/** Períodos del carril lento (ms). No dependen del intervalo del carril rápido. */
export interface LaneIntervals {
  /** dumpsys meminfo (PSS + composición) — el comando caro del loop. */
  meminfoMs: number
  /** dumpsys thermalservice + dumpsys battery (cambian lento). */
  slowMs: number
  /** ps -A con la app viva (muerte/reinicio se detecta antes por el cat combinado). */
  psMs: number
}

export const DEFAULT_LANES: LaneIntervals = {
  meminfoMs: 15_000,
  slowMs: 10_000,
  psMs: 10_000,
}

export interface SamplerOptions {
  lanes?: Partial<LaneIntervals>
  /** clock inyectable (tests); default Date.now. */
  now?: () => number
}

/** Resuelve el pid del package (best-effort). null si no está corriendo. */
export async function resolvePid(
  transport: AdbTransport,
  serial: string,
  pkg: string,
): Promise<number | null> {
  try {
    const r = await transport.shell(serial, `pidof ${pkg}`)
    const pid = Number(r.stdout.trim().split(/\s+/)[0])
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Procesos del package (main + hijos `pkg:*`) desde una salida de `ps -A -o PID,NAME`. */
export function parsePids(psOut: string, pkg: string): { main: number | null; children: number[] } {
  let main: number | null = null
  const children: number[] = []
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/)
    if (!m) continue
    const pid = Number(m[1])
    const name = m[2]!
    if (!Number.isFinite(pid) || pid <= 0) continue
    if (name === pkg) main = pid
    else if (name.startsWith(pkg + ':')) children.push(pid)
  }
  return { main, children }
}

/** Corre un collector best-effort: cualquier error ⇒ el fallback (típicamente null). */
async function best<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Snapshot combinado de /proc: CPU (device + pids), RAM device y RSS de la app. */
interface ProcSnapshot {
  cpu: CpuSnapshot
  deviceRamUsedMb: number | null
  /** VmRSS agregado (main + hijos) en MB; null si ningún status se pudo leer. */
  appRssMb: number | null
  /** el /proc/<pid>/stat del main apareció en el cat (false ⇒ proceso muerto). */
  mainPidSeen: boolean
}

const NULL_MEM: MemSample = {
  pss: null,
  rss: null,
  java: null,
  native: null,
  graphics: null,
  code: null,
  stack: null,
  other: null,
}

const NULL_BATTERY: BatterySample = { levelPct: null, tempC: null, mA: null, charging: null }

export class Sampler {
  private t = 0
  private prevCpu: CpuSnapshot | null = null
  private prevNet: NetSnapshot | null = null
  private childPids: number[] = []
  private readonly lanes: LaneIntervals
  private readonly now: () => number
  // carril lento: próximas corridas (0 = correr en el próximo tick) + último valor
  private nextMeminfoTs = 0
  private nextSlowTs = 0
  private lastPsTs = 0
  private lastMem: MemSample = NULL_MEM
  private lastTempC: number | null = null
  private lastBattery: BatterySample = NULL_BATTERY
  /** el último cat combinado no vio al pid main ⇒ forzar ps en el próximo refreshPid */
  private pidMissing = false

  constructor(
    private readonly transport: AdbTransport,
    private readonly serial: string,
    private readonly pkg: string,
    private pid: number,
    opts: SamplerOptions = {},
  ) {
    this.lanes = { ...DEFAULT_LANES, ...opts.lanes }
    this.now = opts.now ?? Date.now
  }

  /** pid actual (0 = proceso todavía no visto; refreshPid lo engancha cuando aparece). */
  get processId(): number {
    return this.pid
  }

  /** Habilita la recolección de timestats de SurfaceFlinger (necesaria para FPS). Best-effort. */
  async init(): Promise<void> {
    try {
      await this.transport.shell(this.serial, SHELL_COMMANDS.fpsEnable)
    } catch {
      /* si no está disponible, FPS quedará N/A tick a tick */
    }
  }

  /** Deshabilita timestats al cerrar (evita dejar el estado del device encendido). Best-effort. */
  async dispose(): Promise<void> {
    try {
      await this.transport.shell(this.serial, SHELL_COMMANDS.fpsDisable)
    } catch {
      /* no-op */
    }
  }

  /** Corre los collectors del tick (rápidos siempre, lentos si les toca) y devuelve el Sample. */
  async sampleOnce(): Promise<Sample> {
    const shell = (cmd: string) => this.transport.shell(this.serial, cmd)
    const now = this.now()
    const runMeminfo = now >= this.nextMeminfoTs
    const runSlow = now >= this.nextSlowTs

    // Correr todo en paralelo; cada uno best-effort. Los comandos del carril lento
    // solo si les toca (Promise.resolve(null) = "este tick no corre, carry-forward").
    const [memRaw, childMemRaws, gpuRaw, tempRaw, fpsRaw, batRaw, netRaw, procSnap] =
      await Promise.all([
        runMeminfo
          ? best<string | null>(
              async () => (await shell(SHELL_COMMANDS.meminfo(this.pkg))).stdout,
              '',
            )
          : Promise.resolve(null),
        runMeminfo
          ? Promise.all(
              this.childPids.map((p) =>
                best(async () => (await shell(SHELL_COMMANDS.meminfoPid(p))).stdout, ''),
              ),
            )
          : Promise.resolve([] as string[]),
        best(async () => (await shell(SHELL_COMMANDS.gpu)).stdout, ''),
        runSlow
          ? best<string | null>(async () => (await shell(SHELL_COMMANDS.temp)).stdout, '')
          : Promise.resolve(null),
        best(async () => (await shell(SHELL_COMMANDS.fps)).stdout, ''),
        runSlow
          ? best<string | null>(async () => (await shell(SHELL_COMMANDS.battery)).stdout, '')
          : Promise.resolve(null),
        best(async () => (await shell(SHELL_COMMANDS.net)).stdout, ''),
        best<ProcSnapshot | null>(async () => this.readProcSnapshot(), null),
      ])

    if (runMeminfo) {
      this.nextMeminfoTs = now + this.lanes.meminfoMs
      const memParts = [memRaw ?? '', ...childMemRaws]
        .filter((raw) => raw !== '')
        .map((raw) => safe(() => parseMeminfo(raw), NULL_MEM))
      // corrida fallida (todas vacías) ⇒ vuelve a null: N/A honesto, no un valor viejo
      this.lastMem = mergeMemSamples(memParts)
    }
    if (runSlow) {
      this.nextSlowTs = now + this.lanes.slowMs
      this.lastTempC = safe(() => parseTemp(tempRaw ?? ''), null)
      this.lastBattery = safe(() => parseBattery(batRaw ?? ''), NULL_BATTERY)
    }

    // CPU necesita dos snapshots: null en la primera muestra.
    let cpu: number | null = null
    let deviceCpu: number | null = null
    if (procSnap) {
      if (this.prevCpu) {
        cpu = safe(() => parseCpu(this.prevCpu!, procSnap.cpu), null)
        deviceCpu = safe(() => parseDeviceCpu(this.prevCpu!, procSnap.cpu), null)
      }
      this.prevCpu = procSnap.cpu
      // señal barata de muerte/reinicio: el pid main no apareció en el cat combinado
      if (this.pid > 0) this.pidMissing = !procSnap.mainPidSeen
    }

    // Red: igual que CPU, delta entre snapshots → KB/s. null en la primera muestra.
    let netRxKb: number | null = null
    let netTxKb: number | null = null
    const netSnap = safe(() => parseNetDev(netRaw, Date.now()), null)
    if (netSnap) {
      if (this.prevNet) {
        const tp = safe(() => netThroughputKb(this.prevNet!, netSnap), null)
        if (tp) {
          netRxKb = tp.rxKb
          netTxKb = tp.txKb
        }
      }
      this.prevNet = netSnap
    }

    const sample: Sample = {
      t: this.t++,
      ts: Date.now(),
      cpu,
      deviceCpu,
      deviceRamUsedMb: procSnap?.deviceRamUsedMb ?? null,
      gpu: safe(() => parseGpu(gpuRaw), null),
      // filtrar el layer de la app (el dump lista NotificationShade/StatusBar también)
      fps: safe(() => parseFps(fpsRaw, this.pkg), null),
      tempC: this.lastTempC,
      // PSS/composición del carril lento (carry-forward) + RSS fresco de este tick
      mem: { ...this.lastMem, rss: procSnap?.appRssMb ?? null },
      battery: this.lastBattery,
      // red realtime device-wide vía /proc/net/dev (delta por tick). Per-app no existe
      // sin root en API 36 (ver netdev.ts). null en la primera muestra (necesita delta).
      netRxKb,
      netTxKb,
    }
    return sample
  }

  private async readProcSnapshot(): Promise<ProcSnapshot | null> {
    const pids = [this.pid, ...this.childPids].filter((p) => p > 0)
    const r = await this.transport.shell(this.serial, SHELL_COMMANDS.cpu(pids))
    if (r.exitCode !== 0 && !r.stdout.includes('cpu')) return null
    // El combinado imprime /proc/stat (líneas "cpu..."), /proc/meminfo ("MemTotal:..."),
    // una línea "<pid> (comm) ..." por proceso y su /proc/<pid>/status ("VmRSS:...").
    // Los separamos por forma.
    const out = r.stdout
    const pidStats = out.split('\n').filter((l) => /^\d+ \(/.test(l))
    const cpuStat = out
      .split('\n')
      .filter((l) => /^cpu/.test(l))
      .join('\n')
    if (!cpuStat) return null
    return {
      cpu: { pidStats, cpuStat },
      deviceRamUsedMb: safe(() => parseDeviceMemUsedMb(out), null),
      appRssMb: safe(() => parseVmRssMb(out), null),
      mainPidSeen: this.pid > 0 && pidStats.some((l) => l.startsWith(`${this.pid} (`)),
    }
  }

  /**
   * Refresca los pids del package (main + hijos). Devuelve si la app está viva.
   * null = no se pudo saber (adb falló) — el caller no debe tomar acción.
   *
   * Carril lento: `ps -A` corre solo si (a) no hay pid enganchado, (b) el cat
   * combinado dejó de ver al main (pidMissing), o (c) pasaron psMs desde el último.
   * En el resto de los ticks devuelve true sin tocar adb (el cat del último tick
   * ya confirmó al proceso).
   */
  async refreshPid(): Promise<boolean | null> {
    const now = this.now()
    const mustPs = this.pid === 0 || this.pidMissing || now - this.lastPsTs >= this.lanes.psMs
    if (!mustPs) return true

    let psOut: string
    try {
      const r = await this.transport.shell(this.serial, SHELL_COMMANDS.pids)
      psOut = r.stdout
    } catch {
      return null
    }
    // ps corrió pero vino vacío/raro: tampoco concluir que la app murió
    if (!/^\s*\d+\s+\S+/m.test(psOut)) return null
    this.lastPsTs = now
    this.pidMissing = false

    const { main, children } = parsePids(psOut, this.pkg)
    this.childPids = children
    if (main === null) {
      // proceso muerto: dejar de catear su /proc y cortar el delta de CPU
      if (this.pid !== 0) {
        this.pid = 0
        this.prevCpu = null
      }
      return false
    }
    if (main !== this.pid) {
      this.pid = main
      this.prevCpu = null // el delta contra el pid viejo no sirve
      // proceso nuevo: repoblar el carril lento ya (no esperar la próxima ventana)
      this.nextMeminfoTs = 0
      this.nextSlowTs = 0
    }
    return true
  }
}

/** Igual que best() pero para funciones síncronas. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
