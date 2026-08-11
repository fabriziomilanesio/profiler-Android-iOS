// Redacción de PII en capturas crudas de device (ticket 036).
//
// Por qué es un gate automatizado y no un checklist: el checklist manual del README de
// fixtures YA falló una vez — por eso existe la rama `pre-publish-history`, que conserva
// el serial real del Galaxy A15 sin redactar y no se puede pushear a ningún remoto.
//
// DOS FAMILIAS DE REGLAS, y la distinción importa:
//
//  - **Por clave** (`key`): redacta el VALOR de una propiedad conocida, sin importar su
//    forma. Es la familia confiable, porque no adivina: si la clave se llama `SerialNumber`,
//    su valor es PII y punto. Cubre las cuatro serializaciones que aparecen en las
//    capturas: getprop (`[k]: [v]`), `k=v`, JSON (`"k": "v"`) y plist XML.
//
//  - **Por forma** (`pattern`): para texto libre (logcat, syslog) donde no hay clave.
//    Sólo patrones de ALTA especificidad. Deliberadamente NO hay regla de "15 dígitos =
//    IMEI": los campos de sysmontap en nanosegundos (`cpuTotalUser`, `procAge`) tienen
//    15–19 dígitos y una regla así destruiría datos reales. El IMEI se ataca por clave.
//
// Los placeholders son ESTABLES dentro de una corrida: el mismo valor crudo recibe siempre
// el mismo `<REDACTED:UDID#1>`, así los fixtures que se referencian entre archivos siguen
// cruzando. No se usa hash: para valores de baja entropía (teléfono, IMEI) un sha256 es
// reversible por fuerza bruta en segundos.

// scrub:allow-synthetic — este archivo LISTA los patrones de PII; por definición
// contiene texto con esa forma. Exención consciente, visible en el diff.

export type Platform = 'android' | 'ios' | 'both'

export interface ScrubRule {
  /** id corto, aparece en el placeholder */
  id: string
  description: string
  platform: Platform
  /** nombre de propiedad cuyo VALOR se redacta (familia confiable) */
  key?: string
  /** patrón de alta especificidad para texto libre */
  pattern?: RegExp
}

export const PII_RULES: readonly ScrubRule[] = [
  // ── Android: el checklist de fixtures/sm-a155m-api36/README.md, ahora ejecutable
  { id: 'SERIAL', description: 'serial del device', platform: 'android', key: 'ro.serialno' },
  { id: 'SERIAL', description: 'serial de boot', platform: 'android', key: 'ro.boot.serialno' },
  { id: 'SERIAL', description: 'serial del AP', platform: 'android', key: 'ro.boot.ap_serial' },
  { id: 'SUBSCRIBER', description: 'subscriberId de netstats', platform: 'android', key: 'subscriberId' },
  { id: 'WIFI', description: 'SSID/clave de red en netstats', platform: 'android', key: 'wifiNetworkKey' },
  { id: 'BOOTID', description: 'device id de boot', platform: 'android', key: 'ro.boot.em.did' },
  { id: 'BOOTID', description: 'attestation key de boot', platform: 'android', key: 'ro.boot.kg.ap' },

  // ── iOS: lockdown expone bastante más que Android
  { id: 'UDID', description: 'UDID del device', platform: 'ios', key: 'UniqueDeviceID' },
  { id: 'UDID', description: 'UDID (campo Identifier de usbmux)', platform: 'ios', key: 'Identifier' },
  { id: 'ECID', description: 'chip id único', platform: 'ios', key: 'UniqueChipID' },
  { id: 'ECID', description: 'ECID', platform: 'ios', key: 'ECID' },
  { id: 'SERIAL', description: 'número de serie', platform: 'ios', key: 'SerialNumber' },
  { id: 'SERIAL', description: 'serie de la placa', platform: 'ios', key: 'MLBSerialNumber' },
  { id: 'IMEI', description: 'IMEI', platform: 'ios', key: 'InternationalMobileEquipmentIdentity' },
  { id: 'IMEI', description: 'IMEI 2', platform: 'ios', key: 'InternationalMobileEquipmentIdentity2' },
  { id: 'MEID', description: 'MEID', platform: 'ios', key: 'MobileEquipmentIdentifier' },
  { id: 'ICCID', description: 'ICCID de la SIM', platform: 'ios', key: 'IntegratedCircuitCardIdentity' },
  { id: 'IMSI', description: 'IMSI', platform: 'ios', key: 'InternationalMobileSubscriberIdentity' },
  { id: 'PHONE', description: 'número de teléfono', platform: 'ios', key: 'PhoneNumber' },
  { id: 'MAC', description: 'MAC de wifi', platform: 'ios', key: 'WiFiAddress' },
  { id: 'MAC', description: 'MAC de bluetooth', platform: 'ios', key: 'BluetoothAddress' },
  { id: 'MAC', description: 'MAC de ethernet', platform: 'ios', key: 'EthernetAddress' },
  // DeviceName suele traer el nombre de la persona ("iPhone de Ignacio")
  { id: 'DEVICENAME', description: 'nombre del device (suele traer nombre propio)', platform: 'ios', key: 'DeviceName' },
  { id: 'ACCOUNT', description: 'token de cuenta', platform: 'ios', key: 'AccountToken' },

  // ── Por forma, sólo alta especificidad
  {
    id: 'MAC',
    description: 'dirección MAC en texto libre',
    platform: 'both',
    pattern: /\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g,
  },
  {
    id: 'UDID',
    description: 'UDID iOS moderno (8hex-16hex)',
    platform: 'ios',
    pattern: /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b/g,
  },
  {
    id: 'UDID',
    description: 'UDID iOS legacy (40 hex)',
    platform: 'ios',
    pattern: /\b[0-9a-f]{40}\b/g,
  },
  {
    id: 'PHONE',
    description: 'teléfono en formato internacional',
    platform: 'both',
    pattern: /\+\d{9,15}\b/g,
  },
] as const

/** Un valor crudo detectado y su placeholder estable. */
export interface Redaction {
  ruleId: string
  raw: string
  placeholder: string
}

/**
 * Asigna placeholders estables. Compartir una misma instancia entre archivos mantiene la
 * integridad referencial de una captura (el mismo serial redacta igual en los 30 ticks).
 */
export class PlaceholderRegistry {
  private readonly byRaw = new Map<string, string>()
  private readonly countByRule = new Map<string, number>()

  placeholderFor(ruleId: string, raw: string): string {
    const cached = this.byRaw.get(raw)
    if (cached !== undefined) return cached
    const next = (this.countByRule.get(ruleId) ?? 0) + 1
    this.countByRule.set(ruleId, next)
    const placeholder = `<REDACTED:${ruleId}#${next}>`
    this.byRaw.set(raw, placeholder)
    return placeholder
  }

  /** Todo lo redactado hasta ahora, para el reporte del gate. */
  entries(): Redaction[] {
    return [...this.byRaw.entries()].map(([raw, placeholder]) => ({
      ruleId: placeholder.slice('<REDACTED:'.length, placeholder.indexOf('#')),
      raw,
      placeholder,
    }))
  }
}

/** Las cuatro serializaciones donde puede aparecer `key: value` en una captura. */
function keyPatterns(key: string): RegExp[] {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    // getprop: [ro.serialno]: [R58MB0XXXX]
    new RegExp(`(\\[${k}\\]:\\s*\\[)([^\\]]+)(\\])`, 'g'),
    // JSON: "UniqueDeviceID": "0000..."   (y variantes sin comillas en la clave)
    new RegExp(`("?${k}"?\\s*:\\s*")([^"]+)(")`, 'g'),
    // plist XML: <key>SerialNumber</key>\n<string>F17...</string>
    new RegExp(`(<key>${k}</key>\\s*<(?:string|integer)>)([^<]+)(</)`, 'g'),
    // k=v suelto (netstats, getprop plano): corta en espacio, coma, } o fin de línea
    new RegExp(`(\\b${k}=)([^\\s,}\\n]+)`, 'g'),
  ]
}

/**
 * Un valor que ya es un placeholder no se vuelve a redactar. Importa porque el gate corre
 * una y otra vez sobre los mismos archivos: sin esto, cada pasada envolvería la anterior
 * y el fixture cambiaría en cada commit.
 */
const PLACEHOLDER = /^<REDACTED:[A-Z]+#\d+>$/

export interface ScrubHit {
  ruleId: string
  description: string
  /** cuántas ocurrencias se reemplazaron */
  count: number
}

export interface ScrubOutcome {
  text: string
  hits: ScrubHit[]
}

export interface ScrubOptions {
  /** limita las reglas aplicadas; por defecto corren todas */
  platform?: Platform
  registry?: PlaceholderRegistry
}

/**
 * Redacta todas las ocurrencias de PII conocida en `text`.
 *
 * Las reglas por clave corren PRIMERO: si un valor ya quedó reemplazado por su
 * placeholder, las reglas por forma no lo vuelven a tocar (el placeholder no matchea
 * ninguno de los patrones de forma).
 */
export function scrubText(text: string, options: ScrubOptions = {}): ScrubOutcome {
  const registry = options.registry ?? new PlaceholderRegistry()
  const wanted = options.platform
  const rules = PII_RULES.filter(
    (r) => wanted === undefined || r.platform === 'both' || r.platform === wanted,
  )
  const hitsById = new Map<string, ScrubHit>()
  let out = text

  const record = (rule: ScrubRule, count: number): void => {
    if (count === 0) return
    const key = `${rule.id}:${rule.description}`
    const existing = hitsById.get(key)
    if (existing) existing.count += count
    else hitsById.set(key, { ruleId: rule.id, description: rule.description, count })
  }

  for (const rule of rules.filter((r) => r.key !== undefined)) {
    for (const re of keyPatterns(rule.key as string)) {
      let count = 0
      out = out.replace(re, (match: string, before: string, value: string, after = '') => {
        if (PLACEHOLDER.test(value)) return match
        count += 1
        return `${before}${registry.placeholderFor(rule.id, value)}${after}`
      })
      record(rule, count)
    }
  }

  for (const rule of rules.filter((r) => r.pattern !== undefined)) {
    let count = 0
    out = out.replace(new RegExp(rule.pattern as RegExp), (match: string) => {
      count += 1
      return registry.placeholderFor(rule.id, match)
    })
    record(rule, count)
  }

  return { text: out, hits: [...hitsById.values()] }
}

/** true si el texto NO tiene PII detectable — lo que el gate pre-commit exige. */
export function isClean(text: string, options: ScrubOptions = {}): boolean {
  return scrubText(text, options).hits.length === 0
}

/**
 * Marcador de exención. Un archivo que lo contiene queda fuera del gate.
 *
 * Existe porque hay código que NECESITA parecer PII: los tests de este mismo módulo, que
 * sin datos con forma de serial/UDID/IMEI no probarían nada. La exención es por marcador
 * explícito dentro del archivo y no por lista de rutas a propósito — así aparece en el
 * diff, alguien la tiene que escribir a mano, y se revisa como cualquier otro cambio.
 * Una lista de rutas en el script se agranda sola y nadie la mira.
 */
// Se arma por partes a propósito: si el literal estuviera acá, este archivo (y
// cualquiera que importe la constante) quedaría exento sin querer.
export const ALLOW_MARKER = ['scrub', 'allow-synthetic'].join(':')

export function isExempt(text: string): boolean {
  return text.includes(ALLOW_MARKER)
}
