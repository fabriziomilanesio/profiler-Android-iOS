// Tests capa 1 de los parsers iOS, contra la salida REAL del iPhone15,3 capturada con
// Sample App corriendo (fixtures/ios-iphone15-3/). Mismo esquema que
// parsers.test.ts del lado Android.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGraphicsLine } from './parseGraphics'
import { SysmonAssembler, toProcessSample } from './parseSysmon'
import { parseIosSystem } from './parseSystem'
import { parseBatteryLine } from './parseBattery'

const FIXTURES = join(import.meta.dir, '../../../fixtures/ios-iphone15-3')
const graphicsLines = readFileSync(join(FIXTURES, 'graphics.jsonl'), 'utf8').split('\n')
const sysmonLines = readFileSync(join(FIXTURES, 'sysmon-pretty.txt'), 'utf8').split('\n')

describe('parseGraphicsLine — fixture real', () => {
  test('parsea todas las líneas del fixture', () => {
    const parsed = graphicsLines.filter(Boolean).map(parseGraphicsLine).filter(Boolean)
    expect(parsed.length).toBeGreaterThan(10)
  })

  test('extrae FPS y el desglose de GPU que Android no tiene', () => {
    const s = graphicsLines.map(parseGraphicsLine).find((x) => x !== null)
    expect(s).toBeDefined()
    expect(typeof s?.fps).toBe('number')
    expect(typeof s?.gpu).toBe('number')
    expect(typeof s?.gpuRenderer).toBe('number')
    expect(typeof s?.gpuTiler).toBe('number')
  })

  test('convierte la memoria de GPU de bytes a MB', () => {
    const s = graphicsLines.map(parseGraphicsLine).find((x) => x?.gpuMemAllocMb !== null)
    // 768278528 bytes ≈ 732 MB — si viniera sin convertir daría cientos de millones
    expect(s?.gpuMemAllocMb).toBeGreaterThan(1)
    expect(s?.gpuMemAllocMb).toBeLessThan(100_000)
  })

  test('FPS 0 se conserva como 0, NO como null', () => {
    // Es la distinción que arruina el promedio de sesión si se pierde: 0 = "no se compuso
    // ningún frame", null = "el device no mandó el campo".
    const s = parseGraphicsLine('{"CoreAnimationFramesPerSecond": 0, "Device Utilization %": 0}')
    expect(s?.fps).toBe(0)
    expect(s?.fps).not.toBeNull()
  })

  test('ignora warnings y líneas que no son muestras', () => {
    expect(parseGraphicsLine('WARNING Trying again over a no-root userspace tunnel')).toBeNull()
    expect(parseGraphicsLine('')).toBeNull()
    expect(parseGraphicsLine('{"algo": 1}')).toBeNull() // JSON sin FPS ⇒ no es una muestra
    expect(parseGraphicsLine('{roto')).toBeNull()
  })

  test('campos ausentes ⇒ null, no 0', () => {
    const s = parseGraphicsLine('{"CoreAnimationFramesPerSecond": 60}')
    expect(s?.fps).toBe(60)
    expect(s?.gpu).toBeNull()
    expect(s?.gpuRenderer).toBeNull()
  })
})

describe('SysmonAssembler — JSON pretty multi-línea', () => {
  test('ensambla las muestras del fixture real', () => {
    const asm = new SysmonAssembler()
    const out = sysmonLines.map((l) => asm.push(l)).filter(Boolean)
    expect(out.length).toBeGreaterThan(2)
    expect(out[0]?.name).toBe('SampleApp')
  })

  test('convierte la memoria a MB y respeta los valores reales', () => {
    const asm = new SysmonAssembler()
    const first = sysmonLines.map((l) => asm.push(l)).find(Boolean)
    // physFootprint real ≈ 1 GB; en MB tiene que caer en el orden de los miles, no de
    // los cientos de millones
    expect(first?.footprintMb).toBeGreaterThan(500)
    expect(first?.footprintMb).toBeLessThan(4000)
    expect(first?.compressedMb).toBeGreaterThan(100)
  })

  test('el CPU viene en porcentaje, no en 0-1', () => {
    const asm = new SysmonAssembler()
    const samples = sysmonLines.map((l) => asm.push(l)).filter(Boolean)
    const max = Math.max(...samples.map((s) => s?.cpuUsage ?? 0))
    // con el juego corriendo se vieron picos de ~50; si fuera 0-1 nunca pasaría de 1
    expect(max).toBeGreaterThan(1)
  })

  test('ignora el banner "Monitoring pid=…" sin romper el estado', () => {
    const asm = new SysmonAssembler()
    expect(asm.push('Monitoring pid=63819, ppid=1, name=SampleApp')).toBeNull()
    expect(asm.push('{')).toBeNull()
    expect(asm.push('  "pid": 1,')).toBeNull()
    expect(asm.push('  "name": "X"')).toBeNull()
    expect(asm.push('}')?.pid).toBe(1)
  })

  test('una llave dentro de un string no desbalancea el ensamblado', () => {
    // Sin contar llaves fuera de strings, un nombre con `{` rompería el stream para siempre.
    const asm = new SysmonAssembler()
    asm.push('{')
    asm.push('  "name": "raro{proceso}",')
    asm.push('  "pid": 7')
    const s = asm.push('}')
    expect(s?.name).toBe('raro{proceso}')
    expect(s?.pid).toBe(7)
  })

  test('un bloque corrupto se descarta y el siguiente se parsea igual', () => {
    const asm = new SysmonAssembler()
    asm.push('{')
    expect(asm.push('  basura sin comillas }')).toBeNull()
    expect(asm.push('{')).toBeNull()
    expect(asm.push('  "pid": 9')).toBeNull()
    expect(asm.push('}')?.pid).toBe(9)
  })

  test('JSON en una sola línea también funciona', () => {
    const asm = new SysmonAssembler()
    expect(asm.push('{"pid": 3, "name": "Y"}')?.pid).toBe(3)
  })
})

describe('toProcessSample', () => {
  test('campos ausentes quedan null', () => {
    const s = toProcessSample({ pid: 1 })
    expect(s.pid).toBe(1)
    expect(s.cpuUsage).toBeNull()
    expect(s.footprintMb).toBeNull()
    expect(s.compressedMb).toBeNull()
  })

  test('valores no numéricos no se cuelan como números', () => {
    const s = toProcessSample({ cpuUsage: 'alto', physFootprint: null })
    expect(s.cpuUsage).toBeNull()
    expect(s.footprintMb).toBeNull()
  })
})

describe('parseIosSystem — datos del device', () => {
  test('convierte physMemSize de PÁGINAS de 16 KB a MB', () => {
    // 360717 páginas × 16 KB = 5,5 GiB, que es la RAM del iPhone 14 Pro Max. Con páginas
    // de 4 KB daría 1,4 GB, que no corresponde a ningún iPhone — por eso el tamaño de
    // página se puede afirmar y no suponer.
    const info = parseIosSystem('physMemSize: 360717\nEnabledCPUs: 6\n')
    expect(info.ramTotalMb).toBeGreaterThan(5000)
    expect(info.ramTotalMb).toBeLessThan(6500)
    expect(info.cores).toBe(6)
  })

  test('campos ausentes ⇒ null, no 0', () => {
    const info = parseIosSystem('otraCosa: 1\n')
    expect(info.ramTotalMb).toBeNull()
    expect(info.cores).toBeNull()
  })

  test('cae a CPUCount si no vino EnabledCPUs', () => {
    expect(parseIosSystem('CPUCount: 8\n').cores).toBe(8)
  })
})

describe('parseBatteryLine', () => {
  test('parsea la muestra real del device con sus unidades', () => {
    const b = parseBatteryLine(
      '{"InstantAmperage": -186, "Temperature": 2989, "Voltage": 4340, "IsCharging": false, "CurrentCapacity": 100}',
    )
    // Temperature en centi-°C: con la conversión de Android (deci) daría 298,9 °C
    expect(b?.tempC).toBeCloseTo(29.89, 2)
    expect(b?.levelPct).toBe(100)
    expect(b?.mA).toBe(-186)
    expect(b?.charging).toBe(false)
  })

  test('ignora warnings y líneas que no son muestras', () => {
    expect(parseBatteryLine('WARNING no-root userspace tunnel')).toBeNull()
    expect(parseBatteryLine('{"algo": 1}')).toBeNull()
    expect(parseBatteryLine('{roto')).toBeNull()
  })

  test('campos ausentes quedan null', () => {
    const b = parseBatteryLine('{"CurrentCapacity": 55}')
    expect(b?.levelPct).toBe(55)
    expect(b?.tempC).toBeNull()
    expect(b?.charging).toBeNull()
  })
})
