// Tests del IosMetricSource con un transporte fake (el equivalente iOS de fake-adb):
// se inyectan las líneas que emitiría pymobiledevice3 y se verifica el Sample resultante.
import { describe, expect, test } from 'bun:test'
import { IosMetricSource } from './IosMetricSource'
import type { Sample } from '../schema'

/** Transporte fake: guarda los callbacks para empujar líneas a mano desde el test. */
function fakeTransport() {
  const streams: Array<{ args: string[]; onLine: (l: string) => void; stopped: boolean }> = []
  return {
    streams,
    stream(_serial: string, args: string[], onLine: (l: string) => void): () => void {
      const entry = { args, onLine, stopped: false }
      streams.push(entry)
      return () => {
        entry.stopped = true
      }
    },
  }
}

const GRAPHICS_LINE =
  '{"Device Utilization %": 46, "Renderer Utilization %": 45, "Tiler Utilization %": 46, "CoreAnimationFramesPerSecond": 59}'

function pushSysmon(onLine: (l: string) => void, over: Record<string, unknown> = {}): void {
  const obj = {
    pid: 63819,
    name: 'EvermoreArcade',
    cpuUsage: 48.8,
    physFootprint: 1071188016,
    memResidentSize: 309248000,
    memCompressed: 607797248,
    threadCount: 78,
    ...over,
  }
  // pretty multi-línea, como lo emite de verdad
  for (const l of JSON.stringify(obj, null, 4).split('\n')) onLine(l)
}

/** Busca un stream por su comando, no por índice: sumar un canal no debe romper tests. */
function streamFor(transport: ReturnType<typeof fakeTransport>, cmd: string) {
  return transport.streams.find((s) => s.args.includes(cmd))
}

function makeSource(intervalMs = 5) {
  const transport = fakeTransport()
  const samples: Sample[] = []
  const src = new IosMetricSource({
    transport,
    serial: 'UDID',
    processName: 'EvermoreArcade',
    onSample: (s) => samples.push(s),
    intervalMs,
  })
  return { transport, samples, src }
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('IosMetricSource', () => {
  test('abre los tres canales: graphics, batería y sysmon', () => {
    const { transport, src } = makeSource()
    src.start()
    expect(streamFor(transport, 'graphics')).toBeDefined()
    expect(streamFor(transport, 'battery')).toBeDefined()
    expect(streamFor(transport, 'sysmon')).toBeDefined()
    src.stop()
  })

  test('graphics y batería arrancan aunque la app esté cerrada', () => {
    // FPS/GPU son del compositor y la batería es del device: ninguno depende del proceso.
    const transport = fakeTransport()
    const src = new IosMetricSource({
      transport,
      serial: 'UDID',
      onSample: () => {},
      intervalMs: 5,
    })
    src.start()
    expect(streamFor(transport, 'graphics')).toBeDefined()
    expect(streamFor(transport, 'battery')).toBeDefined()
    expect(streamFor(transport, 'sysmon')).toBeUndefined()
    src.stop()
  })

  test('la batería llega al Sample con sus unidades convertidas', async () => {
    const { transport, samples, src } = makeSource()
    src.start()
    streamFor(transport, 'battery')?.onLine(
      '{"InstantAmperage": -186, "Temperature": 2989, "IsCharging": false, "CurrentCapacity": 87}',
    )
    await tick()
    src.stop()
    const b = samples.at(-1)?.battery
    expect(b?.levelPct).toBe(87)
    expect(b?.tempC).toBeCloseTo(29.89, 2) // centi-°C, NO deci como Android
    expect(b?.charging).toBe(false)
  })

  test('el filtro de sysmon va por NOMBRE de proceso y con --choose first', () => {
    // iOS 26 no expone bundleIdentifier, y sin --choose first el comando aborta.
    const { transport, src } = makeSource()
    src.start()
    const args = streamFor(transport, 'sysmon')?.args ?? []
    expect(args).toContain('name=EvermoreArcade')
    expect(args).toContain('--choose')
    expect(args).toContain('first')
    src.stop()
  })

  test('combina los dos canales en un Sample', async () => {
    const { transport, samples, src } = makeSource()
    src.start()
    streamFor(transport, 'graphics')?.onLine(GRAPHICS_LINE)
    pushSysmon(streamFor(transport, 'sysmon')?.onLine ?? (() => {}))
    await tick()
    src.stop()
    const s = samples.at(-1)
    expect(s?.fps).toBe(59)
    expect(s?.gpu).toBe(46)
    expect(s?.cpu).toBeCloseTo(48.8, 1)
    expect(s?.mem.footprint).toBeGreaterThan(1000) // ~1021 MB
    expect(s?.mem.compressed).toBeGreaterThan(500)
  })

  test('physFootprint NO se cuela en el campo pss', async () => {
    // La regla del grilling: un número con la etiqueta equivocada es un bug silencioso.
    const { transport, samples, src } = makeSource()
    src.start()
    pushSysmon(streamFor(transport, 'sysmon')?.onLine ?? (() => {}))
    await tick()
    src.stop()
    expect(samples.at(-1)?.mem.pss).toBeNull()
  })

  test('lo que iOS no puede medir sale null, no cero', async () => {
    const { transport, samples, src } = makeSource()
    src.start()
    streamFor(transport, 'graphics')?.onLine(GRAPHICS_LINE)
    await tick()
    src.stop()
    const s = samples.at(-1)
    expect(s?.tempC).toBeNull()
    expect(s?.frame?.p90Ms).toBeNull()
    expect(s?.frame?.jankPct).toBeNull()
    expect(s?.netRxKb).toBeNull()
    expect(s?.mem.java).toBeNull()
  })

  test('FPS 0 se emite como 0 — es un cero legítimo, no un N/A', async () => {
    const { transport, samples, src } = makeSource()
    src.start()
    streamFor(transport, 'graphics')?.onLine(
      '{"CoreAnimationFramesPerSecond": 0, "Device Utilization %": 0}',
    )
    await tick()
    src.stop()
    expect(samples.at(-1)?.fps).toBe(0)
  })

  test('sin datos de un canal, ese lado queda null y el otro igual se emite', async () => {
    const { transport, samples, src } = makeSource()
    src.start()
    streamFor(transport, 'graphics')?.onLine(GRAPHICS_LINE)
    await tick()
    src.stop()
    const s = samples.at(-1)
    expect(s?.fps).toBe(59)
    expect(s?.cpu).toBeNull() // sysmon nunca emitió
  })

  test('t se incrementa por tick y ts es un epoch real', async () => {
    const { transport, samples, src } = makeSource()
    src.start()
    streamFor(transport, 'graphics')?.onLine(GRAPHICS_LINE)
    await tick(30)
    src.stop()
    expect(samples.length).toBeGreaterThan(1)
    expect(samples[0]?.t).toBe(0)
    expect(samples[1]?.t).toBe(1)
    expect(samples[0]?.ts).toBeGreaterThan(1_700_000_000_000)
  })

  test('stop() corta los dos streams y deja de emitir', async () => {
    const { transport, samples, src } = makeSource()
    src.start()
    streamFor(transport, 'graphics')?.onLine(GRAPHICS_LINE)
    await tick()
    const count = samples.length
    src.stop()
    await tick(30)
    expect(transport.streams.every((s) => s.stopped)).toBe(true)
    expect(samples.length).toBe(count)
  })

  test('el fake recibe args planos: el transporte real fija env aparte', () => {
    // Regresión de un bug caro: sin PYTHONUNBUFFERED el hijo de Python bufferea stdout
    // por bloques al escribir a un pipe y el canal de sysmon queda MUDO. Se verifica en
    // IosTransport, que es quien arma el env; acá sólo que el source no lo pise.
    const { transport, src } = makeSource()
    src.start()
    expect(streamFor(transport, 'sysmon')?.args.includes('--filter')).toBe(true)
    src.stop()
  })

  test('hasData avisa si algún canal ya entregó algo', () => {
    const { transport, src } = makeSource()
    src.start()
    expect(src.hasData).toBe(false)
    streamFor(transport, 'graphics')?.onLine(GRAPHICS_LINE)
    expect(src.hasData).toBe(true)
    src.stop()
  })
})
