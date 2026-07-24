// Parser de `dumpsys meminfo <pkg>` → MemSample (ticket 021).
//
// Fuente primaria (confirmada en el device): bloque "App Summary" (estable API 24→36).
// Categorías: Java Heap / Native Heap / Code / Stack / Graphics / Private Other / System / TOTAL PSS.
// Los valores están en KB (primera columna = Pss(KB)); los devolvemos en MB.
//
// Fallback (research §1, NO implementado — este device tiene App Summary): si faltara,
// usar la fila TOTAL de la tabla detallada, col "Pss Total".
import type { MemSample } from '../schema'

const KB_TO_MB = 1 / 1024

/** Lee `<Label>:  <kb> [<rss>]` del App Summary. Toma la PRIMERA columna (Pss). */
function readSummaryKb(raw: string, label: string): number | null {
  // ej: "           Java Heap:    12940                          27356"
  const re = new RegExp(`^\\s*${label}:\\s+(\\d+)`, 'im')
  const m = raw.match(re)
  if (!m || m[1] === undefined) return null
  return Number(m[1])
}

const toMb = (kb: number | null): number | null => (kb === null ? null : kb * KB_TO_MB)

export function parseMeminfo(raw: string): MemSample {
  // Anclar al App Summary para no confundir con la tabla detallada (que también
  // tiene una fila "Stack" etc.). Si no está el bloque, todo N/A.
  const summaryIdx = raw.indexOf('App Summary')
  const summary = summaryIdx >= 0 ? raw.slice(summaryIdx) : ''

  const javaKb = readSummaryKb(summary, 'Java Heap')
  const nativeKb = readSummaryKb(summary, 'Native Heap')
  const codeKb = readSummaryKb(summary, 'Code')
  const stackKb = readSummaryKb(summary, 'Stack')
  const graphicsKb = readSummaryKb(summary, 'Graphics')
  const privateOtherKb = readSummaryKb(summary, 'Private Other')
  const systemKb = readSummaryKb(summary, 'System')

  // TOTAL PSS aparece como "TOTAL PSS:   926735" (o "TOTAL:" en dumps sin swap).
  let pssKb = readSummaryKb(summary, 'TOTAL PSS')
  if (pssKb === null) pssKb = readSummaryKb(summary, 'TOTAL')

  // Graphics=0 real ⇒ memtrack HAL ausente ⇒ N/A (research §1), no "0 MB".
  const graphics = graphicsKb && graphicsKb > 0 ? graphicsKb * KB_TO_MB : null

  // "other" agrega Private Other + System (todo lo no-categorizado del App Summary).
  const otherKb =
    privateOtherKb === null && systemKb === null ? null : (privateOtherKb ?? 0) + (systemKb ?? 0)

  return {
    pss: toMb(pssKb),
    rss: null, // RSS no sale de dumpsys: lo aporta el sampler desde /proc/<pid>/status
    java: toMb(javaKb),
    native: toMb(nativeKb),
    graphics,
    code: toMb(codeKb),
    stack: toMb(stackKb),
    other: toMb(otherKb),
  }
}

const MEM_KEYS = ['pss', 'rss', 'java', 'native', 'graphics', 'code', 'stack', 'other'] as const

/**
 * Suma los VmRSS (kB → MB) de una salida que puede concatenar varios
 * /proc/<pid>/status (main + hijos, del cat combinado del sampler).
 * Sin ninguna línea VmRSS ⇒ null (proceso muerto o /proc ilegible).
 */
export function parseVmRssMb(raw: string): number | null {
  let sumKb: number | null = null
  const re = /^VmRSS:\s*(\d+)\s*kB/gim
  for (const m of raw.matchAll(re)) {
    sumKb = (sumKb ?? 0) + Number(m[1])
  }
  return sumKb === null ? null : sumKb * KB_TO_MB
}

/**
 * Agrega los MemSample de los procesos de un package (main + hijos `pkg:*`).
 * Por categoría: suma de los no-null; todos null ⇒ null (conserva la convención N/A).
 */
export function mergeMemSamples(parts: MemSample[]): MemSample {
  const out = {} as Record<(typeof MEM_KEYS)[number], number | null>
  for (const k of MEM_KEYS) {
    let sum: number | null = null
    for (const p of parts) {
      const v = p[k]
      if (v !== null) sum = (sum ?? 0) + v
    }
    out[k] = sum
  }
  return out
}
