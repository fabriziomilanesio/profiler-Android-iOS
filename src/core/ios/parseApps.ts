// Apps instaladas en un iPhone — el equivalente iOS de `pm list packages`.
//
// Fuente: `pymobiledevice3 apps list -t User`, que va por lockdown (installation_proxy) y
// NO necesita el túnel: 2,5 s contra el iPhone de prueba, frente a los ~15 s que cuesta
// cualquier comando DVT. Por eso el selector no usa el `applist` de instruments.
//
// La salida es un objeto { bundleId: Info.plist completo }, y pesa lo que pesa: 1,9 MB
// para 60 apps de usuario (el plist entero de cada una, íconos y tipos de documento
// incluidos). Acá se descarta todo salvo lo que el selector necesita.
import { isValidBundleId } from './bundleId'

export interface IosApp {
  /** bundle id — el identificador que viaja al resto del sistema */
  id: string
  /** nombre visible (CFBundleDisplayName), con el bundle id como fallback */
  label: string
  /**
   * CFBundleExecutable: el nombre del binario, que es EXACTAMENTE como aparece el proceso
   * en sysmontap. Es el dato que evita adivinar el nombre del proceso desde el bundle id —
   * `com.github.stormbreaker.prod` corre como `GitHub`, no como `prod`.
   */
  executable: string | null
}

/**
 * Parsea la salida de `apps list`. Función pura y defensiva: cualquier entrada rara se
 * saltea en vez de tirar, porque esto corre contra el device de un tercero.
 *
 * `onlyUser` filtra por ApplicationType — el comando ya se invoca con `-t User`, pero la
 * salida igual trae el campo y un device viejo podría ignorar el filtro.
 */
export function parseIosApps(stdout: string, opts: { includeSystem?: boolean } = {}): IosApp[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return []
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []

  const apps: IosApp[] = []
  for (const [bundleId, value] of Object.entries(raw as Record<string, unknown>)) {
    // El bundle id se valida igual que un package de Android: llega del device y termina
    // viajando como argumento de un comando.
    if (!isValidBundleId(bundleId)) continue
    const info = (value ?? {}) as Record<string, unknown>
    if (!opts.includeSystem) {
      const type = info['ApplicationType']
      // Sin campo se asume User: mejor mostrar de más en el selector que esconder la app
      // que el QA vino a medir.
      if (typeof type === 'string' && type !== 'User') continue
    }
    const display = info['CFBundleDisplayName'] ?? info['CFBundleName']
    const exec = info['CFBundleExecutable']
    apps.push({
      id: bundleId,
      label: typeof display === 'string' && display !== '' ? display : bundleId,
      executable: typeof exec === 'string' && exec !== '' ? exec : null,
    })
  }
  // Por nombre visible: el QA busca "Sample", no "com.samplegames…".
  //
  // Comparación en minúsculas y sin `localeCompare`: el orden de localeCompare depende del
  // locale del host (con el de esta máquina, "com.pelado.app" cae antes que "Sample"),
  // y un orden que cambia entre la máquina del QA y la de CI vuelve el test no portable.
  return apps.sort((a, b) => {
    const x = a.label.toLowerCase()
    const y = b.label.toLowerCase()
    if (x < y) return -1
    if (x > y) return 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}
