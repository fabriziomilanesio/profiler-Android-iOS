// Parser de `pymobiledevice3 syslog live` (ticket 039): traduce os_log al mismo
// `LogEntry` que usa logcat, para que TODO lo de arriba se reuse sin tocar — ring de 50k
// (027), panel con filtros (028), export .txt/.jsonl (029) y marcas de crash sobre el
// timeline del reporte (030).
//
// Formato observado en el device real (iPhone15,3 / iOS 26.5.2):
//
//   2026-08-10 17:51:15.627744 backboardd{BackBoardHIDEventProcessors}[33283] <DEBUG>: mensaje
//   └── timestamp        └── proceso  └── imagen (opcional)  └── pid  └── nivel   └── mensaje
import type { LogEntry, LogLevel } from '../logs/logEntry'

/**
 * Mapeo de niveles de os_log a los de logcat.
 *
 * Los niveles no coinciden y la traducción es una decisión, no un hecho: os_log tiene
 * `Notice` (el default de la plataforma, ruidoso) y `Fault`, que logcat no tiene. Se
 * eligen los equivalentes por SEVERIDAD, que es lo que filtran los chips del panel del
 * ticket 028 — `Notice` cae en Info y `Fault` en Fatal, junto a los crashes.
 */
const LEVELS: Record<string, LogLevel> = {
  DEBUG: 'D',
  INFO: 'I',
  NOTICE: 'I',
  DEFAULT: 'I',
  WARNING: 'W',
  WARN: 'W',
  ERROR: 'E',
  FAULT: 'F',
  CRITICAL: 'F',
}

// `proceso{imagen}[pid] <NIVEL>: mensaje` — la imagen entre llaves es opcional.
// El nivel se captura como `[^>]+` y no como `\w+`: `\w` es ASCII en JS y una etiqueta
// con acento o localizada haría fallar la línea ENTERA, perdiendo el log en vez de sólo
// el nivel. Un nivel desconocido cae a Info; una línea perdida no se recupera.
const LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\S+?)(?:\{([^}]*)\})?\[(\d+)\]\s+<([^>]+)>:\s?([\s\S]*)$/

/**
 * Parsea una línea de syslog. null si no matchea (banners del túnel, líneas de
 * continuación de un mensaje multi-línea, basura).
 *
 * El timestamp del device NO trae zona horaria — igual que en logcat — así que se
 * interpreta en la zona del host, que es la misma convención que ya usa `parseLogcat`.
 */
export function parseSyslogLine(
  line: string,
  source: 'logcat' | 'game' = 'logcat',
): LogEntry | null {
  const m = LINE.exec(line)
  if (m === null) return null
  const [, rawTs, process, image, rawPid, rawLevel, message] = m

  const ts = Date.parse((rawTs as string).replace(' ', 'T'))
  if (Number.isNaN(ts)) return null

  return {
    ts,
    level: LEVELS[(rawLevel as string).toUpperCase()] ?? 'I',
    // El "tag" de logcat no tiene equivalente exacto: lo más cercano es la imagen
    // (subsistema) y, si no vino, el nombre del proceso. Es lo que el panel muestra
    // como origen de la línea.
    tag: image !== undefined && image !== '' ? image : (process as string),
    message: message ?? '',
    pid: Number(rawPid),
    source,
  }
}

/**
 * ¿La línea pertenece al proceso de la app?
 *
 * `syslog live --process-name` filtra del lado del device, pero el nombre tiene que ser
 * exacto; acá se filtra del lado del host por pid, que es lo que el server ya resolvió y
 * no depende de coincidencias de nombre.
 */
export function isFromPid(entry: LogEntry, pid: number | null): boolean {
  return pid !== null && entry.pid === pid
}
