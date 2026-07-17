// DeviceProxyController (ticket 019): setea/limpia el proxy HTTP del device por
// adb, con cleanup GARANTIZADO (§3 del research). Todo adb pasa por la costura
// AdbTransport — nunca spawnea adb directo. baseDir inyectable para testear.
//
// El patrón: antes de tocar nada, capturePrevious() lee el estado previo y lo
// persiste a proxy-restore.json (por si el proceso muere). restore() devuelve
// EXACTAMENTE ese valor previo y es idempotente. recoverOrphan() rescata un
// restore file huérfano de una corrida que crasheó.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AdbTransport } from '../adb/AdbTransport'

/** Estado del proxy del device: sin proxy, o un host:port seteado. */
export type ProxyState = { kind: 'none' } | { kind: 'set'; host: string; port: number }

interface RestoreRecord {
  serial: string
  previous: ProxyState
}

const KEY = 'global http_proxy'

export class DeviceProxyController {
  private readonly restorePath: string
  /** Estado previo en memoria (además del disco), para restore idempotente. */
  private previous: ProxyState | null = null

  constructor(
    private readonly transport: AdbTransport,
    baseDir: string,
  ) {
    this.restorePath = join(baseDir, 'proxy-restore.json')
  }

  /**
   * Lee el proxy actual (`settings get global http_proxy`), lo parsea y lo
   * persiste a proxy-restore.json antes de que la tool lo pise.
   */
  async capturePrevious(serial: string): Promise<ProxyState> {
    const res = await this.transport.shell(serial, `settings get ${KEY}`)
    const state = parseProxy(res.stdout)
    this.previous = state
    this.writeRestore({ serial, previous: state })
    return state
  }

  /** Setea nuestro proxy: `settings put global http_proxy host:port`. */
  async set(serial: string, host: string, port: number): Promise<void> {
    await this.transport.shell(serial, `settings put ${KEY} ${host}:${port}`)
  }

  /**
   * Restaura el proxy previo EXACTO y borra el restore file. Idempotente: una
   * segunda llamada (o sin capturePrevious previo) no re-emite ni rompe.
   */
  async restore(serial: string): Promise<void> {
    const previous = this.previous ?? this.readRestore()?.previous
    if (!previous) return
    await this.applyState(serial, previous)
    this.previous = null
    this.clearRestore()
  }

  /**
   * Al arrancar la tool: si quedó un proxy-restore.json de una corrida que
   * crasheó (nuestro proxy sigue seteado en el device), restaura el previo y
   * limpia. Devuelve lo recuperado, o null si no había nada.
   */
  async recoverOrphan(): Promise<RestoreRecord | null> {
    const record = this.readRestore()
    if (!record) return null
    await this.applyState(record.serial, record.previous)
    this.clearRestore()
    return record
  }

  private async applyState(serial: string, state: ProxyState): Promise<void> {
    if (state.kind === 'none') {
      await this.transport.shell(serial, `settings delete ${KEY}`)
    } else {
      await this.transport.shell(serial, `settings put ${KEY} ${state.host}:${state.port}`)
    }
  }

  private writeRestore(record: RestoreRecord): void {
    mkdirSync(dirname(this.restorePath), { recursive: true })
    writeFileSync(this.restorePath, JSON.stringify(record), { mode: 0o644 })
  }

  private readRestore(): RestoreRecord | null {
    if (!existsSync(this.restorePath)) return null
    try {
      return JSON.parse(readFileSync(this.restorePath, 'utf8')) as RestoreRecord
    } catch {
      return null
    }
  }

  private clearRestore(): void {
    rmSync(this.restorePath, { force: true })
  }
}

/**
 * Parsea la salida de `settings get global http_proxy`. Valores posibles:
 * `null` (no seteado), `:0` (canónico "sin proxy"), o `host:port`.
 */
export function parseProxy(raw: string): ProxyState {
  const value = raw.trim()
  if (value === '' || value === 'null' || value === ':0') return { kind: 'none' }
  const idx = value.lastIndexOf(':')
  if (idx <= 0) return { kind: 'none' }
  const host = value.slice(0, idx)
  const port = Number.parseInt(value.slice(idx + 1), 10)
  if (!host || !Number.isFinite(port) || port === 0) return { kind: 'none' }
  return { kind: 'set', host, port }
}
