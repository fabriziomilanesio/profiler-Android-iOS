import { describe, expect, test } from 'bun:test'
import type { LogEntry, LogLevel } from './logEntry'
import {
  BURST_GAP_MS,
  BURST_MIN_ERRORS,
  CRASH_BLOCK_GAP_MS,
  CRASH_END_GRACE_MS,
  MARK_LABEL_MAX,
  MAX_MARKS,
  REPORT_LOG_CAP,
  buildLogMarks,
  buildReportLogs,
  countByLevel,
  crashBlocks,
  filterLogsToWindow,
} from './reportLogs'

const T0 = 1_750_000_000_000

function log(
  offsetMs: number,
  level: LogLevel,
  message: string,
  opts: { crash?: boolean; tag?: string } = {},
): LogEntry {
  const e: LogEntry = {
    ts: T0 + offsetMs,
    level,
    tag: opts.tag ?? 'Unity',
    message,
    pid: 111,
    source: 'logcat',
  }
  if (opts.crash) e.isCrash = true
  return e
}

function crashBlock(offsetMs: number): LogEntry[] {
  return [
    log(offsetMs, 'E', 'FATAL EXCEPTION: main', { crash: true, tag: 'AndroidRuntime' }),
    log(offsetMs + 5, 'E', 'java.lang.IllegalStateException: boom', {
      crash: true,
      tag: 'AndroidRuntime',
    }),
    log(offsetMs + 10, 'E', '\tat com.sample.oda.GameLoop.tick(GameLoop.java:87)', {
      crash: true,
      tag: 'AndroidRuntime',
    }),
  ]
}

describe('filterLogsToWindow', () => {
  test('recorta estricto al rango [start, end] de la ventana', () => {
    const entries = [
      log(-1000, 'W', 'antes'),
      log(0, 'W', 'primero'),
      log(5000, 'E', 'dentro'),
      log(10_000, 'W', 'último'),
      log(10_001, 'E', 'después'),
    ]
    const out = filterLogsToWindow(entries, T0, T0 + 10_000)
    expect(out.map((e) => e.message)).toEqual(['primero', 'dentro', 'último'])
  })

  test('los crashes gozan de gracia tras el final (el crash llega después del último sample)', () => {
    const entries = [
      log(9000, 'I', 'jugando'),
      log(12_000, 'E', 'FATAL EXCEPTION: main', { crash: true, tag: 'AndroidRuntime' }),
      log(10_000 + CRASH_END_GRACE_MS + 1, 'E', 'tarde', { crash: true }),
      log(12_000, 'E', 'no-crash tarde'),
    ]
    const out = filterLogsToWindow(entries, T0, T0 + 10_000)
    expect(out.map((e) => e.message)).toEqual(['jugando', 'FATAL EXCEPTION: main'])
  })
})

describe('countByLevel', () => {
  test('cuenta todos los niveles, con ceros explícitos', () => {
    const out = countByLevel([
      log(0, 'I', 'a'),
      log(1, 'I', 'b'),
      log(2, 'W', 'c'),
      log(3, 'F', 'd'),
    ])
    expect(out).toEqual({ V: 0, D: 0, I: 2, W: 1, E: 0, F: 1 })
  })
})

describe('buildReportLogs', () => {
  test('embebe solo W/E/F + crashes y reporta conteos totales', () => {
    const entries = [
      log(0, 'V', 'verbose'),
      log(1, 'D', 'debug'),
      log(2, 'I', 'info'),
      log(3, 'W', 'warn'),
      log(4, 'E', 'error'),
      ...crashBlock(100),
    ]
    const out = buildReportLogs(entries)
    expect(out.entries.map((e) => e.message)).toEqual([
      'warn',
      'error',
      'FATAL EXCEPTION: main',
      'java.lang.IllegalStateException: boom',
      '\tat com.sample.oda.GameLoop.tick(GameLoop.java:87)',
    ])
    expect(out.totalByLevel.V).toBe(1)
    expect(out.totalByLevel.I).toBe(1)
    expect(out.totalByLevel.E).toBe(4) // 1 error + 3 líneas del crash
    expect(out.truncated).toBe(0)
  })

  test('cap respetado: sobreviven las no-crash MÁS RECIENTES, crashes siempre completos', () => {
    const entries: LogEntry[] = []
    for (let i = 0; i < 30; i++) entries.push(log(i * 10, 'W', `warn ${i}`))
    entries.push(...crashBlock(5)) // crash temprano: debe sobrevivir igual
    entries.sort((a, b) => a.ts - b.ts)
    const out = buildReportLogs(entries, 10)
    expect(out.truncated).toBe(20)
    // crash completo aunque el cap ya está lleno de warns
    expect(out.entries.filter((e) => e.isCrash)).toHaveLength(3)
    const warns = out.entries.filter((e) => !e.isCrash)
    expect(warns).toHaveLength(10)
    expect(warns[0]!.message).toBe('warn 20') // las últimas 10
    expect(warns[9]!.message).toBe('warn 29')
    // orden original preservado (el crash a los 5 ms va antes que warn 20)
    expect(out.entries[0]!.isCrash).toBe(true)
  })

  test('cap default exportado como constante documentada', () => {
    expect(REPORT_LOG_CAP).toBe(500)
  })
})

describe('crashBlocks / buildLogMarks', () => {
  test('un stacktrace multi-línea = un solo bloque = una sola marca', () => {
    const entries = crashBlock(1000)
    expect(crashBlocks(entries)).toHaveLength(1)
    const marks = buildLogMarks(entries, T0, T0 + 10_000)
    expect(marks).toHaveLength(1)
    expect(marks[0]!.ts).toBe(T0 + 1000)
    expect(marks[0]!.label).toBe('CRASH: FATAL EXCEPTION: main')
  })

  test('dos crashes separados por más del gap = dos marcas', () => {
    const entries = [...crashBlock(0), ...crashBlock(CRASH_BLOCK_GAP_MS + 5000)]
    const marks = buildLogMarks(entries, T0, T0 + 60_000)
    expect(marks).toHaveLength(2)
  })

  test('label de crash truncado a MARK_LABEL_MAX', () => {
    const long = 'FATAL EXCEPTION: ' + 'x'.repeat(100)
    const marks = buildLogMarks([log(0, 'E', long, { crash: true })], T0, T0 + 1000)
    expect(marks[0]!.label.length).toBeLessThanOrEqual(MARK_LABEL_MAX)
    expect(marks[0]!.label.endsWith('…')).toBe(true)
  })

  test('am_anr: label "ANR: <reason>" desde el formato del evento', () => {
    const anr = log(0, 'I', '0,111,com.sample.oda.qa,952680005,Input dispatching timed out', {
      crash: true,
      tag: 'am_anr',
    })
    const marks = buildLogMarks([anr], T0, T0 + 1000)
    expect(marks[0]!.label).toBe('ANR: Input dispatching timed out')
  })

  test('marca de crash con gracia post-ventana se clampea al borde del chart', () => {
    const entries = [log(11_000, 'E', 'FATAL EXCEPTION: main', { crash: true })]
    const windowed = filterLogsToWindow(entries, T0, T0 + 10_000)
    const marks = buildLogMarks(windowed, T0, T0 + 10_000)
    expect(marks[0]!.ts).toBe(T0 + 10_000)
  })

  test('errores E sueltos NO marcan (quedan solo en la lista)', () => {
    const entries = [log(0, 'E', 'uno'), log(BURST_GAP_MS + 1000, 'E', 'dos')]
    expect(buildLogMarks(entries, T0, T0 + 60_000)).toEqual([])
  })

  test('ráfaga de ≥5 errores con gaps ≤10 s = una sola marca "N errors"', () => {
    const entries: LogEntry[] = []
    for (let i = 0; i < BURST_MIN_ERRORS + 2; i++) entries.push(log(i * 1000, 'E', `err ${i}`))
    const marks = buildLogMarks(entries, T0, T0 + 60_000)
    expect(marks).toHaveLength(1)
    expect(marks[0]!.label).toBe('7 errors')
    expect(marks[0]!.ts).toBe(T0)
  })

  test('4 errores juntos no llegan al umbral de ráfaga', () => {
    const entries: LogEntry[] = []
    for (let i = 0; i < BURST_MIN_ERRORS - 1; i++) entries.push(log(i * 1000, 'E', `err ${i}`))
    expect(buildLogMarks(entries, T0, T0 + 60_000)).toEqual([])
  })

  test('las líneas E de un crash no cuentan para las ráfagas (ya marcan como crash)', () => {
    const entries = [...crashBlock(0), ...crashBlock(50), log(100, 'E', 'suelto')]
    // 7 líneas E en < 1 s, pero 6 son de crashes ⇒ ninguna ráfaga, 1 marca de crash
    const marks = buildLogMarks(entries, T0, T0 + 10_000)
    expect(marks).toHaveLength(1)
    expect(marks[0]!.label.startsWith('CRASH:')).toBe(true)
  })

  test('cap de marcas: crashes con prioridad sobre ráfagas, máximo MAX_MARKS', () => {
    const entries: LogEntry[] = []
    // 18 bloques de crash bien separados
    for (let i = 0; i < 18; i++) {
      entries.push(log(i * 30_000, 'E', `FATAL EXCEPTION: ${i}`, { crash: true }))
    }
    // 5 ráfagas de tamaños distintos, bien separadas entre sí y de los crashes
    for (let b = 0; b < 5; b++) {
      const base = 600_000 + b * 60_000
      for (let i = 0; i < BURST_MIN_ERRORS + b; i++) {
        entries.push(log(base + i * 500, 'E', `burst${b} err${i}`))
      }
    }
    entries.sort((a, b) => a.ts - b.ts)
    const marks = buildLogMarks(entries, T0, T0 + 1_000_000)
    expect(marks).toHaveLength(MAX_MARKS)
    expect(marks.filter((m) => m.label.startsWith('CRASH:'))).toHaveLength(18)
    // quedan las 2 ráfagas MÁS GRANDES (9 y 8 errores)
    const bursts = marks.filter((m) => m.label.endsWith('errors'))
    expect(bursts.map((m) => m.label).sort()).toEqual(['8 errors', '9 errors'])
    // resultado cronológico
    for (let i = 1; i < marks.length; i++)
      expect(marks[i]!.ts).toBeGreaterThanOrEqual(marks[i - 1]!.ts)
  })
})
