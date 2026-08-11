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
import { isValidBundleId } from './ios/bundleId'

/**
 * ¿Es un identificador de app válido, de cualquiera de las dos plataformas?
 *
 * El store no sabe de qué device viene cada entrada del ranking (guarda apps de todos los
 * teléfonos que se usaron), así que acepta ambas formas. Con la validación de Android sola,
 * un bundle id con guión se descartaba en silencio al releer el archivo: la app elegida
 * desaparecía del ranking en el siguiente arranque.
 */
function isValidAppId(id: string): boolean {
  return isValidPackageName(id) || isValidBundleId(id)
}

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
  /**
   * true ⇒ el intervalo del carril rápido lo decide el device (ticket 023):
   * gama baja (< 4 GB de RAM) → 2 s, resto → 1 s. Setear intervalMs a mano
   * (panel o PUT /api/config) lo pasa a manual.
   */
  intervalAuto: boolean
  /** carpeta donde se guarda la copia de cada reporte exportado. */
  reportsDir: string
  /**
   * Target de FPS del semáforo (ticket 025): verde ≥ target · amarillo ≥ 80% ·
   * rojo abajo. Default 30 (gama baja donde testea Evermore). Aplica en caliente
   * desde el panel de config; el reporte (026) declara el target usado.
   */
  fpsTarget: number
}

/** Campos que el panel de configuración puede escribir (PUT /api/config). */
export type ConfigPatch = Partial<
  Pick<
    AppStoreData,
    'filterTerm' | 'theme' | 'intervalMs' | 'intervalAuto' | 'reportsDir' | 'fpsTarget'
  >
>

/** Umbral de gama baja para el intervalo auto (MB de RAM del device). */
export const LOW_RAM_MB = 4096

/** Rango sano del target de FPS (paneles reales van de ~24 a 240 Hz). */
export const FPS_TARGET_MIN = 1
export const FPS_TARGET_MAX = 240

function isValidFpsTarget(v: unknown): v is number {
  return typeof v === 'number' && v >= FPS_TARGET_MIN && v <= FPS_TARGET_MAX
}

/**
 * Intervalo default del sampling según el device (modo auto). El SM-A155M (3.7 GB)
 * cae en 2 s: a 1 s el loop de shells le robaba CPU al juego (ticket 023).
 * Sin device todavía (modo espera) ⇒ 1 s.
 */
export function autoIntervalMs(ramTotalMb: number | null): number {
  return ramTotalMb !== null && ramTotalMb < LOW_RAM_MB ? 2000 : 1000
}

export function defaultReportsDir(): string {
  return join(homedir(), '.config', 'evermore-profiler', 'reports')
}

export function defaultAppStoreData(): AppStoreData {
  return {
    last: null,
    usage: {},
    filterTerm: 'evermore',
    // dark protagonista desde el rediseño del dashboard (tickets 031/032)
    theme: 'dark',
    intervalMs: 1000,
    intervalAuto: true,
    reportsDir: defaultReportsDir(),
    fpsTarget: 30,
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
  if (typeof o['last'] === 'string' && isValidAppId(o['last'])) d.last = o['last']
  if (typeof o['usage'] === 'object' && o['usage'] !== null) {
    for (const [pkg, count] of Object.entries(o['usage'] as Record<string, unknown>)) {
      if (isValidAppId(pkg) && typeof count === 'number' && count > 0) {
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
  // Migración de configs pre-023 (sin el campo): un intervalMs distinto del default
  // solo pudo salir del panel ⇒ manual; el default 1000 se asume nunca tocado ⇒ auto.
  d.intervalAuto =
    typeof o['intervalAuto'] === 'boolean' ? o['intervalAuto'] : d.intervalMs === 1000
  if (typeof o['reportsDir'] === 'string' && o['reportsDir'].trim()) {
    d.reportsDir = o['reportsDir'].trim()
  }
  // ticket 025: configs pre-025 (sin el campo) migran solas al default 30
  if (isValidFpsTarget(o['fpsTarget'])) d.fpsTarget = Math.round(o['fpsTarget'])
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
    if (patch.intervalAuto === true) d.intervalAuto = true
    if (
      typeof patch.intervalMs === 'number' &&
      patch.intervalMs >= 250 &&
      patch.intervalMs <= 10000
    ) {
      d.intervalMs = Math.round(patch.intervalMs)
      d.intervalAuto = false // elegir un intervalo concreto apaga el modo auto
    }
    if (typeof patch.reportsDir === 'string' && patch.reportsDir.trim()) {
      d.reportsDir = patch.reportsDir.trim()
    }
    if (isValidFpsTarget(patch.fpsTarget)) d.fpsTarget = Math.round(patch.fpsTarget)
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
