// Esquema genérico de log del profiler (ticket 027). Es el contrato entre la
// captura (logcat hoy, SDK dentro del juego mañana), el ring buffer, la
// persistencia NDJSON y el panel de logs (ticket 028). `source: 'game'` queda
// reservado para el SDK Unity futuro: se enchufa acá sin migración de esquema.

/** Niveles de logcat (V=verbose … F=fatal). El SDK del juego mapea a estos mismos. */
export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F'

export interface LogEntry {
  /** epoch ms del log (timestamp del device interpretado en la zona del host) */
  ts: number
  level: LogLevel
  /** tag de logcat (en Unity los Debug.Log/LogError salen por el tag "Unity") */
  tag: string
  message: string
  /** pid del proceso que emitió la línea */
  pid: number
  /** tid del thread emisor (threadtime lo trae; el SDK del juego puede omitirlo) */
  tid?: number
  /** de dónde vino: logcat del device, o el SDK dentro del juego (futuro) */
  source: 'logcat' | 'game'
  /** true si la entrada vino del buffer de crashes/ANR (stacktraces, am_anr) */
  isCrash?: boolean
}
