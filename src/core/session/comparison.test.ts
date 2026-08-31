import { describe, expect, test } from 'bun:test'
import type { DeviceInfo, Platform, Sample } from '../schema'
import { buildComparisonReport, type ComparisonLaneInput } from './comparison'

function device(platform: Platform, serial: string): DeviceInfo {
  return {
    serial,
    platform,
    model: platform === 'ios' ? 'iPhone 15' : 'SM-A155M',
    manufacturer: platform === 'ios' ? 'Apple' : 'Samsung',
    androidRelease: platform === 'ios' ? '18.6' : '16',
    apiLevel: platform === 'ios' ? null : 36,
    soc: null,
    gpu: null,
    ramTotalMb: 4096,
    cores: 8,
    refreshHz: 60,
  }
}

function sample(platform: Platform, ts: number, n: number): Sample {
  return {
    t: n,
    ts,
    cpu: 20 + n,
    deviceCpu: platform === 'android' ? 40 + n : null,
    deviceRamUsedMb: platform === 'android' ? 2000 + n : null,
    gpu: 30 + n,
    fps: 58 - n,
    frame:
      platform === 'android'
        ? {
            p50Ms: 16,
            p90Ms: 18 + n,
            p99Ms: 25,
            jankPct: 2 + n,
            jankFrames: 2,
            totalFrames: 100,
          }
        : undefined,
    tempC: platform === 'android' ? 40 + n : null,
    mem: {
      pss: platform === 'android' ? 500 + n : null,
      footprint: platform === 'ios' ? 600 + n : null,
      compressed: platform === 'ios' ? 50 : null,
      rss: platform === 'ios' ? 550 : null,
      java: null,
      native: null,
      graphics: null,
      code: null,
      stack: null,
      other: null,
    },
    battery: { levelPct: 80 - n, tempC: 31 + n, mA: -400, charging: false },
    netRxKb: platform === 'android' ? 10 + n : null,
    netTxKb: platform === 'android' ? 2 + n : null,
  }
}

function lane(platform: Platform, serial: string, offset = 0): ComparisonLaneInput {
  const start = 1_800_000_000_000 + offset
  return {
    samples: [0, 1, 2].map((n) => sample(platform, start + n * 1000, n)),
    packageName: platform === 'ios' ? 'com.sample.game.ios' : 'com.sample.game',
    device: device(platform, serial),
    intervalMs: 1000,
    trimmed: false,
  }
}

describe('buildComparisonReport', () => {
  test('Android–iOS only compares metrics with the same semantic definition', () => {
    const report = buildComparisonReport(lane('android', 'A'), lane('ios', 'B'))
    expect(report.metrics.map((metric) => metric.id)).toEqual([
      'fps',
      'cpu',
      'batteryDrain',
      'batteryTemperature',
    ])
    expect(report.excluded.find((metric) => metric.id === 'memory')).toMatchObject({
      reason: 'not-comparable',
    })
    expect(report.excluded.find((metric) => metric.id === 'gpu')).toMatchObject({
      reason: 'not-comparable',
    })
    expect(report.excluded.find((metric) => metric.id === 'frameP90')).toMatchObject({
      reason: 'not-supported',
    })
  })

  test('iOS–iOS compares footprint and Metal GPU, but never invents frame times', () => {
    const report = buildComparisonReport(lane('ios', 'A'), lane('ios', 'B'))
    expect(report.metrics.map((metric) => metric.id)).toEqual([
      'fps',
      'cpu',
      'gpu',
      'memory',
      'batteryDrain',
      'batteryTemperature',
    ])
    expect(report.excluded.find((metric) => metric.id === 'jank')?.reason).toBe('not-supported')
  })

  test('Android–Android includes Android-only compatible metrics when data exists', () => {
    const report = buildComparisonReport(lane('android', 'A'), lane('android', 'B'))
    expect(report.metrics.map((metric) => metric.id)).toEqual([
      'fps',
      'cpu',
      'gpu',
      'memory',
      'batteryDrain',
      'batteryTemperature',
      'socTemperature',
      'frameP90',
      'jank',
      'deviceCpu',
      'deviceMemory',
      'networkRx',
      'networkTx',
    ])
  })

  test('uses the shared clock origin and reports missing compatible data honestly', () => {
    const primary = lane('android', 'A')
    const secondary = lane('android', 'B', 1000)
    secondary.samples.forEach((entry) => (entry.gpu = null))
    const report = buildComparisonReport(primary, secondary)
    expect(report.overlap.startedAt).toBe(new Date(secondary.samples[0]!.ts).toISOString())
    expect(
      report.metrics.find((metric) => metric.id === 'fps')?.secondary.series[0]?.elapsedS,
    ).toBe(0)
    expect(report.metrics.find((metric) => metric.id === 'fps')?.primary.series[0]?.elapsedS).toBe(
      0,
    )
    expect(report.excluded.find((metric) => metric.id === 'gpu')).toMatchObject({
      reason: 'no-data',
    })
  })

  test('accepts staggered sampler ticks inside the same wall-clock overlap', () => {
    const primary = lane('android', 'A')
    const secondary = lane('android', 'B', 500)
    const report = buildComparisonReport(primary, secondary)
    expect(report.overlap.startedAt).toBe(new Date(secondary.samples[0]!.ts).toISOString())
    expect(report.overlap.endedAt).toBe(new Date(primary.samples[2]!.ts).toISOString())
    expect(report.overlap.durationS).toBe(1.5)
    expect(report.metrics.find((metric) => metric.id === 'fps')?.primary.series).toHaveLength(2)
    expect(report.metrics.find((metric) => metric.id === 'fps')?.secondary.series).toHaveLength(2)
  })

  test('battery drain compares final level loss, not unrelated starting levels', () => {
    const primary = lane('android', 'A')
    const secondary = lane('android', 'B')
    secondary.samples[0]!.battery.levelPct = 50
    secondary.samples[1]!.battery.levelPct = 50
    secondary.samples[2]!.battery.levelPct = 49
    const metric = buildComparisonReport(primary, secondary).metrics.find(
      (candidate) => candidate.id === 'batteryDrain',
    )!
    expect(metric.primary.value).toBe(2)
    expect(metric.secondary.value).toBe(1)
    expect(metric.winner).toBe('secondary')
  })
})
