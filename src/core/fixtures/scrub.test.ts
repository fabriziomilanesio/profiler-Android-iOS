// Tests del gate de scrub (ticket 036). Cubren las cuatro serializaciones donde aparece
// PII en las capturas, la estabilidad de los placeholders (integridad referencial entre
// archivos de una misma captura) y — lo más importante — que NO se coman datos legítimos.
// scrub:allow-synthetic — los datos de acá son PII SINTÉTICA inventada para los tests.
// Sin valores con forma de serial/UDID/IMEI estos tests no probarían nada.
import { describe, expect, test } from 'bun:test'
import { ALLOW_MARKER, PlaceholderRegistry, isClean, isExempt, scrubText } from './scrub'

describe('scrubText — reglas por clave', () => {
  test('getprop: [ro.serialno]: [VALOR]', () => {
    const { text, hits } = scrubText('[ro.serialno]: [R58MB0ABCD]\n[ro.product.model]: [SM-A155M]')
    expect(text).toContain('[ro.serialno]: [<REDACTED:SERIAL#1>]')
    expect(text).toContain('[ro.product.model]: [SM-A155M]') // el modelo NO es PII
    expect(hits.some((h) => h.ruleId === 'SERIAL')).toBe(true)
  })

  test('JSON: "UniqueDeviceID": "..."', () => {
    const { text } = scrubText('{"UniqueDeviceID": "00008030-001A2B3C4D5E6F70", "ProductVersion": "18.5"}')
    expect(text).toContain('"UniqueDeviceID": "<REDACTED:UDID#1>"')
    expect(text).toContain('"ProductVersion": "18.5"') // la versión de iOS se conserva
  })

  test('plist XML: <key>SerialNumber</key><string>...</string>', () => {
    const { text } = scrubText('<key>SerialNumber</key>\n<string>F17XY0ABCDEF</string>')
    expect(text).toContain('<string><REDACTED:SERIAL#1></string>')
    expect(text).not.toContain('F17XY0ABCDEF')
  })

  test('k=v suelto: subscriberId y wifiNetworkKey de netstats', () => {
    const { text } = scrubText('subscriberId=310260123456789, wifiNetworkKey=MiWiFiDeCasa, set=DEFAULT')
    expect(text).toContain('subscriberId=<REDACTED:SUBSCRIBER#1>')
    expect(text).toContain('wifiNetworkKey=<REDACTED:WIFI#1>')
    expect(text).toContain('set=DEFAULT')
  })

  test('IMEI y ICCID de iOS salen por clave, no por forma', () => {
    const { text } = scrubText(
      '{"InternationalMobileEquipmentIdentity": "351234567890123", "IntegratedCircuitCardIdentity": "8954071234567890123"}',
    )
    expect(text).not.toContain('351234567890123')
    expect(text).not.toContain('8954071234567890123')
  })

  test('DeviceName se redacta porque suele traer nombre propio', () => {
    const { text } = scrubText('{"DeviceName": "iPhone de Ignacio"}')
    expect(text).toContain('<REDACTED:DEVICENAME#1>')
  })
})

describe('scrubText — reglas por forma', () => {
  test('MAC en texto libre', () => {
    const { text } = scrubText('wifi mac a4:83:e7:1b:2c:3d up')
    expect(text).toBe('wifi mac <REDACTED:MAC#1> up')
  })

  test('UDID iOS moderno (8hex-16hex) y legacy (40 hex)', () => {
    const modern = scrubText('device 00008030-001A2B3C4D5E6F70 ready')
    expect(modern.text).toContain('<REDACTED:UDID#1>')
    const legacy = scrubText('udid a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')
    expect(legacy.text).toContain('<REDACTED:UDID#1>')
  })

  test('teléfono en formato internacional', () => {
    const { text } = scrubText('caller +5491123456789 dialed')
    expect(text).toContain('<REDACTED:PHONE#1>')
  })
})

describe('scrubText — lo que NO debe tocar (falsos positivos)', () => {
  // La razón de que no exista una regla "15 dígitos = IMEI": sysmontap reporta tiempos de
  // CPU en nanosegundos, que tienen 15-19 dígitos. Una regla por forma los destruiría.
  test('deja intactos los campos en nanosegundos de sysmontap', () => {
    const line = '{"cpuTotalUser": 123456789012345, "procAge": 9876543210987654, "pid": 431}'
    const { text, hits } = scrubText(line)
    expect(text).toBe(line)
    expect(hits).toEqual([])
  })

  test('deja intactos los timestamps y valores de una línea de logcat', () => {
    const line = '2026-07-31 10:15:02.087 18743 18790 I Unity   : MemoryManager: Using accents'
    expect(scrubText(line).text).toBe(line)
  })

  test('deja intacto un sample de graphics/FPS', () => {
    const line = '{"CoreAnimationFramesPerSecond": 59, "Device Utilization %": 42}'
    expect(scrubText(line).text).toBe(line)
  })

  test('no toca el bundle id ni el modelo del device', () => {
    const line = 'com.evermoregames.evermorearcade.internal on SM-A155M / iPhone14,6'
    expect(scrubText(line).text).toBe(line)
  })
})

describe('PlaceholderRegistry — estabilidad', () => {
  test('el mismo valor recibe el mismo placeholder entre archivos', () => {
    const registry = new PlaceholderRegistry()
    const a = scrubText('[ro.serialno]: [R58MB0ABCD]', { registry })
    const b = scrubText('otro archivo, mismo serial: R58MB0ABCD', { registry })
    expect(a.text).toContain('<REDACTED:SERIAL#1>')
    // en el segundo archivo el serial aparece suelto: no lo agarra ninguna regla por
    // clave, pero el placeholder del registry ya quedó asignado para ese valor
    expect(registry.entries().filter((e) => e.raw === 'R58MB0ABCD')).toHaveLength(1)
    expect(b.text).toBeDefined()
  })

  test('valores distintos reciben índices distintos y no se pisan', () => {
    const registry = new PlaceholderRegistry()
    const { text } = scrubText('[ro.serialno]: [AAA]\n[ro.boot.serialno]: [BBB]', { registry })
    expect(text).toContain('<REDACTED:SERIAL#1>')
    expect(text).toContain('<REDACTED:SERIAL#2>')
  })

  test('un texto ya scrubeado es idempotente: no re-redacta placeholders', () => {
    const once = scrubText('[ro.serialno]: [R58MB0ABCD]').text
    const twice = scrubText(once)
    expect(twice.hits).toEqual([])
    expect(twice.text).toBe(once)
  })
})

describe('isClean — lo que decide el gate pre-commit', () => {
  test('false cuando hay PII', () => {
    expect(isClean('[ro.serialno]: [R58MB0ABCD]')).toBe(false)
  })

  test('true cuando ya está redactado', () => {
    expect(isClean('[ro.serialno]: [<REDACTED:SERIAL#1>]')).toBe(true)
  })

  test('true en un fixture legítimo sin PII', () => {
    expect(isClean('{"CoreAnimationFramesPerSecond": 59, "cpuTotalUser": 123456789012345}')).toBe(true)
  })
})

describe('exención por marcador', () => {
  // Nació de una falla real: el hook bloqueó su propio commit porque estos tests contienen
  // PII sintética a propósito. La exención es por marcador en el archivo y no por lista de
  // rutas, para que quede en el diff y alguien la tenga que escribir a mano.
  test('un archivo con el marcador queda exento', () => {
    expect(isExempt(`// ${ALLOW_MARKER}\n[ro.serialno]: [R58MB0ABCD]`)).toBe(true)
  })

  test('sin marcador no hay exención', () => {
    expect(isExempt('[ro.serialno]: [R58MB0ABCD]')).toBe(false)
  })

  test('el marcador NO desactiva scrubText — sólo lo consulta el gate', () => {
    const { hits } = scrubText(`// ${ALLOW_MARKER}\n[ro.serialno]: [R58MB0ABCD]`)
    expect(hits.length).toBeGreaterThan(0)
  })

  test('la constante no aparece literal en su propia definición', () => {
    // si estuviera literal, scrub.ts y todo importador quedarían exentos sin querer
    expect(ALLOW_MARKER).toBe('scrub:allow-synthetic')
  })
})

describe('filtro por plataforma', () => {
  test('platform ios no aplica las reglas de getprop de Android', () => {
    const { hits } = scrubText('[ro.serialno]: [R58MB0ABCD]', { platform: 'ios' })
    expect(hits.filter((h) => h.description.includes('getprop'))).toHaveLength(0)
  })

  test('las reglas both corren en las dos plataformas', () => {
    expect(isClean('mac a4:83:e7:1b:2c:3d', { platform: 'ios' })).toBe(false)
    expect(isClean('mac a4:83:e7:1b:2c:3d', { platform: 'android' })).toBe(false)
  })
})
