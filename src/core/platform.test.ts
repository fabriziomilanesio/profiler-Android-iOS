// Tests del modelo de capacidades (ticket 037). Cada `false` de iOS está respaldado por
// una medición del spike 033 contra un iPhone real — no son suposiciones.
import { describe, expect, test } from 'bun:test'
import { capabilitiesFor, comparabilityKey } from './platform'

describe('capabilitiesFor', () => {
  test('Android conserva todo lo que ya medía', () => {
    const c = capabilitiesFor('android')
    expect(c.frameTimes).toBe(true)
    expect(c.memoryBreakdown).toBe(true)
    expect(c.temperature).toBe(true)
    expect(c.network).toBe(true)
    expect(c.logs).toBe(true)
    expect(c.httpInspector).toBe(true)
  })

  test('iOS: sin frame-times — graphics.opengl no da histograma', () => {
    expect(capabilitiesFor('ios').frameTimes).toBe(false)
  })

  test('iOS: sin temperatura de SoC, pero el tile se muestra por la de batería', () => {
    // La del SoC no existe sin entitlements privados; la de batería sí llega por
    // `diagnostics battery`. Esconder el tile entero (lo que hacía antes esta bandera)
    // tiraba a la basura una medición real que el device estaba entregando.
    const c = capabilitiesFor('ios')
    expect(c.temperatureSoc).toBe(false)
    expect(c.temperature).toBe(true)
  })

  test('Android mide las dos temperaturas: SoC en el aro, batería en el anillo interior', () => {
    const c = capabilitiesFor('android')
    expect(c.temperatureSoc).toBe(true)
    expect(c.temperature).toBe(true)
  })

  test('iOS: sin torta de memoria, pero con memoria comprimida', () => {
    const c = capabilitiesFor('ios')
    expect(c.memoryBreakdown).toBe(false)
    expect(c.memoryCompressed).toBe(true)
  })

  test('iOS SÍ tiene logs (syslog), pero no red ni inspector HTTP', () => {
    const c = capabilitiesFor('ios')
    expect(c.logs).toBe(true)
    expect(c.network).toBe(false)
    expect(c.httpInspector).toBe(false)
  })

  test('iOS gana el desglose de GPU que Android no tiene', () => {
    expect(capabilitiesFor('ios').gpuBreakdown).toBe(true)
    expect(capabilitiesFor('android').gpuBreakdown).toBe(false)
  })

  test('lo que las dos comparten: fps, cpu, memoria, gpu y batería', () => {
    for (const p of ['android', 'ios'] as const) {
      const c = capabilitiesFor(p)
      expect(c.fps).toBe(true)
      expect(c.cpu).toBe(true)
      expect(c.memory).toBe(true)
      expect(c.gpu).toBe(true)
      expect(c.battery).toBe(true)
    }
  })

  test('devuelve una copia: mutarla no contamina la siguiente llamada', () => {
    const a = capabilitiesFor('ios')
    a.fps = false
    expect(capabilitiesFor('ios').fps).toBe(true)
  })
})

describe('comparabilityKey', () => {
  test('el FPS SÍ se compara entre plataformas: los dos los mide el compositor', () => {
    expect(comparabilityKey('fps', 'ios')).toBe(comparabilityKey('fps', 'android'))
  })

  test('la memoria NO: PSS prorratea memoria compartida, physFootprint no', () => {
    expect(comparabilityKey('memory', 'ios')).not.toBe(comparabilityKey('memory', 'android'))
  })

  test('la GPU tampoco: Mali gpu_busy y Metal Device Utilization no miden lo mismo', () => {
    expect(comparabilityKey('gpu', 'ios')).not.toBe(comparabilityKey('gpu', 'android'))
  })

  test('CPU sí: el spike confirmó que sysmontap reporta porcentaje del proceso', () => {
    expect(comparabilityKey('cpu', 'ios')).toBe(comparabilityKey('cpu', 'android'))
  })

  test('temperatura de batería sí: ambos paths exponen el sensor físico en Celsius', () => {
    expect(comparabilityKey('battery-temperature', 'ios')).toBe(
      comparabilityKey('battery-temperature', 'android'),
    )
  })
})
