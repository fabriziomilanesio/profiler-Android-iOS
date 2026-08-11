// Tests capa 1 del parser de `usbmux list`, contra la salida REAL capturada en el spike
// 033 (iPhone15,3 / iOS 26.5.2) con la PII reemplazada por valores sintéticos.
// scrub:allow-synthetic — los UDID de acá son inventados, no son del device de nadie.
import { describe, expect, test } from 'bun:test'
import { parseIosDevices } from './parseDevices'

// Forma exacta que devolvió el device real; UDID/DeviceName cambiados.
const REAL_SHAPE = JSON.stringify([
  {
    BuildVersion: '23F84',
    ConnectionType: 'USB',
    DeviceClass: 'iPhone',
    DeviceName: 'iPhone de Prueba',
    Identifier: '00008120-000A5D14FFFFFFFF',
    ProductType: 'iPhone15,3',
    ProductVersion: '26.5.2',
    UniqueDeviceID: '00008120-000A5D14FFFFFFFF',
  },
  {
    BuildVersion: '23F84',
    ConnectionType: 'Network',
    DeviceClass: 'iPhone',
    DeviceName: 'iPhone de Prueba',
    Identifier: '00008120-000A5D14FFFFFFFF',
    ProductType: 'iPhone15,3',
    ProductVersion: '26.5.2',
    UniqueDeviceID: '00008120-000A5D14FFFFFFFF',
  },
])

describe('parseIosDevices', () => {
  test('mapea un iPhone al mismo shape que AdbDevice, con platform ios', () => {
    const [d] = parseIosDevices(REAL_SHAPE)
    expect(d).toBeDefined()
    expect(d?.serial).toBe('00008120-000A5D14FFFFFFFF')
    expect(d?.state).toBe('device')
    expect(d?.platform).toBe('ios')
  })

  test('deduplica el mismo device visto por USB y por wifi, prefiriendo USB', () => {
    // Pasó de verdad en el spike: dos entradas con el mismo UDID rompían la lista.
    const devices = parseIosDevices(REAL_SHAPE)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.description).toContain('transport:USB')
  })

  test('la descripción imita `adb devices -l` para que la UI extraiga el label sola', () => {
    const [d] = parseIosDevices(REAL_SHAPE)
    expect(d?.description).toContain('model:iPhone15,3')
    expect(d?.description).toContain('ios:26.5.2')
  })

  test('NO incluye DeviceName: suele traer el nombre de la persona', () => {
    const [d] = parseIosDevices(REAL_SHAPE)
    expect(d?.description).not.toContain('Prueba')
    expect(JSON.stringify(d)).not.toContain('iPhone de')
  })

  test('varios devices distintos se listan todos', () => {
    const json = JSON.stringify([
      { Identifier: 'AAA', ProductType: 'iPhone15,3', ConnectionType: 'USB' },
      { Identifier: 'BBB', ProductType: 'iPad13,4', ConnectionType: 'USB' },
    ])
    expect(parseIosDevices(json).map((d) => d.serial)).toEqual(['AAA', 'BBB'])
  })

  test('acepta un objeto suelto además de un array', () => {
    const json = JSON.stringify({ Identifier: 'AAA', ProductType: 'iPhone15,3' })
    expect(parseIosDevices(json)).toHaveLength(1)
  })

  test('entradas sin UDID se descartan en vez de romper', () => {
    const json = JSON.stringify([{ ProductType: 'iPhone15,3' }, { Identifier: '' }])
    expect(parseIosDevices(json)).toEqual([])
  })

  test('salida no-JSON ⇒ lista vacía (pymobiledevice3 ausente o error)', () => {
    expect(parseIosDevices('')).toEqual([])
    expect(parseIosDevices('command not found')).toEqual([])
    expect(parseIosDevices('null')).toEqual([])
  })

  test('campos faltantes ⇒ descripción parcial, sin undefined en el texto', () => {
    const [d] = parseIosDevices(JSON.stringify([{ Identifier: 'AAA' }]))
    expect(d?.description).toBe('')
    expect(d?.serial).toBe('AAA')
  })
})
