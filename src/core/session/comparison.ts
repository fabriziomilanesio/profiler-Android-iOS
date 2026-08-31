import { capabilitiesFor, comparabilityKey, type Capabilities } from '../platform'
import type { DeviceInfo, Platform, Sample } from '../schema'
import { scalarStats, type ScalarStats } from './stats'

export type ComparisonWinner = 'primary' | 'secondary' | 'tie'
export type ComparisonDirection = 'higher' | 'lower'

export interface ComparisonLaneInput {
  samples: Sample[]
  packageName: string
  device: DeviceInfo
  intervalMs: number
  trimmed: boolean
}

export interface ComparisonWindow {
  startTs?: number
  endTs?: number
}

export interface ComparisonLane {
  label: 'Device A' | 'Device B'
  packageName: string
  platform: Platform
  device: {
    name: string
    os: string
    serial: string
  }
  startedAt: string
  endedAt: string
  durationS: number
  sampleCount: number
  samplingHz: number
  trimmed: boolean
}

export interface ComparisonSeriesPoint {
  elapsedS: number
  value: number | null
}

export interface ComparisonMetric {
  id: string
  label: string
  description: string
  unit: string
  direction: ComparisonDirection
  valueKind: 'average' | 'final'
  primary: {
    stats: ScalarStats
    value: number
    coverage: number
    series: ComparisonSeriesPoint[]
  }
  secondary: {
    stats: ScalarStats
    value: number
    coverage: number
    series: ComparisonSeriesPoint[]
  }
  /** B − A, in the metric's native unit. */
  delta: number
  /** (B − A) / |A|. Null when A is zero. */
  deltaPct: number | null
  winner: ComparisonWinner
}

export interface ExcludedComparisonMetric {
  id: string
  label: string
  reason: 'not-supported' | 'not-comparable' | 'no-data'
  detail: string
}

export interface ComparisonReport {
  primary: ComparisonLane
  secondary: ComparisonLane
  overlap: {
    startedAt: string
    endedAt: string
    durationS: number
  }
  metrics: ComparisonMetric[]
  excluded: ExcludedComparisonMetric[]
}

interface MetricDefinition {
  id: string
  label: string
  description: string
  unit: string
  direction: ComparisonDirection
  capability: keyof Capabilities
  comparisonKey: string
  valueKind?: 'average' | 'final'
  get: (sample: Sample, platform: Platform, samples: Sample[]) => number | null
}

function platformOf(device: DeviceInfo): Platform {
  return device.platform === 'ios' ? 'ios' : 'android'
}

function deviceName(device: DeviceInfo): string {
  return [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial
}

function lane(input: ComparisonLaneInput, label: ComparisonLane['label']): ComparisonLane {
  const platform = platformOf(input.device)
  const first = input.samples[0]!
  const last = input.samples[input.samples.length - 1]!
  const os =
    platform === 'ios'
      ? `iOS ${input.device.androidRelease ?? '?'}`
      : `Android ${input.device.androidRelease ?? '?'} (API ${input.device.apiLevel ?? '?'})`
  return {
    label,
    packageName: input.packageName,
    platform,
    device: { name: deviceName(input.device), os, serial: input.device.serial },
    startedAt: new Date(first.ts).toISOString(),
    endedAt: new Date(last.ts).toISOString(),
    durationS: Math.max(1, Math.round((last.ts - first.ts) / 1000)),
    sampleCount: input.samples.length,
    samplingHz: +(1000 / input.intervalMs).toFixed(2),
    trimmed: input.trimmed,
  }
}

function finite(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null
}

function firstBatteryLevel(samples: Sample[]): number | null {
  for (const sample of samples) {
    const level = finite(sample.battery.levelPct)
    if (level !== null) return level
  }
  return null
}

function definitions(): MetricDefinition[] {
  return [
    {
      id: 'fps',
      label: 'FPS',
      description: 'Compositor frame rate',
      unit: 'fps',
      direction: 'higher',
      capability: 'fps',
      comparisonKey: 'fps',
      get: (sample) => sample.fps,
    },
    {
      id: 'cpu',
      label: 'App CPU',
      description: 'Process share of device CPU',
      unit: '%',
      direction: 'lower',
      capability: 'cpu',
      comparisonKey: 'cpu',
      get: (sample) => sample.cpu,
    },
    {
      id: 'gpu',
      label: 'GPU utilization',
      description: 'Platform GPU utilization counter',
      unit: '%',
      direction: 'lower',
      capability: 'gpu',
      comparisonKey: 'gpu',
      get: (sample) => sample.gpu,
    },
    {
      id: 'memory',
      label: 'App memory',
      description: 'PSS on Android; physFootprint on iOS',
      unit: 'MB',
      direction: 'lower',
      capability: 'memory',
      comparisonKey: 'memory',
      get: (sample, platform) => (platform === 'ios' ? sample.mem.footprint : sample.mem.pss),
    },
    {
      id: 'batteryDrain',
      label: 'Battery drain',
      description: 'Cumulative battery-level change since the shared window began',
      unit: 'pp',
      direction: 'lower',
      capability: 'battery',
      comparisonKey: 'battery',
      valueKind: 'final',
      get: (sample, _platform, samples) => {
        const start = firstBatteryLevel(samples)
        const level = finite(sample.battery.levelPct)
        return start === null || level === null ? null : start - level
      },
    },
    {
      id: 'batteryTemperature',
      label: 'Battery temperature',
      description: 'Battery sensor temperature',
      unit: '°C',
      direction: 'lower',
      capability: 'battery',
      comparisonKey: 'battery-temperature',
      get: (sample) => sample.battery.tempC,
    },
    {
      id: 'socTemperature',
      label: 'SoC temperature',
      description: 'CPU/AP temperature',
      unit: '°C',
      direction: 'lower',
      capability: 'temperatureSoc',
      comparisonKey: 'soc-temperature',
      get: (sample) => sample.tempC,
    },
    {
      id: 'frameP90',
      label: 'Frame time p90',
      description: '90th-percentile frame time per sample',
      unit: 'ms',
      direction: 'lower',
      capability: 'frameTimes',
      comparisonKey: 'frame-p90',
      get: (sample) => sample.frame?.p90Ms ?? null,
    },
    {
      id: 'jank',
      label: 'Jank',
      description: 'Janky frames per sample',
      unit: '%',
      direction: 'lower',
      capability: 'frameTimes',
      comparisonKey: 'jank',
      get: (sample) => sample.frame?.jankPct ?? null,
    },
    {
      id: 'deviceCpu',
      label: 'Device CPU',
      description: 'Whole-device CPU utilization',
      unit: '%',
      direction: 'lower',
      capability: 'deviceCpu',
      comparisonKey: 'device-cpu',
      get: (sample) => sample.deviceCpu,
    },
    {
      id: 'deviceMemory',
      label: 'Device memory used',
      description: 'Whole-device used memory',
      unit: 'MB',
      direction: 'lower',
      capability: 'deviceMemory',
      comparisonKey: 'device-memory',
      get: (sample) => sample.deviceRamUsedMb,
    },
    {
      id: 'networkRx',
      label: 'Network receive',
      description: 'Device receive throughput',
      unit: 'KB/s',
      direction: 'lower',
      capability: 'network',
      comparisonKey: 'network-rx',
      get: (sample) => sample.netRxKb,
    },
    {
      id: 'networkTx',
      label: 'Network transmit',
      description: 'Device transmit throughput',
      unit: 'KB/s',
      direction: 'lower',
      capability: 'network',
      comparisonKey: 'network-tx',
      get: (sample) => sample.netTxKb,
    },
  ]
}

function metricSeries(
  def: MetricDefinition,
  samples: Sample[],
  platform: Platform,
  overlapStart: number,
): { series: ComparisonSeriesPoint[]; values: number[] } {
  const series = samples.map((sample) => {
    const value = finite(def.get(sample, platform, samples))
    return { elapsedS: +((sample.ts - overlapStart) / 1000).toFixed(3), value }
  })
  return {
    series,
    values: series.flatMap((point) => (point.value === null ? [] : [point.value])),
  }
}

function winner(a: number, b: number, direction: ComparisonDirection): ComparisonWinner {
  const tolerance = Math.max(Math.abs(a), Math.abs(b), 1) * 0.01
  if (Math.abs(a - b) <= tolerance) return 'tie'
  if (direction === 'higher') return a > b ? 'primary' : 'secondary'
  return a < b ? 'primary' : 'secondary'
}

function incompatibleDetail(id: string, a: Platform, b: Platform): string {
  if (id === 'memory') return 'Android PSS and iOS physFootprint have different definitions.'
  if (id === 'gpu')
    return 'Android vendor busy and Metal device utilization are different counters.'
  return `${a} and ${b} do not expose this metric with the same measurement definition.`
}

export function buildComparisonReport(
  primaryInput: ComparisonLaneInput,
  secondaryInput: ComparisonLaneInput,
  window: ComparisonWindow = {},
): ComparisonReport {
  if (primaryInput.samples.length === 0 || secondaryInput.samples.length === 0) {
    throw new Error('both devices need samples')
  }
  const overlapStart = Math.max(
    primaryInput.samples[0]!.ts,
    secondaryInput.samples[0]!.ts,
    window.startTs ?? Number.NEGATIVE_INFINITY,
  )
  const overlapEnd = Math.min(
    primaryInput.samples[primaryInput.samples.length - 1]!.ts,
    secondaryInput.samples[secondaryInput.samples.length - 1]!.ts,
    window.endTs ?? Number.POSITIVE_INFINITY,
  )
  if (overlapEnd < overlapStart) throw new Error('device sample windows do not overlap')
  // Keep the pure builder safe when callers pass full, differently-sized lane histories.
  // Every statistic and chart point must belong to the exact shared wall-clock interval.
  const inOverlap = (sample: Sample): boolean =>
    sample.ts >= overlapStart && sample.ts <= overlapEnd
  const primaryWindow = { ...primaryInput, samples: primaryInput.samples.filter(inOverlap) }
  const secondaryWindow = { ...secondaryInput, samples: secondaryInput.samples.filter(inOverlap) }
  if (primaryWindow.samples.length === 0 || secondaryWindow.samples.length === 0) {
    throw new Error('device sample windows do not contain shared samples')
  }

  const primary = lane(primaryWindow, 'Device A')
  const secondary = lane(secondaryWindow, 'Device B')
  const aPlatform = primary.platform
  const bPlatform = secondary.platform
  const aCaps = capabilitiesFor(aPlatform)
  const bCaps = capabilitiesFor(bPlatform)

  const metrics: ComparisonMetric[] = []
  const excluded: ExcludedComparisonMetric[] = []
  for (const def of definitions()) {
    if (!aCaps[def.capability] || !bCaps[def.capability]) {
      excluded.push({
        id: def.id,
        label: def.label,
        reason: 'not-supported',
        detail: 'At least one device platform does not provide this metric.',
      })
      continue
    }
    const aKey = comparabilityKey(def.comparisonKey, aPlatform)
    const bKey = comparabilityKey(def.comparisonKey, bPlatform)
    if (aKey !== bKey) {
      excluded.push({
        id: def.id,
        label: def.label,
        reason: 'not-comparable',
        detail: incompatibleDetail(def.id, aPlatform, bPlatform),
      })
      continue
    }
    const a = metricSeries(def, primaryWindow.samples, aPlatform, overlapStart)
    const b = metricSeries(def, secondaryWindow.samples, bPlatform, overlapStart)
    const aStats = scalarStats(a.values)
    const bStats = scalarStats(b.values)
    if (!aStats || !bStats) {
      excluded.push({
        id: def.id,
        label: def.label,
        reason: 'no-data',
        detail: 'The metric is compatible, but one device has no values in this window.',
      })
      continue
    }
    const valueKind = def.valueKind ?? 'average'
    const aValue = valueKind === 'final' ? a.values[a.values.length - 1]! : aStats.avg
    const bValue = valueKind === 'final' ? b.values[b.values.length - 1]! : bStats.avg
    metrics.push({
      id: def.id,
      label: def.label,
      description: def.description,
      unit: def.unit,
      direction: def.direction,
      valueKind,
      primary: {
        stats: aStats,
        value: aValue,
        coverage: a.values.length / primaryWindow.samples.length,
        series: a.series,
      },
      secondary: {
        stats: bStats,
        value: bValue,
        coverage: b.values.length / secondaryWindow.samples.length,
        series: b.series,
      },
      delta: bValue - aValue,
      deltaPct: aValue === 0 ? null : (bValue - aValue) / Math.abs(aValue),
      winner: winner(aValue, bValue, def.direction),
    })
  }

  return {
    primary,
    secondary,
    overlap: {
      startedAt: new Date(overlapStart).toISOString(),
      endedAt: new Date(overlapEnd).toISOString(),
      durationS: Math.max(0, +((overlapEnd - overlapStart) / 1000).toFixed(3)),
    },
    metrics,
    excluded,
  }
}
