// Sampler (ticket 021): corre los collectors sobre AdbTransport.shell() a ~1 Hz,
// arma un Sample y lo emite. Best-effort: cada collector se envuelve en try/catch;
// si falla (comando N/A del device o excepción de transporte), su métrica queda null
// y el tick sigue — nunca se reintenta dentro del mismo tick.
//
// La costura: TODO acceso a adb pasa por AdbTransport (inyectado). El sampler no
// conoce el binario adb ni el runtime.
import type { AdbTransport } from '../adb/AdbTransport'
import type { Sample } from '../schema'
import { parseMeminfo } from '../collectors/meminfo'
import { parseCpu, type CpuSnapshot } from '../collectors/cpu'
import { parseFps } from '../collectors/fps'
import { parseTemp } from '../collectors/temp'
import { parseGpu } from '../collectors/gpu'
import { parseBattery } from '../collectors/battery'
import { parseNetDev, netThroughputKb, type NetSnapshot } from '../collectors/netdev'

/** Comandos shell por métrica (fuentes confirmadas en el SM-A155M / API 36). */
export const SHELL_COMMANDS = {
  meminfo: (pkg: string) => `dumpsys meminfo ${pkg}`,
  // combinamos /proc/stat y /proc/<pid>/stat en una llamada
  cpu: (pid: number) => `cat /proc/stat /proc/${pid}/stat`,
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

/** Corre un collector best-effort: cualquier error ⇒ el fallback (típicamente null). */
async function best<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export class Sampler {
  private t = 0
  private prevCpu: CpuSnapshot | null = null
  private prevNet: NetSnapshot | null = null

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

    // Correr todo en paralelo; cada uno best-effort.
    const [memRaw, gpuRaw, tempRaw, fpsRaw, batRaw, netRaw, cpuSnap] = await Promise.all([
      best(async () => (await shell(SHELL_COMMANDS.meminfo(this.pkg))).stdout, ''),
      best(async () => (await shell(SHELL_COMMANDS.gpu)).stdout, ''),
      best(async () => (await shell(SHELL_COMMANDS.temp)).stdout, ''),
      best(async () => (await shell(SHELL_COMMANDS.fps)).stdout, ''),
      best(async () => (await shell(SHELL_COMMANDS.battery)).stdout, ''),
      best(async () => (await shell(SHELL_COMMANDS.net)).stdout, ''),
      best<CpuSnapshot | null>(async () => this.readCpuSnapshot(), null),
    ])

    const mem = safe(() => parseMeminfo(memRaw), {
      pss: null,
      java: null,
      native: null,
      graphics: null,
      code: null,
      stack: null,
      other: null,
    } as Sample['mem'])

    // CPU necesita dos snapshots: null en la primera muestra.
    let cpu: number | null = null
    if (cpuSnap) {
      if (this.prevCpu) cpu = safe(() => parseCpu(this.prevCpu!, cpuSnap), null)
      this.prevCpu = cpuSnap
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

  private async readCpuSnapshot(): Promise<CpuSnapshot | null> {
    const r = await this.transport.shell(this.serial, SHELL_COMMANDS.cpu(this.pid))
    if (r.exitCode !== 0 && !r.stdout.includes('cpu')) return null
    // El combinado imprime /proc/stat (empieza con "cpu ...") y luego /proc/<pid>/stat
    // (una línea "<pid> (comm) ..."). Los separamos.
    const out = r.stdout
    const pidLineMatch = out.match(/^\d+ \(.*\).*$/m)
    const pidStat = pidLineMatch ? pidLineMatch[0] : ''
    // cpuStat = todo lo que empieza con "cpu"
    const cpuStat = out
      .split('\n')
      .filter((l) => /^cpu/.test(l))
      .join('\n')
    if (!cpuStat || !pidStat) return null
    return { pidStat, cpuStat }
  }

  /** Refresca el pid (la app pudo reiniciarse). Best-effort. */
  async refreshPid(): Promise<void> {
    const pid = await resolvePid(this.transport, this.serial, this.pkg)
    if (pid !== null && pid !== this.pid) {
      this.pid = pid
      this.prevCpu = null // el delta contra el pid viejo no sirve
    }
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
