// Protocolo del WebSocket entre el server y el dashboard (ticket 021).
// Mensajes tipados serializados a JSON. Al conectar: {type:"device"}; por tick: {type:"sample"}.
import type { DeviceInfo, Sample } from '../core/schema'
import type { InspectorFlow } from './inspectorProxy'

export type ServerMessage =
  | { type: 'device'; device: DeviceInfo }
  | { type: 'sample'; sample: Sample }
  | { type: 'flow'; flow: InspectorFlow }

export function deviceMessage(device: DeviceInfo): string {
  return JSON.stringify({ type: 'device', device } satisfies ServerMessage)
}

export function sampleMessage(sample: Sample): string {
  return JSON.stringify({ type: 'sample', sample } satisfies ServerMessage)
}

export function flowMessage(flow: InspectorFlow): string {
  return JSON.stringify({ type: 'flow', flow } satisfies ServerMessage)
}
