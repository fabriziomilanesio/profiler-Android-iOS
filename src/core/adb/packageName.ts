// Validación compartida de package names. Los packages viajan interpolados a
// `adb shell` (que pasa por el sh del device): validar acá corta cualquier
// inyección de comandos — vale tanto para --package del CLI como para el
// package que llega del dashboard vía POST /api/app (input hostil).
export const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

export function isValidPackageName(pkg: string): boolean {
  return PACKAGE_RE.test(pkg)
}
