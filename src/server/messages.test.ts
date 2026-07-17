import { describe, expect, test } from 'bun:test'
import { deviceMessage, sampleMessage } from './messages'
import type { DeviceInfo, Sample } from '../core/schema'

describe('protocolo WS', () => {
  test('deviceMessage serializa {type:"device", device}', () => {
    const device: DeviceInfo = {
      serial: 'X',
      model: 'SM-A155M',
      manufacturer: 'samsung',
      androidRelease: '16',
      apiLevel: 36,
      soc: 'mt6789',
      gpu: 'Mali-G57 MC2',
      ramTotalMb: 3666,
    }
    expect(JSON.parse(deviceMessage(device))).toEqual({ type: 'device', device })
  })

  test('sampleMessage serializa {type:"sample", sample}', () => {
    const sample: Sample = {
      t: 0,
      ts: 123,
      cpu: 10,
      gpu: 99,
      fps: 33.9,
      tempC: 30.9,
      mem: { pss: 905, java: 12, native: 60, graphics: 411, code: 121, stack: 4, other: 295 },
      battery: { levelPct: 99, tempC: 25.7, mA: 587, charging: true },
      netRxKb: null,
      netTxKb: null,
    }
    expect(JSON.parse(sampleMessage(sample))).toEqual({ type: 'sample', sample })
  })
})
