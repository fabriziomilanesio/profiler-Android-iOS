// Persistencia del selector de apps: última app profileada (auto-resume del CLI),
// contadores de uso por package (ordenan el dropdown: más usadas arriba) y el
// término del chip de filtro (default "evermore", configurable editando el JSON).
//
// Vive en ~/.config/evermore-profiler/apps.json — local a la máquina, fuera del
// repo a propósito: la selección personal no debe generar ruido en git.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isValidPackageName } from './adb/packageName'

export interface AppStoreData {
  /** último package profileado; el CLI arranca con este si no pasás --package. */
  last: string | null
  /** veces que cada package fue seleccionado (ranking del dropdown). */
  usage: Record<string, number>
  /** término del chip de filtro del selector (substring, case-insensitive). */
  filterTerm: string
}

export function defaultAppStoreData(): AppStoreData {
  return { last: null, usage: {}, filterTerm: 'evermore' }
}

/** Parsea el JSON del store. Tolerante: corrupto o con basura ⇒ defaults campo a campo. */
export function parseAppStore(json: string): AppStoreData {
  const d = defaultAppStoreData()
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return d
  }
  if (typeof raw !== 'object' || raw === null) return d
  const o = raw as Record<string, unknown>
  // el archivo es editable a mano: cada campo se valida por separado
  if (typeof o['last'] === 'string' && isValidPackageName(o['last'])) d.last = o['last']
  if (typeof o['usage'] === 'object' && o['usage'] !== null) {
    for (const [pkg, count] of Object.entries(o['usage'] as Record<string, unknown>)) {
      if (isValidPackageName(pkg) && typeof count === 'number' && count > 0) {
        d.usage[pkg] = Math.floor(count)
      }
    }
  }
  if (typeof o['filterTerm'] === 'string' && o['filterTerm'].trim()) {
    d.filterTerm = o['filterTerm'].trim()
  }
  return d
}

/** Registra una selección: usage[pkg]++ y last=pkg. Devuelve una copia. */
export function recordSelection(data: AppStoreData, pkg: string): AppStoreData {
  return {
    ...data,
    last: pkg,
    usage: { ...data.usage, [pkg]: (data.usage[pkg] ?? 0) + 1 },
  }
}

/** Ordena packages instalados por uso descendente, desempate alfabético. */
export function rankPackages(installed: string[], usage: Record<string, number>): string[] {
  return [...installed].sort((a, b) => {
    const diff = (usage[b] ?? 0) - (usage[a] ?? 0)
    return diff !== 0 ? diff : a.localeCompare(b)
  })
}

export function appStorePath(): string {
  return join(homedir(), '.config', 'evermore-profiler', 'apps.json')
}

/** Store con persistencia. Carga al construir; select() guarda enseguida (best-effort). */
export class AppStore {
  private data_: AppStoreData

  constructor(private readonly path: string = appStorePath()) {
    let json = ''
    try {
      json = readFileSync(this.path, 'utf8')
    } catch {
      /* primera corrida: sin archivo */
    }
    this.data_ = parseAppStore(json)
  }

  get data(): AppStoreData {
    return this.data_
  }

  select(pkg: string): void {
    this.data_ = recordSelection(this.data_, pkg)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.data_, null, 2) + '\n')
    } catch {
      /* un disco que falla no debe romper el profiler */
    }
  }
}
