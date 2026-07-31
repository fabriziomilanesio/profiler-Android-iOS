import { describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogEntry } from './logEntry'
import { LogSink } from './logSink'

const ID = '2026-07-31T10-15-00'

function entry(n: number, extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: n, level: 'I', tag: 'Unity', message: `m${n}`, pid: 7, source: 'logcat', ...extra }
}

describe('LogSink (NDJSON hermano de la sesión)', () => {
  test('append escribe <id>.logs.jsonl en el dir de sesiones y read lo devuelve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logsink-'))
    try {
      const sink = new LogSink(dir, ID)
      sink.append([entry(1), entry(2, { isCrash: true, tid: 42 })])
      sink.append([entry(3)])
      expect(sink.path).toBe(join(dir, `${ID}.logs.jsonl`))
      expect(readFileSync(sink.path, 'utf8').trim().split('\n')).toHaveLength(3)
      const back = LogSink.read(dir, ID)
      expect(back).toHaveLength(3)
      expect(back![1]).toEqual(entry(2, { isCrash: true, tid: 42 }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('sin logs no se crea archivo (append vacío = no-op)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logsink-'))
    try {
      const sink = new LogSink(dir, ID)
      sink.append([])
      expect(existsSync(sink.path)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('read: sesión sin logs ⇒ null; id inválido (traversal) ⇒ null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logsink-'))
    try {
      expect(LogSink.read(dir, ID)).toBeNull()
      expect(LogSink.read(dir, '../evil')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('línea corrupta (corte a mitad de escritura) se saltea', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logsink-'))
    try {
      const sink = new LogSink(dir, ID)
      sink.append([entry(1)])
      appendFileSync(sink.path, '{"ts":2,"level":"I","tag":"Uni')
      expect(LogSink.read(dir, ID)).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
