// Resolución de la ruta del binario adb (ticket 013). Función PURA: recibe
// platform/env/fs-checker inyectados para poder testearla sin tocar el FS real.
// El orden de búsqueda es contrato: config explícita → PATH → SDK típico → managed.

export type AdbSource = 'config' | 'path' | 'sdk' | 'managed'

export interface AdbDiscovery {
  path: string
  /** de dónde salió: config explícita, PATH, ruta típica del SDK, o el que instala la tool */
  source: AdbSource
}

export interface DiscoverAdbOptions {
  /** valor estilo process.platform: 'darwin' | 'win32' | 'linux' | ... */
  platform: string
  /** estilo process.env (en Windows las keys reales suelen ser 'Path', 'LOCALAPPDATA', 'USERPROFILE') */
  env: Record<string, string | undefined>
  /** fs-checker inyectado: ¿existe y es ejecutable? */
  isExecutable: (path: string) => boolean
  /** (a) path explícito configurado por el usuario */
  configPath?: string
}

const MANAGED_DIR = '.evermore-profiler'

function envCaseInsensitive(env: DiscoverAdbOptions['env'], name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const lower = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key]
  }
  return undefined
}

function homeDir(opts: DiscoverAdbOptions): string | undefined {
  return opts.platform === 'win32'
    ? envCaseInsensitive(opts.env, 'USERPROFILE')
    : envCaseInsensitive(opts.env, 'HOME')
}

/** Candidatos de rutas típicas del SDK por OS (c). */
function sdkCandidates(opts: DiscoverAdbOptions): string[] {
  const home = homeDir(opts)
  switch (opts.platform) {
    case 'darwin':
      return home ? [`${home}/Library/Android/sdk/platform-tools/adb`] : []
    case 'win32': {
      const localAppData = envCaseInsensitive(opts.env, 'LOCALAPPDATA')
      return localAppData ? [`${localAppData}\\Android\\Sdk\\platform-tools\\adb.exe`] : []
    }
    default:
      // Linux y resto de unixes
      return home ? [`${home}/Android/Sdk/platform-tools/adb`] : []
  }
}

/** (d) el adb que instala la propia tool (installPlatformTools). */
function managedCandidate(opts: DiscoverAdbOptions): string | undefined {
  const home = homeDir(opts)
  if (!home) return undefined
  return opts.platform === 'win32'
    ? `${home}\\${MANAGED_DIR}\\platform-tools\\adb.exe`
    : `${home}/${MANAGED_DIR}/platform-tools/adb`
}

/** (b) recorre los dirs de PATH en orden. */
function pathCandidates(opts: DiscoverAdbOptions): string[] {
  const isWin = opts.platform === 'win32'
  const raw = envCaseInsensitive(opts.env, isWin ? 'Path' : 'PATH')
  if (!raw) return []
  const separator = isWin ? ';' : ':'
  const binary = isWin ? 'adb.exe' : 'adb'
  const joiner = isWin ? '\\' : '/'
  return raw
    .split(separator)
    .filter((dir) => dir.length > 0)
    .map((dir) => `${dir.replace(new RegExp(`\\${joiner}+$`), '')}${joiner}${binary}`)
}

/**
 * Resuelve la ruta de adb en orden: (a) config → (b) PATH → (c) SDK típico del
 * OS → (d) platform-tools instalados por la tool. Devuelve null si no hay adb.
 */
export function discoverAdb(opts: DiscoverAdbOptions): AdbDiscovery | null {
  // (a) config explícita
  if (opts.configPath && opts.isExecutable(opts.configPath)) {
    return { path: opts.configPath, source: 'config' }
  }

  // (b) PATH
  for (const candidate of pathCandidates(opts)) {
    if (opts.isExecutable(candidate)) return { path: candidate, source: 'path' }
  }

  // (c) rutas típicas del SDK
  for (const candidate of sdkCandidates(opts)) {
    if (opts.isExecutable(candidate)) return { path: candidate, source: 'sdk' }
  }

  // (d) el que instala la tool
  const managed = managedCandidate(opts)
  if (managed && opts.isExecutable(managed)) return { path: managed, source: 'managed' }

  return null
}
