// Lista de apps instaladas en el device vía `pm list packages` (selector de apps
// del dashboard). Solo bundle IDs — sin labels ni íconos: resolver el nombre
// visible cuesta un dumpsys por package y acá alcanza con el package name.
//
// Costura respetada: adb solo por AdbTransport.
import type { AdbTransport } from './AdbTransport'
import { isValidPackageName } from './packageName'

/** Parsea el output de `pm list packages` ("package:com.foo.bar" por línea). Función pura. */
export function parsePackageList(raw: string): string[] {
  const pkgs: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('package:')) continue
    const name = trimmed.slice('package:'.length).trim()
    // el output del device es input no confiable: solo package names bien formados
    if (name && isValidPackageName(name)) pkgs.push(name)
  }
  return pkgs.sort()
}

export interface ListPackagesOptions {
  /** incluir apps de sistema (default: solo terceros, `-3` — ~30-80 en vez de 300+). */
  includeSystem?: boolean
}

/** Lista packages instalados. Best-effort: transporte caído ⇒ lista vacía. */
export async function listPackages(
  transport: AdbTransport,
  serial: string,
  opts: ListPackagesOptions,
): Promise<string[]> {
  const cmd = opts.includeSystem ? 'pm list packages' : 'pm list packages -3'
  try {
    const r = await transport.shell(serial, cmd)
    return parsePackageList(r.stdout)
  } catch {
    return []
  }
}
