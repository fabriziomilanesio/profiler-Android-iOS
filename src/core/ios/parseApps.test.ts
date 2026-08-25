// Tests del selector de apps iOS. Los fixtures reproducen la forma real de
// `pymobiledevice3 apps list` capturada del iPhone 15,3 con iOS 26.5.2.
import { describe, expect, test } from 'bun:test'
import { parseIosApps } from './parseApps'
import { isValidBundleId } from './bundleId'

const REAL_SHAPE = JSON.stringify({
  'com.samplegames.samplearcade': {
    ApplicationType: 'User',
    CFBundleDisplayName: 'Sample App',
    CFBundleExecutable: 'SampleApp',
  },
  'LB-Software.PhotoEraser': {
    ApplicationType: 'User',
    // Bundle id CON GUIÓN: el validador de Android lo rechazaba y la app no se podía elegir.
    CFBundleDisplayName: 'Photo Eraser',
  },
  'com.apple.Preferences': {
    ApplicationType: 'System',
    CFBundleDisplayName: 'Ajustes',
  },
  'com.sinnombre.app': {
    ApplicationType: 'User',
    // sin CFBundleDisplayName: cae a CFBundleName
    CFBundleName: 'Sin Nombre',
  },
  'com.pelado.app': {
    ApplicationType: 'User',
    // sin ningún nombre: cae al bundle id
  },
})

describe('parseIosApps', () => {
  test('extrae bundle id y nombre visible, en orden alfabético estable', () => {
    // Alfabético case-insensitive y sin depender del locale del host: con localeCompare
    // este mismo orden cambiaba entre Windows y macOS.
    const apps = parseIosApps(REAL_SHAPE)
    expect(apps.map((a) => a.label)).toEqual([
      'com.pelado.app',
      'Sample App',
      'Photo Eraser',
      'Sin Nombre',
    ])
    expect(apps.find((a) => a.label === 'Sample App')!.id).toBe(
      'com.samplegames.samplearcade',
    )
  })

  test('los bundle ids con guión sobreviven (el validador de Android los rechazaba)', () => {
    const apps = parseIosApps(REAL_SHAPE)
    expect(apps.some((a) => a.id === 'LB-Software.PhotoEraser')).toBe(true)
  })

  test('filtra las apps de sistema salvo que se pidan', () => {
    expect(parseIosApps(REAL_SHAPE).some((a) => a.id === 'com.apple.Preferences')).toBe(false)
    expect(
      parseIosApps(REAL_SHAPE, { includeSystem: true }).some(
        (a) => a.id === 'com.apple.Preferences',
      ),
    ).toBe(true)
  })

  test('sin ApplicationType se asume User: mejor mostrar de más que esconder la app buscada', () => {
    const apps = parseIosApps(JSON.stringify({ 'com.x.y': { CFBundleDisplayName: 'X' } }))
    expect(apps).toHaveLength(1)
  })

  test('entrada inválida no rompe el selector', () => {
    expect(parseIosApps('')).toEqual([])
    expect(parseIosApps('no soy json')).toEqual([])
    expect(parseIosApps('[]')).toEqual([])
    expect(parseIosApps('null')).toEqual([])
    // claves que no son bundle ids (el device es input hostil)
    expect(parseIosApps(JSON.stringify({ 'rm -rf /': {}, 'con espacio.app': {} }))).toEqual([])
  })
})

describe('isValidBundleId', () => {
  test('acepta los bundle ids reales de iOS, incluidos los que tienen guión', () => {
    expect(isValidBundleId('com.samplegames.samplearcade')).toBe(true)
    expect(isValidBundleId('LB-Software.PhotoEraser')).toBe(true)
    expect(isValidBundleId('com.apple.mobile-safari')).toBe(true)
    expect(isValidBundleId('com.4d.app')).toBe(true)
  })

  test('rechaza lo que no debería viajar a un comando', () => {
    expect(isValidBundleId('')).toBe(false)
    expect(isValidBundleId('sinpunto')).toBe(false)
    expect(isValidBundleId('con espacio.app')).toBe(false)
    expect(isValidBundleId('com.x; rm -rf /')).toBe(false)
    expect(isValidBundleId('com.$(whoami).app')).toBe(false)
    expect(isValidBundleId('a'.repeat(300) + '.app')).toBe(false)
  })
})
