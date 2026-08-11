// Parser del canal `sysmontap` (ticket 038): CPU y memoria del proceso de la app.
//
// A diferencia de `graphics`, que emite un JSON por línea, `sysmon process monitor process`
// imprime **JSON pretty multi-línea** — el research 044 daba por sentado que todo era
// JSON-lines y el spike lo desmintió. Por eso hace falta ensamblar bloques por llaves
// balanceadas en vez de parsear línea a línea.
//
// El stream además arranca con un banner (`Monitoring pid=… name=…`) que no es JSON.

/** Muestra de un proceso. Memoria ya convertida a MB (el device la manda en bytes). */
export interface IosProcessSample {
  pid: number | null
  name: string | null
  /**
   * CPU del proceso en PORCENTAJE. Verificado contra el device: valores de hasta 52 con
   * el juego corriendo, así que no es una fracción 0-1. Es la misma unidad que el
   * share-of-device de Android, por eso comparten clave de comparabilidad.
   */
  cpuUsage: number | null
  /** `physFootprint` en MB — lo que Apple le cobra a la app y lo que mira el jetsam. */
  footprintMb: number | null
  /** `memResidentSize` en MB. */
  residentMb: number | null
  /**
   * `memCompressed` en MB — páginas comprimidas, YA incluidas en el footprint. Es la
   * señal de presión de memoria: en evermorearcade fueron 578 MB de 1023 MB de footprint.
   */
  compressedMb: number | null
  /** proxy de consumo energético del proceso; no tiene equivalente en Android. */
  powerScore: number | null
  threadCount: number | null
}

const BYTES_TO_MB = 1 / (1024 * 1024)

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function mb(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * BYTES_TO_MB
}

export function toProcessSample(obj: Record<string, unknown>): IosProcessSample {
  return {
    pid: num(obj['pid']),
    name: typeof obj['name'] === 'string' ? obj['name'] : null,
    cpuUsage: num(obj['cpuUsage']),
    footprintMb: mb(obj['physFootprint']),
    residentMb: mb(obj['memResidentSize']),
    compressedMb: mb(obj['memCompressed']),
    powerScore: num(obj['powerScore']),
    threadCount: num(obj['threadCount']),
  }
}

/**
 * Ensambla bloques JSON pretty que llegan repartidos en líneas sueltas.
 *
 * Se usa desde el stream: cada línea entra por `push()` y devuelve una muestra cuando el
 * bloque cerró. Las líneas que no son parte de un bloque (el banner `Monitoring pid=…`,
 * warnings del túnel) se ignoran sin romper el estado.
 */
export class SysmonAssembler {
  private buffer: string[] = []
  private depth = 0

  push(line: string): IosProcessSample | null {
    const opens = countOutsideStrings(line, '{')
    const closes = countOutsideStrings(line, '}')

    // Fuera de un bloque, sólo interesa la línea que lo abre.
    if (this.depth === 0 && opens === 0) return null

    this.buffer.push(line)
    this.depth += opens - closes

    if (this.depth > 0) return null

    const text = this.buffer.join('\n')
    this.buffer = []
    this.depth = 0
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      return toProcessSample(obj)
    } catch {
      // Bloque corrupto (stream cortado a la mitad): se descarta y se sigue, igual que
      // hacen los parsers de Android con un dump incompleto.
      return null
    }
  }
}

/**
 * Cuenta llaves ignorando las que estén dentro de un string JSON. Sin esto, un nombre de
 * proceso con `{` desbalancea el ensamblado y el stream se rompe para siempre.
 */
function countOutsideStrings(line: string, char: '{' | '}'): number {
  let count = 0
  let inString = false
  let escaped = false
  for (const c of line) {
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (!inString && c === char) count += 1
  }
  return count
}
