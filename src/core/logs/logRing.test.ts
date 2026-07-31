import { describe, expect, test } from 'bun:test'
import type { LogEntry } from './logEntry'
import { LogRing, DEFAULT_LOG_CAP } from './logRing'

function entry(n: number): LogEntry {
  return { ts: n, level: 'I', tag: 'Unity', message: `msg ${n}`, pid: 1, source: 'logcat' }
}

describe('LogRing', () => {
  test('cap default 50k', () => {
    expect(DEFAULT_LOG_CAP).toBe(50_000)
    expect(new LogRing().cap).toBe(50_000)
  })

  test('sin overflow: guarda en orden de llegada', () => {
    const ring = new LogRing(5)
    for (let i = 1; i <= 3; i++) ring.push(entry(i))
    expect(ring.size).toBe(3)
    expect(ring.last(10).map((e) => e.ts)).toEqual([1, 2, 3])
    expect(ring.last(2).map((e) => e.ts)).toEqual([2, 3])
  })

  test('overflow: descarta las más viejas y mantiene el orden cronológico', () => {
    const ring = new LogRing(5)
    for (let i = 1; i <= 8; i++) ring.push(entry(i))
    expect(ring.size).toBe(5)
    expect(ring.last(5).map((e) => e.ts)).toEqual([4, 5, 6, 7, 8])
    expect(ring.last(2).map((e) => e.ts)).toEqual([7, 8])
    expect(ring.last(100).map((e) => e.ts)).toEqual([4, 5, 6, 7, 8])
  })

  test('múltiples vueltas completas no corrompen el orden', () => {
    const ring = new LogRing(3)
    for (let i = 1; i <= 11; i++) ring.push(entry(i))
    expect(ring.last(3).map((e) => e.ts)).toEqual([9, 10, 11])
  })

  test('last(0) y ring vacío devuelven []', () => {
    const ring = new LogRing(3)
    expect(ring.last(5)).toEqual([])
    ring.push(entry(1))
    expect(ring.last(0)).toEqual([])
  })

  test('cap 0 no degenera: push es no-op, sin NaN en el índice', () => {
    const ring = new LogRing(0)
    ring.push(entry(1))
    ring.push(entry(2))
    expect(ring.size).toBe(0)
    expect(ring.last(5)).toEqual([])
  })
})
