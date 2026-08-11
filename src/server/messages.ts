// Protocolo del WebSocket entre el server y el dashboard (ticket 021).
// Mensajes tipados serializados a JSON. Al conectar: {type:"device"} + {type:"app"};
// por tick: {type:"sample"}; al cambiar de app desde el selector: {type:"app"};
// logs en batch (ticket 027): {type:"logs", entries} — nunca una entrada por
// mensaje (un logcat a chorro no debe generar un mensaje WS por línea). El
// bootstrap del panel (últimas N) va por GET /api/logs.
import type { DeviceInfo, Sample } from '../core/schema'
import type { Capabilities } from '../core/platform'
import type { LogEntry } from '../core/logs/logEntry'
import type { InspectorFlow } from './inspectorProxy'

/** Estado de la app profileada (selector de apps). */
export interface AppStatus {
  packageName: string
  /** pid del proceso; null = todavía no está corriendo (el sampler engancha cuando aparezca). */
  pid: number | null
  /** true si el server la lanzó automáticamente (no estaba corriendo al seleccionarla). */
  launched: boolean
}

export type ServerMessage =
  | { type: 'device'; device: DeviceInfo; capabilities?: Capabilities }
  | { type: 'sample'; sample: Sample }
  | { type: 'flow'; flow: InspectorFlow }
  | { type: 'app'; app: AppStatus }
  | { type: 'logs'; entries: LogEntry[] }

/**
 * Ficha del device + qué puede medir esta plataforma (ticket 037). La UI usa las
 * capacidades para ESCONDER lo que no existe en el device — un tile permanentemente
 * vacío se lee como "está roto", que es peor que no mostrarlo.
 */
export function deviceMessage(device: DeviceInfo, capabilities?: Capabilities): string {
  return JSON.stringify({ type: 'device', device, capabilities } satisfies ServerMessage)
}

export function sampleMessage(sample: Sample): string {
  return JSON.stringify({ type: 'sample', sample } satisfies ServerMessage)
}

export function flowMessage(flow: InspectorFlow): string {
  return JSON.stringify({ type: 'flow', flow } satisfies ServerMessage)
}

export function appMessage(app: AppStatus): string {
  return JSON.stringify({ type: 'app', app } satisfies ServerMessage)
}

export function logsMessage(entries: LogEntry[]): string {
  return JSON.stringify({ type: 'logs', entries } satisfies ServerMessage)
}
