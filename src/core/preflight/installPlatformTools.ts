// Instalación de platform-tools oficiales de Google (ticket 013): descarga el
// zip a ~/.evermore-profiler/, descomprime (el zip trae la carpeta
// `platform-tools/` adentro) y devuelve la ruta del adb resultante.
//
// La orquestación es pura respecto a I/O: downloader/unzipper/fs van inyectados
// (InstallDeps) para testear con mocks. Las implementaciones reales de abajo usan:
//   - fetch (estándar, existe en Bun y Node ≥18) para la descarga,
//   - node:fs/promises para escribir/mkdir/rm (soportado por Bun y Node),
//   - `unzip` del sistema vía runtime/spawn para descomprimir.
//
// ⚠ Dependencia de sistema documentada: la extracción shell-outea a `unzip -o`
// (presente out-of-the-box en macOS y en la mayoría de los Linux). En Windows
// usa `tar -xf`, que desde Windows 10 es bsdtar y soporta zip nativamente.

import { run } from '../../runtime/spawn'

export interface Downloader {
  /** Baja `url` al archivo `destFile`. `onProgress` recibe bytes recibidos / total (null si no hay Content-Length). */
  download(
    url: string,
    destFile: string,
    onProgress?: (receivedBytes: number, totalBytes: number | null) => void,
  ): Promise<void>
}

export interface Unzipper {
  /** Extrae `zipFile` dentro de `destDir` (preservando permisos de ejecución). */
  extract(zipFile: string, destDir: string): Promise<void>
}

export interface InstallDeps {
  downloader: Downloader
  unzipper: Unzipper
  /** mkdir -p */
  mkdir: (dir: string) => Promise<void>
  /** borra un archivo (cleanup del zip); best-effort */
  rm: (file: string) => Promise<void>
}

export interface InstallOptions {
  /** valor estilo process.platform */
  platform: string
  /** home del usuario (os.homedir() en producción) */
  homeDir: string
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void
}

const REPO_BASE = 'https://dl.google.com/android/repository'

/** URL oficial del zip de platform-tools por OS. */
export function platformToolsUrl(platform: string): string {
  const suffix = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform]
  if (!suffix) throw new Error(`No hay platform-tools de Google para '${platform}'`)
  return `${REPO_BASE}/platform-tools-latest-${suffix}.zip`
}

/**
 * Descarga y descomprime platform-tools en `<home>/.evermore-profiler/`.
 * Devuelve la ruta absoluta del adb instalado.
 */
export async function installPlatformTools(
  opts: InstallOptions,
  deps: InstallDeps,
): Promise<string> {
  const isWin = opts.platform === 'win32'
  const sep = isWin ? '\\' : '/'
  const baseDir = `${opts.homeDir}${sep}.evermore-profiler`
  const zipFile = `${baseDir}${sep}platform-tools.zip`
  const adbPath = `${baseDir}${sep}platform-tools${sep}${isWin ? 'adb.exe' : 'adb'}`

  await deps.mkdir(baseDir)
  await deps.downloader.download(platformToolsUrl(opts.platform), zipFile, opts.onProgress)
  // el zip contiene `platform-tools/…`, así que extraer en baseDir deja
  // `<base>/platform-tools/adb` listo.
  await deps.unzipper.extract(zipFile, baseDir)
  await deps.rm(zipFile).catch(() => {})
  return adbPath
}

// ---------------------------------------------------------------------------
// Implementaciones reales (composición: las usa el CLI; los tests usan mocks).
// ---------------------------------------------------------------------------

/** Downloader real con fetch estándar, streaming a disco con progreso. */
export const fetchDownloader: Downloader = {
  async download(url, destFile, onProgress) {
    const { open } = await import('node:fs/promises')
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`Descarga falló: ${url} → HTTP ${response.status}`)
    }
    const contentLength = response.headers.get('content-length')
    const total = contentLength ? Number(contentLength) : null
    const file = await open(destFile, 'w')
    try {
      const reader = response.body.getReader()
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await file.write(value)
        received += value.byteLength
        onProgress?.(received, total)
      }
    } finally {
      await file.close()
    }
  },
}

/**
 * Unzipper real: shell-out vía runtime/spawn. `unzip -o` en macOS/Linux
 * (preserva el bit de ejecución de adb); `tar -xf` (bsdtar) en Windows.
 */
export const systemUnzipper: Unzipper = {
  async extract(zipFile, destDir) {
    const cmd =
      process.platform === 'win32'
        ? { bin: 'tar', args: ['-xf', zipFile, '-C', destDir] }
        : { bin: 'unzip', args: ['-o', '-q', zipFile, '-d', destDir] }
    const result = await run(cmd.bin, cmd.args, { timeoutMs: 120_000 })
    if (result.exitCode !== 0) {
      throw new Error(
        `'${cmd.bin}' falló extrayendo ${zipFile} (exit ${result.exitCode}): ${result.stderr.trim()}`,
      )
    }
  },
}

/** InstallDeps reales para el CLI. */
export async function realInstallDeps(): Promise<InstallDeps> {
  const { mkdir, rm } = await import('node:fs/promises')
  return {
    downloader: fetchDownloader,
    unzipper: systemUnzipper,
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true })
    },
    rm: async (file) => {
      await rm(file, { force: true })
    },
  }
}
