import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceInfo, Sample } from '../schema'
import { DualSessionLog } from './dualSessionLog'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function device(serial: string, platform: 'android' | 'ios'): DeviceInfo {
  return {
    serial,
    platform,
    model: serial,
    manufacturer: platform === 'ios' ? 'Apple' : 'Example',
    androidRelease: '1',
    apiLevel: null,
    soc: null,
    gpu: null,
    ramTotalMb: null,
    cores: null,
    refreshHz: 60,
  }
}

function sample(ts: number): Sample {
  return {
    t: 0,
    ts,
    cpu: 1,
    deviceCpu: null,
    deviceRamUsedMb: null,
    gpu: 2,
    fps: 30,
    tempC: null,
    mem: {
      pss: null,
      footprint: null,
      compressed: null,
      rss: null,
      java: null,
      native: null,
      graphics: null,
      code: null,
      stack: null,
      other: null,
    },
    battery: { levelPct: null, tempC: null, mA: null, charging: null },
    netRxKb: null,
    netTxKb: null,
  }
}

describe('DualSessionLog', () => {
  test('lista sólo sesiones con muestras en los dos carriles y las relee pareadas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dual-session-'))
    dirs.push(dir)
    const id = '2026-08-28T12-00-00'
    const log = new DualSessionLog(dir, id, '2026-08-28T12:00:00.000Z')
    log.appendDevice('primary', device('A', 'android'), 'com.game.a')
    log.appendDevice('secondary', device('B', 'ios'), 'com.game.b')
    log.appendSample('primary', 'com.game.a', 'A', sample(1))
    expect(DualSessionLog.list(dir)).toEqual([])
    log.appendSample('secondary', 'com.game.b', 'B', sample(2))

    const stored = DualSessionLog.read(dir, id)
    expect(stored?.primary.samples).toHaveLength(1)
    expect(stored?.secondary.samples).toHaveLength(1)
    expect(stored?.secondary.device?.platform).toBe('ios')
    expect(DualSessionLog.list(dir)).toHaveLength(1)
  })
})
