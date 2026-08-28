import { describe, expect, test } from 'bun:test'
import { appMessage, deviceMessage, logsMessage, sampleMessage } from './messages'
import type { LogEntry } from '../core/logs/logEntry'
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
      cores: 8,
      refreshHz: 90,
    }
    expect(JSON.parse(deviceMessage(device))).toEqual({ type: 'device', device })
  })

  test('sampleMessage serializa {type:"sample", sample}', () => {
    const sample: Sample = {
      t: 0,
      ts: 123,
      cpu: 10,
      deviceCpu: 32,
      deviceRamUsedMb: 2827,
      gpu: 99,
      fps: 33.9,
      frame: { p50Ms: 33, p90Ms: 33, p99Ms: 33, jankPct: 0.9, jankFrames: 11, totalFrames: 1178 },
      tempC: 30.9,
      mem: {
        pss: 905,
        footprint: null,
        compressed: null,
        rss: null,
        java: 12,
        native: 60,
        graphics: 411,
        code: 121,
        stack: 4,
        other: 295,
      },
      battery: { levelPct: 99, tempC: 25.7, mA: 587, charging: true },
      netRxKb: null,
      netTxKb: null,
    }
    expect(JSON.parse(sampleMessage(sample))).toEqual({ type: 'sample', sample })
  })

  test('appMessage serializa {type:"app", app}', () => {
    const app = { packageName: 'com.sample.oda.qa', pid: 123, launched: true }
    expect(JSON.parse(appMessage(app))).toEqual({ type: 'app', app })
  })

  test('el carril secundario se etiqueta sin alterar el protocolo primario', () => {
    const sample = { ts: 1 } as Sample
    expect(JSON.parse(sampleMessage(sample, 'secondary'))).toEqual({
      type: 'sample',
      sample,
      pane: 'secondary',
    })
  })

  test('los logs se enrutan por carril sin alterar el protocolo primario', () => {
    const entries = [{ ts: 1, pid: 2, tid: 3, level: 'I', tag: 'App', message: 'ok' }] as LogEntry[]
    expect(JSON.parse(logsMessage(entries))).toEqual({ type: 'logs', entries })
    expect(JSON.parse(logsMessage(entries, 'secondary'))).toEqual({
      type: 'logs',
      entries,
      pane: 'secondary',
    })
  })
})
