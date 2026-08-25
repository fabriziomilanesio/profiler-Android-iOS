// Puerta única a `pymobiledevice3` (ticket 035) — el `RealAdbTransport` del lado iOS.
// Nada fuera de `src/core/ios/` sabe que existe Python.
//
// Descubrimiento del intérprete, en orden:
//   1. el que se le pase por constructor (config explícita)
//   2. el venv gestionado en ~/.sample-profiler/pmd3-venv  ← lo que instala el spike
//      y lo que va a instalar el installer del ticket 041
//   3. `python3` del PATH
//
// El venv gestionado es el mismo patrón que `installPlatformTools` usa con adb: la tool
// se ocupa de su toolchain en vez de ensuciar el Python del sistema (y de paso esquiva
// PEP 668, que en Pythons de Homebrew rechaza `pip install --user`).
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { run, streamLines } from '../../runtime/spawn'
import type { AdbDevice } from '../adb/AdbTransport'
import { parseIosDevices } from './parseDevices'
import { parseIosProcesses, type IosProcess } from './deviceInfo'
import { parseIosSystem, type IosSystemInfo } from './parseSystem'
import { parseIosApps, type IosApp } from './parseApps'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Carpeta del venv gestionado, hermana de donde ya viven las sesiones.
 * En Windows el intérprete del venv vive en `Scripts\python.exe`; en POSIX, en `bin/python`.
 */
export function managedVenvPython(home: string = homedir(), os: string = platform()): string {
  const base = join(home, '.sample-profiler', 'pmd3-venv')
  return os === 'win32' ? join(base, 'Scripts', 'python.exe') : join(base, 'bin', 'python')
}

/**
 * Nombre del intérprete del sistema por OS.
 *
 * **En Windows NO existe `python3`**: el ejecutable se llama `python` (y el launcher, `py`).
 * Usar `python3` como fallback dejaba el camino iOS muerto en Windows sin ningún mensaje
 * útil — spawn fallaba con ENOENT y `isAvailable()` devolvía false, que se lee como
 * "pymobiledevice3 no está instalado" cuando el problema es otro.
 */
export function systemPython(os: string = platform()): string {
  return os === 'win32' ? 'python' : 'python3'
}

export function discoverPython(
  explicit?: string,
  exists: (p: string) => boolean = existsSync,
  os: string = platform(),
): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const venv = managedVenvPython(homedir(), os)
  if (exists(venv)) return venv
  return systemPython(os)
}

export class IosTransport {
  private readonly python: string

  constructor(python?: string) {
    this.python = discoverPython(python)
  }

  /** Qué intérprete quedó elegido — lo muestra el preflight. */
  get interpreter(): string {
    return this.python
  }

  /** false si no hay Python o `pymobiledevice3` no está instalado. */
  async isAvailable(): Promise<boolean> {
    try {
      const r = await run(this.python, ['-m', 'pymobiledevice3', 'version'], {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
      return r.exitCode === 0
    } catch {
      return false
    }
  }

  async version(): Promise<string> {
    const r = await run(this.python, ['-m', 'pymobiledevice3', 'version'], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    return r.stdout.trim()
  }

  /** iPhones/iPads conectados, ya deduplicados y con `platform: 'ios'`. */
  async devices(): Promise<AdbDevice[]> {
    try {
      const r = await run(this.python, ['-m', 'pymobiledevice3', 'usbmux', 'list'], {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
      if (r.exitCode !== 0) return []
      return parseIosDevices(r.stdout)
    } catch {
      // pymobiledevice3 ausente ⇒ simplemente no hay devices iOS; nunca rompe la lista
      // de Android, que es el camino que hoy funciona.
      return []
    }
  }

  /**
   * Procesos vivos del device (lockdown, sin DTX: no necesita levantar el túnel).
   * Es lo que permite resolver el nombre real del proceso de la app en vez de adivinarlo
   * desde el bundle id — ver `resolveIosProcess`.
   *
   * **`null` ≠ `[]`** (ticket 046): `[]` es "pregunté y la app no está corriendo"; `null` es
   * "no pude preguntar" (device desenchufado, lockdown caído, timeout). Devolver `[]` en el
   * segundo caso hacía que cada desconexión se reportara como muerte de la app. Es el mismo
   * contrato que `Sampler.refreshPid()` en Android, que devuelve `null` para no concluir nada.
   */
  async processes(serial: string): Promise<IosProcess[] | null> {
    try {
      const r = await run(this.python, ['-m', 'pymobiledevice3', 'processes', 'ps'], {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        env: { ...process.env, PYMOBILEDEVICE3_UDID: serial },
      })
      if (r.exitCode !== 0) return null
      return parseIosProcesses(r.stdout)
    } catch {
      return null
    }
  }

  /**
   * Apps instaladas — lo que llena el selector del dashboard en iOS.
   *
   * Va por lockdown (installation_proxy), NO por DVT: 2,5 s contra el iPhone de prueba,
   * frente a los ~15 s de cualquier comando que tenga que levantar el túnel. El timeout es
   * generoso igual porque la salida es grande (1,9 MB para 60 apps: el Info.plist de cada
   * una) y un device con muchas apps tarda más.
   */
  async apps(serial: string, opts: { includeSystem?: boolean } = {}): Promise<IosApp[]> {
    try {
      const args = ['-m', 'pymobiledevice3', 'apps', 'list']
      // El filtro se pide al device en vez de traer todo y descartar acá: menos de la mitad
      // de bytes por el cable.
      if (!opts.includeSystem) args.push('-t', 'User')
      const r = await run(this.python, args, {
        timeoutMs: 120_000,
        env: { ...process.env, PYMOBILEDEVICE3_UDID: serial },
      })
      if (r.exitCode !== 0) return []
      return parseIosApps(r.stdout, opts)
    } catch {
      return []
    }
  }

  /**
   * CFBundleExecutable de UNA app — el nombre con el que su proceso aparece en sysmontap.
   *
   * Se consulta puntual (`apps query`, ~2 s por lockdown) en vez de reusar `apps()`, que
   * trae el Info.plist de todas las apps (1,9 MB): al elegir una app sólo hace falta la
   * suya. null si no se pudo resolver — el caller cae a la heurística del bundle id.
   */
  async appExecutable(serial: string, bundleId: string): Promise<string | null> {
    try {
      const r = await run(this.python, ['-m', 'pymobiledevice3', 'apps', 'query', bundleId], {
        timeoutMs: 60_000,
        env: { ...process.env, PYMOBILEDEVICE3_UDID: serial },
      })
      if (r.exitCode !== 0) return null
      // includeSystem: una app del sistema también tiene que poder perfilarse si el QA la elige
      const apps = parseIosApps(r.stdout, { includeSystem: true })
      return apps.find((a) => a.id === bundleId)?.executable ?? null
    } catch {
      return null
    }
  }

  /**
   * Datos del DEVICE (RAM total, cores). Es una foto, no un stream: el comando toma una
   * muestra y sale. Se pide UNA vez al enganchar porque cada invocación paga el handshake
   * del túnel (decenas de segundos) — pedirla por tick sería impagable, y el total de RAM
   * no cambia.
   */
  async systemInfo(serial: string): Promise<IosSystemInfo> {
    try {
      const r = await run(
        this.python,
        ['-m', 'pymobiledevice3', 'developer', 'dvt', 'sysmon', 'system'],
        {
          timeoutMs: 120_000,
          env: { ...process.env, PYMOBILEDEVICE3_UDID: serial, PYTHONUNBUFFERED: '1' },
        },
      )
      return parseIosSystem(r.stdout)
    } catch {
      return { ramTotalMb: null, cores: null }
    }
  }

  /**
   * Comando largo de pymobiledevice3, línea a línea. Es el `streamShell()` de iOS: el
   * túnel userspace vive DENTRO de este proceso hijo (hallazgo del spike 033), así que el
   * stream tiene que quedar vivo toda la sesión — arrancarlo por tick sería pagar decenas
   * de segundos de handshake cada vez.
   *
   * El UDID va SIEMPRE por env: con dos devices conectados (o el mismo por USB y wifi)
   * pymobiledevice3 aborta pidiendo desambiguar.
   */
  stream(
    serial: string,
    args: string[],
    onLine: (line: string) => void,
    onExit?: (err: Error | null) => void,
  ): () => void {
    return streamLines(this.python, ['-m', 'pymobiledevice3', ...args], onLine, onExit, {
      env: {
        ...process.env,
        PYMOBILEDEVICE3_UDID: serial,
        // Sin esto Python bufferea stdout por bloques al escribir a un pipe y las
        // muestras llegan a los tirones (o no llegan): el canal de sysmon estuvo mudo
        // 2 minutos enteros hasta encontrarlo. Para un consumidor en streaming, el
        // buffer de bloque es siempre el enemigo.
        PYTHONUNBUFFERED: '1',
      },
    })
  }
}
