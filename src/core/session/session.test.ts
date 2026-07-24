import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sample } from '../schema'
import { scalarStats, summarize, buildReportSession } from './stats'
import { SessionBuffer } from './sessionBuffer'
import { SessionLog, isValidSessionId, sessionId } from './sessionLog'

function sample(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t,
    ts: 1_750_000_000_000 + t * 1000,
    cpu: 40 + t,
    deviceCpu: 50 + t,
    deviceRamUsedMb: 2800 + t,
    gpu: 60,
    fps: 58,
    tempC: 33,
    mem: {
      pss: 900 + t,
      rss: null,
      java: 300,
      native: 400,
      graphics: 150,
      code: 40,
      stack: 5,
      other: 5,
    },
    battery: { levelPct: 80 - t * 0.1, tempC: 30, mA: -500, charging: false },
    netRxKb: 10,
    netTxKb: 2,
    ...over,
  }
}

describe('scalarStats', () => {
  test('avg/peak/min/p90 de una serie', () => {
    const s = scalarStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])!
    expect(s.avg).toBe(55)
    expect(s.peak).toBe(100)
    expect(s.min).toBe(10)
    expect(s.p90).toBe(90)
  })

  test('sin datos ⇒ null', () => {
    expect(scalarStats([])).toBeNull()
  })
})

describe('summarize', () => {
  test('filtra nulls por métrica y calcula drain de batería', () => {
    const samples = [
      sample(0, { cpu: null }), // primera muestra real: cpu null (necesita delta)
      sample(1),
      sample(2),
      sample(3, { battery: { levelPct: 79, tempC: 31, mA: -600, charging: false } }),
    ]
    const S = summarize(samples)
    expect(S.cpu!.avg).toBeCloseTo(42, 0) // 41,42,43 — el null no cuenta
    expect(S.battery.levelStart).toBe(80)
    expect(S.battery.levelEnd).toBe(79)
    expect(S.battery.drainPct).toBeCloseTo(1, 5)
    expect(S.battery.avgMa).toBeGreaterThan(0) // magnitud, sin signo
    expect(S.ramMb!.min).toBe(900)
  })

  test('métrica totalmente ausente ⇒ null (no 0)', () => {
    const S = summarize([sample(0, { gpu: null }), sample(1, { gpu: null })])
    expect(S.gpu).toBeNull()
  })
})

describe('buildReportSession', () => {
  test('arma el contrato del template (serie + summary + meta)', () => {
    const r = buildReportSession({
      samples: [sample(0), sample(1), sample(2)],
      packageName: 'com.evermore.oda.qa',
      device: {
        serial: 'X',
        model: 'SM-A155M',
        manufacturer: 'samsung',
        androidRelease: '16',
        apiLevel: 36,
        soc: 'mt6789',
        gpu: 'Mali-G57',
        ramTotalMb: 3666,
        cores: 8,
      },
      intervalMs: 1000,
      trimmed: false,
    })
    expect(r.bundleId).toBe('com.evermore.oda.qa')
    expect(r.device!.name).toBe('samsung SM-A155M')
    expect(r.durationS).toBe(3)
    expect(r.samplingHz).toBe(1)
    expect(r.series).toHaveLength(3)
    expect(r.series[0]!.ramMb).toBe(900)
    expect(r.series[0]!.battery.level).toBe(80)
    expect(r.summary.fps!.avg).toBe(58)
  })
})

describe('SessionBuffer', () => {
  test('recorta al tramo continuo final de la app actual y marca trimmed', () => {
    const buf = new SessionBuffer()
    buf.push({ pkg: 'com.a', serial: 'S1', sample: sample(0) })
    buf.push({ pkg: 'com.a', serial: 'S1', sample: sample(1) })
    buf.push({ pkg: 'com.b', serial: 'S1', sample: sample(2) }) // switch a com.b
    buf.push({ pkg: 'com.b', serial: 'S1', sample: sample(3) })
    const seg = buf.currentSegment('com.b', 'S1')
    expect(seg.samples.map((s) => s.t)).toEqual([2, 3])
    expect(seg.trimmed).toBe(true)
  })

  test('ventana temporal: solo los últimos N ms, sin marcar trimmed si no hubo switch', () => {
    const buf = new SessionBuffer()
    for (let t = 0; t < 10; t++) buf.push({ pkg: 'com.a', serial: 'S1', sample: sample(t) })
    const seg = buf.currentSegment('com.a', 'S1', 3000)
    expect(seg.samples.map((s) => s.t)).toEqual([6, 7, 8, 9])
    expect(seg.trimmed).toBe(false)
  })

  test('cap circular: nunca supera el límite', () => {
    const buf = new SessionBuffer(5)
    for (let t = 0; t < 12; t++) buf.push({ pkg: 'com.a', serial: 'S1', sample: sample(t) })
    expect(buf.size).toBe(5)
    expect(buf.currentSegment('com.a', 'S1').samples[0]!.t).toBe(7)
  })
})

describe('SessionLog', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  test('ids: formato válido y traversal rechazado', () => {
    expect(isValidSessionId(sessionId(new Date('2026-07-20T15:30:00Z')))).toBe(true)
    expect(isValidSessionId('../../etc/passwd')).toBe(false)
    expect(isValidSessionId('2026-07-20T15-30-00x')).toBe(false)
  })

  test('roundtrip: escribir sesión, listarla y releerla', () => {
    dir = mkdtempSync(join(tmpdir(), 'sessions-'))
    const id = sessionId(new Date('2026-07-20T15:30:00Z'))
    const log = new SessionLog(dir, id, '2026-07-20T15:30:00Z', 'com.evermore.oda.qa', null)
    log.appendSample({ pkg: 'com.evermore.oda.qa', serial: 'S1', sample: sample(0) })
    log.appendEvent({ ts: 1, kind: 'app', pkg: 'com.otra.app', serial: 'S1' })
    log.appendSample({ pkg: 'com.otra.app', serial: 'S1', sample: sample(1) })

    const list = SessionLog.list(dir)
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(id)
    expect(list[0]!.packages.sort()).toEqual(['com.evermore.oda.qa', 'com.otra.app'])

    const read = SessionLog.read(dir, id)!
    expect(read.entries).toHaveLength(2)
    expect(read.entries[1]!.pkg).toBe('com.otra.app')
    expect(read.events).toHaveLength(1)
  })

  test('leer sesión inexistente o id inválido ⇒ null', () => {
    dir = mkdtempSync(join(tmpdir(), 'sessions-'))
    expect(SessionLog.read(dir, '2026-01-01T00-00-00')).toBeNull()
    expect(SessionLog.read(dir, '../evil')).toBeNull()
  })
})
