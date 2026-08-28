// Historial específico del modo dual. Cada archivo agrupa los dos carriles bajo un
// mismo id para que nunca haya que inferir parejas a partir de dos sesiones sueltas.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DeviceInfo, Sample } from '../schema'
import { isValidSessionId } from './sessionLog'

export type DualPane = 'primary' | 'secondary'

export interface DualStoredLane {
  device: DeviceInfo | null
  packageName: string | null
  samples: Sample[]
}

export interface DualStoredSession {
  id: string
  startedAt: string
  primary: DualStoredLane
  secondary: DualStoredLane
}

export interface DualSessionInfo {
  id: string
  startedAt: string
  endedAt: string
  durationS: number
  primaryDevice: string | null
  secondaryDevice: string | null
  primaryPackage: string | null
  secondaryPackage: string | null
}

interface DualMetaLine {
  type: 'dual-meta'
  id: string
  startedAt: string
}

function deviceName(device: DeviceInfo | null): string | null {
  if (!device) return null
  return [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial
}

export class DualSessionLog {
  private readonly path: string
  private ok = true

  constructor(
    private readonly dir: string,
    readonly id: string,
    readonly startedAt: string,
  ) {
    this.path = join(dir, `${id}.jsonl`)
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        this.path,
        JSON.stringify({ type: 'dual-meta', id, startedAt } satisfies DualMetaLine) + '\n',
      )
    } catch {
      this.ok = false
    }
  }

  private append(value: unknown): void {
    if (!this.ok) return
    try {
      appendFileSync(this.path, JSON.stringify(value) + '\n')
    } catch {
      /* best-effort: el muestreo no depende del disco */
    }
  }

  appendDevice(pane: DualPane, device: DeviceInfo, packageName: string | null): void {
    this.append({ type: 'lane', pane, device, packageName })
  }

  appendSample(pane: DualPane, packageName: string, serial: string, sample: Sample): void {
    this.append({ type: 'sample', pane, packageName, serial, sample })
  }

  static read(dir: string, id: string): DualStoredSession | null {
    if (!isValidSessionId(id)) return null
    let raw: string
    try {
      raw = readFileSync(join(dir, `${id}.jsonl`), 'utf8')
    } catch {
      return null
    }
    let startedAt = ''
    const primary: DualStoredLane = { device: null, packageName: null, samples: [] }
    const secondary: DualStoredLane = { device: null, packageName: null, samples: [] }
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (value['type'] === 'dual-meta') startedAt = String(value['startedAt'] ?? '')
        const pane = value['pane'] === 'secondary' ? secondary : primary
        if (value['type'] === 'lane') {
          pane.device = (value['device'] as DeviceInfo | null) ?? null
          pane.packageName =
            typeof value['packageName'] === 'string' ? value['packageName'] : pane.packageName
        } else if (value['type'] === 'sample') {
          pane.samples.push(value['sample'] as Sample)
          if (typeof value['packageName'] === 'string') pane.packageName = value['packageName']
        }
      } catch {
        /* tolera la última línea cortada */
      }
    }
    if (!startedAt) return null
    return { id, startedAt, primary, secondary }
  }

  /** Sólo lista records completos: al menos una muestra real en cada carril. */
  static list(dir: string): DualSessionInfo[] {
    let files: string[]
    try {
      files = readdirSync(dir).filter((file) => file.endsWith('.jsonl'))
    } catch {
      return []
    }
    const out: DualSessionInfo[] = []
    for (const file of files) {
      const id = file.slice(0, -'.jsonl'.length)
      const session = DualSessionLog.read(dir, id)
      if (!session || !session.primary.samples.length || !session.secondary.samples.length) continue
      try {
        const endedAt = statSync(join(dir, file)).mtime
        out.push({
          id,
          startedAt: session.startedAt,
          endedAt: endedAt.toISOString(),
          durationS: Math.max(
            0,
            Math.round((endedAt.getTime() - new Date(session.startedAt).getTime()) / 1000),
          ),
          primaryDevice: deviceName(session.primary.device),
          secondaryDevice: deviceName(session.secondary.device),
          primaryPackage: session.primary.packageName,
          secondaryPackage: session.secondary.packageName,
        })
      } catch {
        /* archivo desapareció o quedó ilegible durante el listado */
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }
}
