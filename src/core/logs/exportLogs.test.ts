// Tests de los serializadores puros del export de logs (ticket 029).
import { describe, expect, test } from 'bun:test'
import type { LogEntry } from './logEntry'
import {
  formatLogTime,
  logsExportFilename,
  parseExportEntries,
  serializeLogsJsonl,
  serializeLogsTxt,
} from './exportLogs'

// timestamp fijo construido en hora LOCAL: formatLogTime usa la zona del host
const TS = new Date(2026, 6, 31, 10, 15, 2, 87).getTime()

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  ts: TS,
  level: 'I',
  tag: 'Unity',
  message: 'Loading scene "MainMenu"…',
  pid: 111,
  tid: 190,
  source: 'logcat',
  ...over,
})

describe('serializeLogsTxt', () => {
  test('una línea por entry con el formato HH:MM:SS.mmm LEVEL/tag(pid): message', () => {
    const out = serializeLogsTxt([entry()])
    expect(out).toBe('10:15:02.087 I/Unity(111): Loading scene "MainMenu"…\n')
  })

  test('crash multi-línea: cada línea del bloque marcada [CRASH], am_anr marcada [ANR]', () => {
    const crash: LogEntry[] = [
      entry({ level: 'E', tag: 'AndroidRuntime', message: 'FATAL EXCEPTION: main', isCrash: true }),
      entry({
        level: 'E',
        tag: 'AndroidRuntime',
        message: '\tat com.evermore.oda.GameLoop.tick(GameLoop.java:87)',
        isCrash: true,
      }),
      entry({
        level: 'I',
        tag: 'am_anr',
        message: '0,111,com.evermore.oda.qa,952680005,Input dispatching timed out',
        isCrash: true,
      }),
    ]
    const lines = serializeLogsTxt(crash).split('\n')
    expect(lines[0]).toBe('[CRASH] 10:15:02.087 E/AndroidRuntime(111): FATAL EXCEPTION: main')
    expect(lines[1]).toBe(
      '[CRASH] 10:15:02.087 E/AndroidRuntime(111): \tat com.evermore.oda.GameLoop.tick(GameLoop.java:87)',
    )
    expect(lines[2]).toStartWith('[ANR] 10:15:02.087 I/am_anr(111): 0,111,')
  })

  test('caracteres no-ASCII sobreviven tal cual (ñ, emoji, CJK)', () => {
    const out = serializeLogsTxt([entry({ message: 'señal 💥 リロード café' })])
    expect(out).toContain('señal 💥 リロード café')
  })

  test('vacío ⇒ string vacío (sin newline suelto)', () => {
    expect(serializeLogsTxt([])).toBe('')
  })
})

describe('serializeLogsJsonl', () => {
  test('round-trip: cada línea parsea de vuelta a la LogEntry original', () => {
    const entries = [entry(), entry({ level: 'E', message: 'ñandú 🦤', isCrash: true })]
    const out = serializeLogsJsonl(entries)
    const lines = out.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => JSON.parse(l) as LogEntry)).toEqual(entries)
    expect(out.endsWith('\n')).toBe(true)
  })

  test('vacío ⇒ string vacío', () => {
    expect(serializeLogsJsonl([])).toBe('')
  })
})

describe('logsExportFilename', () => {
  const now = new Date('2026-07-31T18:30:11.500Z')

  test('con sessionId usa el id de la sesión', () => {
    expect(
      logsExportFilename({ format: 'txt', filtered: false, sessionId: '2026-07-30T09-00-00', now }),
    ).toBe('evermore-logs-2026-07-30T09-00-00.txt')
  })

  test('sin sessionId usa el timestamp; filtered agrega el sufijo', () => {
    expect(logsExportFilename({ format: 'jsonl', filtered: true, sessionId: null, now })).toBe(
      'evermore-logs-2026-07-31T18-30-11-filtered.jsonl',
    )
  })
})

describe('parseExportEntries', () => {
  test('entries válidas se normalizan; campos desconocidos se descartan', () => {
    const raw = [{ ...entry(), extra: 'basura', isCrash: true }]
    const parsed = parseExportEntries(raw, 10)!
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(entry({ isCrash: true }))
    expect('extra' in parsed[0]!).toBe(false)
  })

  test('source game se preserva; cualquier otra cosa cae a logcat', () => {
    expect(parseExportEntries([entry({ source: 'game' })], 10)![0]!.source).toBe('game')
    expect(parseExportEntries([{ ...entry(), source: 'evil' }], 10)![0]!.source).toBe('logcat')
  })

  test('rechaza no-array, entries malformadas y arrays que superan el cap', () => {
    expect(parseExportEntries('nope', 10)).toBeNull()
    expect(parseExportEntries([{ ts: 'x' }], 10)).toBeNull()
    expect(parseExportEntries([{ ...entry(), level: 'Z' }], 10)).toBeNull()
    expect(parseExportEntries([{ ...entry(), message: 42 }], 10)).toBeNull()
    expect(parseExportEntries([entry(), entry()], 1)).toBeNull()
  })

  test('tid no numérico se omite sin invalidar la entry', () => {
    const parsed = parseExportEntries([{ ...entry(), tid: 'x' }], 10)!
    expect(parsed[0]!.tid).toBeUndefined()
  })
})

describe('formatLogTime', () => {
  test('padding de horas/minutos/segundos/ms', () => {
    const ts = new Date(2026, 0, 5, 4, 7, 9, 3).getTime()
    expect(formatLogTime(ts)).toBe('04:07:09.003')
  })
})
