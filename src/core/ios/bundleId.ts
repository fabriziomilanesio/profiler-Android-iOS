// Validación de bundle ids de iOS — el gemelo de `isValidPackageName` para Android.
//
// Existe porque el validador de Android rechaza bundle ids legítimos: `PACKAGE_RE` no
// admite guiones, y en iOS son comunes (`LB-Software.PhotoEraser`, `com.apple.mobile-safari`).
// Con el validador de Android, elegir esas apps devolvía 400 desde el dashboard.
//
// El bundle id NO se interpola en ningún shell (viaja como argv a pymobiledevice3, y el
// filtro de sysmon lo recibe como valor), pero igual se valida: llega del device y del
// browser, y un id con espacios o metacaracteres no tiene por qué llegar más lejos.
export const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/

export function isValidBundleId(id: string): boolean {
  // Cota superior: los bundle ids reales no pasan de ~100 caracteres.
  return id.length <= 255 && BUNDLE_ID_RE.test(id)
}
