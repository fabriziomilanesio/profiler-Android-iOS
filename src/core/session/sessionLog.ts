// Registro de sesiones en disco (JSONL, una por corrida del server) para el
// historial del dashboard y el export de sesiones pasadas. Formato por línea:
//   {"type":"meta", id, startedAt, device}      ← primera línea (device puede ser null)
//   {"type":"device", device}                   ← al enganchar/cambiar device
//   {"type":"event", ts, kind, pkg, serial}     ← switches de app/device
//   {"type":"sample", pkg, serial, sample}      ← cada tick
// Todo best-effort: un disco que falla nunca rompe el sampling.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DeviceInfo, Sample } from '../schema'
import type { SessionEntry, SessionEvent } from './sessionBuffer'

/** id de sesión = timestamp de arranque, seguro como nombre de archivo. */
export function sessionId(startedAt: Date): string {
  return startedAt.toISOString().replace(/:/g, '-').replace(/\..*$/, '')
}

// los ids viajan por query param (?session=...) — validar corta path traversal
const SESSION_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}$/
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

export function defaultSessionsDir(): string {
  return join(homedir(), '.config', 'sample-profiler', 'sessions')
}

export interface SessionInfo {
  id: string
  startedAt: string
  /** fin aproximado (mtime del archivo) */
  endedAt: string
  durationS: number
  /** packages vistos en la sesión (del meta + eventos) */
  packages: string[]
  deviceName: string | null
}

interface MetaLine {
  type: 'meta'
  id: string
  startedAt: string
  device: DeviceInfo | null
  pkg: string
}

export class SessionLog {
  private readonly path: string
  private ok = true

  constructor(
    private readonly dir: string,
    readonly id: string,
    startedAt: string,
    initialPkg: string,
    device: DeviceInfo | null,
  ) {
    this.path = join(dir, `${id}.jsonl`)
    try {
      mkdirSync(dir, { recursive: true })
      const meta: MetaLine = { type: 'meta', id, startedAt, device, pkg: initialPkg }
      appendFileSync(this.path, JSON.stringify(meta) + '\n')
    } catch {
      this.ok = false // sin disco: la sesión vive solo en el buffer de memoria
    }
  }

  private append(obj: unknown): void {
    if (!this.ok) return
    try {
      appendFileSync(this.path, JSON.stringify(obj) + '\n')
    } catch {
      /* best-effort */
    }
  }

  appendSample(entry: SessionEntry): void {
    this.append({ type: 'sample', pkg: entry.pkg, serial: entry.serial, sample: entry.sample })
  }

  appendEvent(ev: SessionEvent): void {
    this.append({ type: 'event', ...ev })
  }

  appendDevice(device: DeviceInfo): void {
    this.append({ type: 'device', device })
  }

  /** Lista las sesiones del directorio, más recientes primero. */
  static list(dir: string): SessionInfo[] {
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return []
    }
    const out: SessionInfo[] = []
    for (const f of files) {
      const id = f.slice(0, -'.jsonl'.length)
      if (!isValidSessionId(id)) continue
      try {
        const path = join(dir, f)
        const raw = readFileSync(path, 'utf8')
        const lines = raw.split('\n').filter(Boolean)
        const meta = JSON.parse(lines[0] ?? '{}') as Partial<MetaLine>
        if (meta.type !== 'meta' || !meta.startedAt) continue
        const packages = new Set<string>()
        if (meta.pkg) packages.add(meta.pkg)
        let deviceName = meta.device
          ? [meta.device.manufacturer, meta.device.model].filter(Boolean).join(' ')
          : null
        for (const line of lines) {
          // solo eventos/device: evitar parsear cada sample (archivos grandes)
          if (line.startsWith('{"type":"event"')) {
            const ev = JSON.parse(line) as SessionEvent & { type: string }
            if (ev.pkg) packages.add(ev.pkg)
          } else if (line.startsWith('{"type":"device"')) {
            const d = (JSON.parse(line) as { device: DeviceInfo }).device
            deviceName = [d.manufacturer, d.model].filter(Boolean).join(' ')
          }
        }
        const mtime = statSync(path).mtime
        const durationS = Math.max(
          0,
          Math.round((mtime.getTime() - new Date(meta.startedAt).getTime()) / 1000),
        )
        out.push({
          id,
          startedAt: meta.startedAt,
          endedAt: mtime.toISOString(),
          durationS,
          packages: [...packages],
          deviceName: deviceName || null,
        })
      } catch {
        /* archivo corrupto: se saltea */
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** Lee una sesión completa del disco. null si no existe o está corrupta. */
  static read(
    dir: string,
    id: string,
  ): { device: DeviceInfo | null; entries: SessionEntry[]; events: SessionEvent[] } | null {
    if (!isValidSessionId(id)) return null
    let raw: string
    try {
      raw = readFileSync(join(dir, `${id}.jsonl`), 'utf8')
    } catch {
      return null
    }
    let device: DeviceInfo | null = null
    const entries: SessionEntry[] = []
    const events: SessionEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const obj = JSON.parse(line) as { type: string } & Record<string, unknown>
        if (obj.type === 'meta' || obj.type === 'device') {
          const d = obj['device'] as DeviceInfo | null
          if (d) device = d
        } else if (obj.type === 'sample') {
          entries.push({
            pkg: obj['pkg'] as string,
            serial: obj['serial'] as string,
            sample: obj['sample'] as Sample,
          })
        } else if (obj.type === 'event') {
          events.push({
            ts: obj['ts'] as number,
            kind: obj['kind'] as SessionEvent['kind'],
            pkg: obj['pkg'] as string,
            serial: obj['serial'] as string,
          })
        }
      } catch {
        /* línea corrupta (corte a mitad de escritura): se saltea */
      }
    }
    return { device, entries, events }
  }
}
