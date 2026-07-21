// Sampler (ticket 021): corre los collectors sobre AdbTransport.shell() a ~1 Hz,
// arma un Sample y lo emite. Best-effort: cada collector se envuelve en try/catch;
// si falla (comando N/A del device o excepción de transporte), su métrica queda null
// y el tick sigue — nunca se reintenta dentro del mismo tick.
//
// Multi-proceso: la app puede correr procesos hijos (`pkg:servicio`, WebView sandbox).
// refreshPid los detecta vía `ps -A` (un solo comando, reemplaza a pidof en el loop);
// CPU y PSS agregan main + hijos. Sin hijos, el costo por tick es idéntico al de antes.
//
// La costura: TODO acceso a adb pasa por AdbTransport (inyectado). El sampler no
// conoce el binario adb ni el runtime.
import type { AdbTransport } from '../adb/AdbTransport'
import type { Sample } from '../schema'
import { parseMeminfo, mergeMemSamples } from '../collectors/meminfo'
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
  // /proc/stat (CPU device + base del share), /proc/meminfo (RAM device) y los
  // /proc/<pid>/stat de todos los procesos de la app — UNA sola llamada.
  cpu: (pids: number[]) =>
    ['cat /proc/stat /proc/meminfo', ...pids.map((p) => `/proc/${p}/stat`)].join(' '),
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

/** Snapshot combinado de /proc: CPU (device + pids) y RAM del device. */
interface ProcSnapshot {
  cpu: CpuSnapshot
  deviceRamUsedMb: number | null
}

export class Sampler {
  private t = 0
  private prevCpu: CpuSnapshot | null = null
  private prevNet: NetSnapshot | null = null
  private childPids: number[] = []

  constructor(
    private readonly transport: AdbTransport,
    private readonly serial: string,
    private readonly pkg: string,
    private pid: number,
  ) {}

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

  /** Corre todos los collectors una vez y devuelve el Sample. */
  async sampleOnce(): Promise<Sample> {
    const shell = (cmd: string) => this.transport.shell(this.serial, cmd)

    // Correr todo en paralelo; cada uno best-effort. Los meminfo de hijos solo
    // existen si hay hijos (caso Evermore: lista vacía, costo cero).
    const [memRaw, childMemRaws, gpuRaw, tempRaw, fpsRaw, batRaw, netRaw, procSnap] =
      await Promise.all([
        best(async () => (await shell(SHELL_COMMANDS.meminfo(this.pkg))).stdout, ''),
        Promise.all(
          this.childPids.map((p) =>
            best(async () => (await shell(SHELL_COMMANDS.meminfoPid(p))).stdout, ''),
          ),
        ),
        best(async () => (await shell(SHELL_COMMANDS.gpu)).stdout, ''),
        best(async () => (await shell(SHELL_COMMANDS.temp)).stdout, ''),
        best(async () => (await shell(SHELL_COMMANDS.fps)).stdout, ''),
        best(async () => (await shell(SHELL_COMMANDS.battery)).stdout, ''),
        best(async () => (await shell(SHELL_COMMANDS.net)).stdout, ''),
        best<ProcSnapshot | null>(async () => this.readProcSnapshot(), null),
      ])

    const memParts = [memRaw, ...childMemRaws]
      .filter((raw) => raw !== '')
      .map((raw) =>
        safe(() => parseMeminfo(raw), {
          pss: null,
          java: null,
          native: null,
          graphics: null,
          code: null,
          stack: null,
          other: null,
        } as Sample['mem']),
      )
    const mem = mergeMemSamples(memParts)

    // CPU necesita dos snapshots: null en la primera muestra.
    let cpu: number | null = null
    let deviceCpu: number | null = null
    if (procSnap) {
      if (this.prevCpu) {
        cpu = safe(() => parseCpu(this.prevCpu!, procSnap.cpu), null)
        deviceCpu = safe(() => parseDeviceCpu(this.prevCpu!, procSnap.cpu), null)
      }
      this.prevCpu = procSnap.cpu
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
      tempC: safe(() => parseTemp(tempRaw), null),
      mem: {
        pss: mem.pss,
        java: mem.java,
        native: mem.native,
        graphics: mem.graphics,
        code: mem.code,
        stack: mem.stack,
        other: mem.other,
      },
      battery: safe(() => parseBattery(batRaw), {
        levelPct: null,
        tempC: null,
        mA: null,
        charging: null,
      }),
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
    // El combinado imprime /proc/stat (líneas "cpu..."), /proc/meminfo ("MemTotal:...")
    // y una línea "<pid> (comm) ..." por proceso. Los separamos por forma.
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
    }
  }

  /**
   * Refresca los pids del package (main + hijos) con UN comando. Devuelve si la app
   * está viva. null = no se pudo saber (adb falló) — el caller no debe tomar acción.
   */
  async refreshPid(): Promise<boolean | null> {
    let psOut: string
    try {
      const r = await this.transport.shell(this.serial, SHELL_COMMANDS.pids)
      psOut = r.stdout
    } catch {
      return null
    }
    // ps corrió pero vino vacío/raro: tampoco concluir que la app murió
    if (!/^\s*\d+\s+\S+/m.test(psOut)) return null

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
