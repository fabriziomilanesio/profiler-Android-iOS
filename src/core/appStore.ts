// Configuración persistente del profiler: selector de apps (última profileada,
// contadores de uso, término del chip) + preferencias del dashboard (tema,
// intervalo de sampling, carpeta de reportes). Editable a mano.
//
// Vive en ~/.config/evermore-profiler/config.json — local a la máquina, fuera del
// repo a propósito. Migración silenciosa desde el viejo apps.json si existe.
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
  /** tema del dashboard y de los reportes exportados. */
  theme: 'light' | 'dark'
  /** intervalo de sampling en ms (aplica en caliente desde el panel de config). */
  intervalMs: number
  /** carpeta donde se guarda la copia de cada reporte exportado. */
  reportsDir: string
}

/** Campos que el panel de configuración puede escribir (PUT /api/config). */
export type ConfigPatch = Partial<
  Pick<AppStoreData, 'filterTerm' | 'theme' | 'intervalMs' | 'reportsDir'>
>

export function defaultReportsDir(): string {
  return join(homedir(), '.config', 'evermore-profiler', 'reports')
}

export function defaultAppStoreData(): AppStoreData {
  return {
    last: null,
    usage: {},
    filterTerm: 'evermore',
    theme: 'light',
    intervalMs: 1000,
    reportsDir: defaultReportsDir(),
  }
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
  if (o['theme'] === 'dark' || o['theme'] === 'light') d.theme = o['theme']
  if (typeof o['intervalMs'] === 'number' && o['intervalMs'] >= 250 && o['intervalMs'] <= 10000) {
    d.intervalMs = Math.round(o['intervalMs'])
  }
  if (typeof o['reportsDir'] === 'string' && o['reportsDir'].trim()) {
    d.reportsDir = o['reportsDir'].trim()
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
  return join(homedir(), '.config', 'evermore-profiler', 'config.json')
}

/** Ruta vieja (pre-panel de config): se migra silenciosamente a config.json. */
export function legacyAppStorePath(): string {
  return join(homedir(), '.config', 'evermore-profiler', 'apps.json')
}

/** Store con persistencia. Carga al construir; select()/set() guardan enseguida. */
export class AppStore {
  private data_: AppStoreData

  constructor(
    private readonly path: string = appStorePath(),
    legacyPath: string = legacyAppStorePath(),
  ) {
    let json = ''
    try {
      json = readFileSync(this.path, 'utf8')
    } catch {
      // sin config.json: migrar del viejo apps.json si existe (mismos campos base)
      try {
        json = readFileSync(legacyPath, 'utf8')
      } catch {
        /* primera corrida: sin archivo */
      }
    }
    this.data_ = parseAppStore(json)
  }

  get data(): AppStoreData {
    return this.data_
  }

  select(pkg: string): void {
    this.data_ = recordSelection(this.data_, pkg)
    this.save()
  }

  /** Aplica un patch de configuración. Campo inválido ⇒ se ignora (queda el previo). */
  set(patch: ConfigPatch): void {
    const d = { ...this.data_ }
    if (typeof patch.filterTerm === 'string' && patch.filterTerm.trim()) {
      d.filterTerm = patch.filterTerm.trim()
    }
    if (patch.theme === 'light' || patch.theme === 'dark') d.theme = patch.theme
    if (
      typeof patch.intervalMs === 'number' &&
      patch.intervalMs >= 250 &&
      patch.intervalMs <= 10000
    ) {
      d.intervalMs = Math.round(patch.intervalMs)
    }
    if (typeof patch.reportsDir === 'string' && patch.reportsDir.trim()) {
      d.reportsDir = patch.reportsDir.trim()
    }
    this.data_ = d
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.data_, null, 2) + '\n')
    } catch {
      /* un disco que falla no debe romper el profiler */
    }
  }
}
