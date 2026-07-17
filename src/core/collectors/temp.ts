// Parser de temperatura (ticket 021).
//
// Fuente primaria (confirmada): `dumpsys thermalservice` → bloque
// "Current temperatures from HAL", líneas `Temperature{mValue=..,mType=..,mName=..}`.
// Mapear por mType (no por mName, que es del OEM): 0=CPU/AP, 2=BAT, 3=SKIN.
// Reportamos CPU(AP) = mType 0 como temp principal.
//
// Fallback (research §4, NO implementado acá): /sys/class/thermal/* → dumpsys battery temp.

/** °C del sensor mType dado dentro del bloque "Current ... from HAL". null si no está. */
function tempOfType(raw: string, mType: number): number | null {
  // Preferir el bloque "Current temperatures from HAL" (valores en vivo);
  // si no está, usar todo el dump.
  const halIdx = raw.indexOf('Current temperatures from HAL')
  const block = halIdx >= 0 ? raw.slice(halIdx) : raw
  // Cortar el bloque en la siguiente sección para no leer thresholds/cached.
  const end = block.indexOf('Current cooling devices')
  const scope = end >= 0 ? block.slice(0, end) : block

  const re = new RegExp(`Temperature\\{mValue=(-?[\\d.]+),\\s*mType=${mType}\\b`, 'g')
  let best: number | null = null
  for (const m of scope.matchAll(re)) {
    const v = Number(m[1])
    if (!Number.isFinite(v)) continue
    // algunos OEM emiten sensores duplicados con 0.0 (ej. SUBBAT); quedarse con el mayor real
    if (best === null || v > best) best = v
  }
  return best
}

/** Temperatura principal (CPU/AP, mType 0) en °C. null si el HAL no la expone. */
export function parseTemp(raw: string): number | null {
  const cpu = tempOfType(raw, 0)
  if (cpu !== null) return cpu
  // sin CPU/AP: degradar a SKIN (mType 3) como aproximación
  return tempOfType(raw, 3)
}
