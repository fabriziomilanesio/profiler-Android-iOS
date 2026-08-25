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

/**
 * Estado del vínculo con el device (ticket 046). Es del CABLE, no del WebSocket: el
 * dashboard ya sabe solo si perdió al server (el WS se cae), pero no tenía forma de saber
 * si el server perdió al teléfono.
 *
 *  - `connected`    — hay device y sus canales entregan.
 *  - `reconnecting` — el canal vital se cayó; ventana de gracia, todavía no se soltó nada.
 *  - `lost`         — no hay device; el watcher está esperando que vuelva.
 */
export type ConnectionState = 'connected' | 'reconnecting' | 'lost'

/** Carril de visualización. El primario conserva el protocolo anterior al omitirse. */
export type DashboardPane = 'primary' | 'secondary'

export type ServerMessage =
  | { type: 'device'; device: DeviceInfo; capabilities?: Capabilities; pane?: DashboardPane }
  | { type: 'sample'; sample: Sample; pane?: DashboardPane }
  | { type: 'flow'; flow: InspectorFlow }
  | { type: 'app'; app: AppStatus; pane?: DashboardPane }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'connection'; state: ConnectionState; serial: string | null; pane?: DashboardPane }

/**
 * Ficha del device + qué puede medir esta plataforma (ticket 037). La UI usa las
 * capacidades para ESCONDER lo que no existe en el device — un tile permanentemente
 * vacío se lee como "está roto", que es peor que no mostrarlo.
 */
export function deviceMessage(
  device: DeviceInfo,
  capabilities?: Capabilities,
  pane?: DashboardPane,
): string {
  return JSON.stringify({ type: 'device', device, capabilities, pane } satisfies ServerMessage)
}

export function sampleMessage(sample: Sample, pane?: DashboardPane): string {
  return JSON.stringify({ type: 'sample', sample, pane } satisfies ServerMessage)
}

export function flowMessage(flow: InspectorFlow): string {
  return JSON.stringify({ type: 'flow', flow } satisfies ServerMessage)
}

export function appMessage(app: AppStatus, pane?: DashboardPane): string {
  return JSON.stringify({ type: 'app', app, pane } satisfies ServerMessage)
}

/**
 * Se emite en cada transición Y en `onOpen`: un dashboard que se abre con el device caído
 * recibe igual la ficha del último device conocido, así que sin este mensaje pintaría un
 * teléfono que no está.
 */
export function connectionMessage(
  state: ConnectionState,
  serial: string | null,
  pane?: DashboardPane,
): string {
  return JSON.stringify({ type: 'connection', state, serial, pane } satisfies ServerMessage)
}

export function logsMessage(entries: LogEntry[]): string {
  return JSON.stringify({ type: 'logs', entries } satisfies ServerMessage)
}
