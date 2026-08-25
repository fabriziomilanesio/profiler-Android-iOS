// Preflight gate (ticket 013): la cadena de checks previa a profilear, como
// máquina de estados pura. Estados:
//
//   Start ─(adb?)─→ AdbMissing ✗
//                 → AdbOk ─(devices?)─→ NoDevice ✗
//                                     → DeviceUnauthorized ✗
//                                     → DeviceOk ─(app instalada?)─→ AppMissing ✗
//                                                                  → Ready ✓
//
// `advance` es la transición pura (testeable sin transport); `Preflight.check`
// la maneja contra un AdbTransport real o stub y arma el PreflightReport con
// el estado de cada eslabón y su remedio en texto.

import type { AdbDevice, AdbTransport } from '../adb/AdbTransport'

export type PreflightState =
  | 'Start'
  | 'AdbMissing'
  | 'AdbOk'
  | 'NoDevice'
  | 'DeviceUnauthorized'
  | 'DeviceOk'
  | 'AppMissing'
  | 'Ready'

/** Lo observado en cada paso; alimenta a `advance`. */
export type PreflightObservation =
  | { kind: 'adb'; available: boolean }
  | { kind: 'devices'; devices: AdbDevice[] }
  | { kind: 'app'; installed: boolean }

export type LinkResult = 'ok' | 'fail' | 'skipped'

export interface PreflightLink {
  id: 'adb' | 'device' | 'app'
  label: string
  result: LinkResult
  /** qué se encontró (versión de adb, serial del device, etc.) */
  detail: string
  /** cómo resolverlo, solo cuando result === 'fail' */
  remedy?: string
}

export interface PreflightReport {
  /** estado terminal de la máquina */
  state: PreflightState
  ready: boolean
  links: PreflightLink[]
  /** device usable elegido (primero con state 'device'), desde DeviceOk en adelante */
  device?: AdbDevice
}

/** Transición pura de la máquina de estados. */
export function advance(state: PreflightState, obs: PreflightObservation): PreflightState {
  if (state === 'Start' && obs.kind === 'adb') {
    return obs.available ? 'AdbOk' : 'AdbMissing'
  }
  if (state === 'AdbOk' && obs.kind === 'devices') {
    if (obs.devices.some((d) => d.state === 'device')) return 'DeviceOk'
    if (obs.devices.some((d) => d.state === 'unauthorized')) return 'DeviceUnauthorized'
    return 'NoDevice'
  }
  if (state === 'DeviceOk' && obs.kind === 'app') {
    return obs.installed ? 'Ready' : 'AppMissing'
  }
  throw new Error(`Transición inválida: estado '${state}' no acepta observación '${obs.kind}'`)
}

const REMEDIES = {
  AdbMissing:
    'Instalá los platform-tools de Android (la tool puede descargarlos sola: ' +
    'corré con --install-platform-tools) o configurá la ruta con MOBILE_PROFILER_ADB.',
  NoDevice:
    'Conectá el teléfono por USB y activá la depuración USB ' +
    '(Ajustes → Opciones de desarrollador → Depuración USB).',
  DeviceUnauthorized:
    'El teléfono está conectado pero no autorizado: desbloqueá la pantalla y aceptá el ' +
    'diálogo "¿Permitir depuración USB?" que muestra el device (marcá "Permitir siempre ' +
    'desde este equipo"). Si no aparece, desenchufá y volvé a enchufar el cable.',
  appMissing: (pkg: string) =>
    `La app ${pkg} no está instalada en el device: instalá la build QA ` +
    `(adb install -r <apk>) o pasá otro package con --package.`,
} as const

export class Preflight {
  constructor(
    private readonly transport: AdbTransport,
    private readonly packageName: string,
  ) {}

  /** Corre la cadena completa y devuelve el estado de cada eslabón + remedios. */
  async check(): Promise<PreflightReport> {
    const links: PreflightLink[] = []
    const skip = (id: PreflightLink['id'], label: string): void => {
      links.push({ id, label, result: 'skipped', detail: 'no chequeado (falló un eslabón previo)' })
    }

    // Eslabón 1: adb disponible
    let state = advance('Start', { kind: 'adb', available: await this.transport.isAvailable() })
    if (state === 'AdbMissing') {
      links.push({
        id: 'adb',
        label: 'adb disponible',
        result: 'fail',
        detail: 'no se encontró un binario adb utilizable',
        remedy: REMEDIES.AdbMissing,
      })
      skip('device', 'device conectado y autorizado')
      skip('app', `app ${this.packageName} instalada`)
      return { state, ready: false, links }
    }
    const version = (await this.transport.version()).split('\n')[0] ?? ''
    links.push({ id: 'adb', label: 'adb disponible', result: 'ok', detail: version })

    // Eslabón 2: device conectado y autorizado
    const devices = await this.transport.devices()
    state = advance(state, { kind: 'devices', devices })
    if (state === 'NoDevice' || state === 'DeviceUnauthorized') {
      links.push({
        id: 'device',
        label: 'device conectado y autorizado',
        result: 'fail',
        detail:
          state === 'DeviceUnauthorized'
            ? `device sin autorizar: ${devices
                .filter((d) => d.state === 'unauthorized')
                .map((d) => d.serial)
                .join(', ')}`
            : devices.length === 0
              ? 'ningún device conectado'
              : `devices presentes pero no usables: ${devices.map((d) => `${d.serial} [${d.state}]`).join(', ')}`,
        remedy: state === 'DeviceUnauthorized' ? REMEDIES.DeviceUnauthorized : REMEDIES.NoDevice,
      })
      skip('app', `app ${this.packageName} instalada`)
      return { state, ready: false, links }
    }
    const device = devices.find((d) => d.state === 'device')!
    links.push({
      id: 'device',
      label: 'device conectado y autorizado',
      result: 'ok',
      detail: `${device.serial}${device.description ? ` (${device.description})` : ''}`,
    })

    // Eslabón 3: app instalada (pm list packages <pkg> vía transport.shell)
    const shell = await this.transport.shell(device.serial, `pm list packages ${this.packageName}`)
    // pm filtra por substring: exigir la línea exacta `package:<pkg>`
    const installed =
      shell.exitCode === 0 &&
      shell.stdout.split('\n').some((line) => line.trim() === `package:${this.packageName}`)
    state = advance(state, { kind: 'app', installed })
    if (state === 'AppMissing') {
      links.push({
        id: 'app',
        label: `app ${this.packageName} instalada`,
        result: 'fail',
        detail:
          shell.exitCode !== 0
            ? `pm list packages falló (exit ${shell.exitCode}): ${shell.stderr.trim()}`
            : `el package no figura en el device`,
        remedy: REMEDIES.appMissing(this.packageName),
      })
      return { state, ready: false, links, device }
    }
    links.push({
      id: 'app',
      label: `app ${this.packageName} instalada`,
      result: 'ok',
      detail: `package:${this.packageName} presente`,
    })

    return { state: 'Ready', ready: true, links, device }
  }
}
