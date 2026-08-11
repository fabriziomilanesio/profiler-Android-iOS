// Tests del parser de os_log (ticket 039), contra líneas REALES capturadas del
// iPhone15,3 con iOS 26.5.2.
import { describe, expect, test } from 'bun:test'
import { isFromPid, parseSyslogLine } from './parseSyslog'

const REAL =
  '2026-08-10 17:51:15.627744 backboardd{BackBoardHIDEventProcessors}[33283] <DEBUG>: Motion event usagePage:0xFF0C usage:1'

describe('parseSyslogLine', () => {
  test('parsea una línea real completa', () => {
    const e = parseSyslogLine(REAL)
    expect(e).not.toBeNull()
    expect(e?.pid).toBe(33283)
    expect(e?.level).toBe('D')
    expect(e?.tag).toBe('BackBoardHIDEventProcessors')
    expect(e?.message).toBe('Motion event usagePage:0xFF0C usage:1')
    expect(e?.source).toBe('logcat')
  })

  test('sin imagen entre llaves, el tag cae al nombre del proceso', () => {
    const e = parseSyslogLine('2026-08-10 17:51:15.611924 audioclocksyncd[33357] <ERROR>: falló')
    expect(e?.tag).toBe('audioclocksyncd')
    expect(e?.level).toBe('E')
  })

  test('mapea los niveles de os_log que logcat no tiene', () => {
    // La traducción es por SEVERIDAD, que es lo que filtran los chips del panel.
    const lvl = (l: string): string | undefined =>
      parseSyslogLine(`2026-08-10 10:00:00.0 p[1] <${l}>: x`)?.level
    expect(lvl('Notice')).toBe('I') // el default ruidoso de la plataforma
    expect(lvl('Fault')).toBe('F') // junto a los crashes
    expect(lvl('Warning')).toBe('W')
    expect(lvl('Debug')).toBe('D')
  })

  test('un nivel desconocido cae a Info en vez de descartar la línea', () => {
    expect(parseSyslogLine('2026-08-10 10:00:00.0 p[1] <Rarísimo>: x')?.level).toBe('I')
  })

  test('el timestamp se interpreta en la zona del host, como logcat', () => {
    const e = parseSyslogLine('2026-08-10 17:51:15.627744 p[1] <INFO>: x')
    expect(e?.ts).toBe(new Date(2026, 7, 10, 17, 51, 15, 627).getTime())
  })

  test('mensaje vacío no rompe', () => {
    expect(parseSyslogLine('2026-08-10 10:00:00.0 p[1] <INFO>:')?.message).toBe('')
  })

  test('mensaje con llaves y corchetes adentro se conserva entero', () => {
    const e = parseSyslogLine('2026-08-10 10:00:00.0 p{img}[1] <INFO>: {"a":[1,2]} listo')
    expect(e?.message).toBe('{"a":[1,2]} listo')
  })

  test('ignora lo que no es una línea de log', () => {
    expect(parseSyslogLine('')).toBeNull()
    expect(parseSyslogLine('WARNING Trying again over a no-root userspace tunnel')).toBeNull()
    expect(parseSyslogLine('    continuación de un mensaje multi-línea')).toBeNull()
    expect(parseSyslogLine('2026-13-45 99:99:99 p[1] <INFO>: fecha inválida')).toBeNull()
  })
})

describe('isFromPid', () => {
  test('filtra por el pid que ya resolvió el server', () => {
    const e = parseSyslogLine(REAL)!
    expect(isFromPid(e, 33283)).toBe(true)
    expect(isFromPid(e, 999)).toBe(false)
  })

  test('sin pid conocido no deja pasar nada', () => {
    // Con la app cerrada es preferible un panel vacío a volcar el syslog entero del
    // device, que son cientos de líneas por segundo de daemons del sistema.
    expect(isFromPid(parseSyslogLine(REAL)!, null)).toBe(false)
  })
})
