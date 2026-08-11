// Capacidades por plataforma (ticket 037).
//
// Una métrica puede faltar por DOS razones distintas y el dashboard tiene que tratarlas
// distinto:
//
//   - **No existe en esta plataforma** (temperatura de SoC en iOS, torta java/native/
//     graphics en iOS, jank derivado de SurfaceFlinger en iOS). Es permanente. El tile se
//     **oculta**: un hueco que nunca se va a llenar sólo genera la pregunta "¿está roto?".
//   - **Falló en este tick** (el collector no pudo leer, el comando devolvió basura). Es
//     transitorio. El tile se muestra en **N/A**, que es información: la métrica existe y
//     ahora mismo no se pudo leer.
//
// Este módulo modela la primera. La segunda ya la cubre la convención de `null` por campo
// que el schema tiene desde el ticket 021.
import type { Platform } from './schema'

/** Qué puede medir el profiler en cada plataforma. */
export interface Capabilities {
  /** FPS del compositor (SurfaceFlinger en Android, CoreAnimation en iOS). */
  fps: boolean
  /** frame-times p50/p90/p99 y jank% — sólo Android (histograma present2present). */
  frameTimes: boolean
  /** GPU% de uso. */
  gpu: boolean
  /** desglose de GPU renderer/tiler — sólo iOS (Metal lo expone, Mali no). */
  gpuBreakdown: boolean
  /** CPU del proceso. */
  cpu: boolean
  /** CPU del DEVICE entero (el anillo interno del gauge). */
  deviceCpu: boolean
  /** RAM usada del DEVICE entero (la barra "device used"). */
  deviceMemory: boolean
  /** memoria total de la app. */
  memory: boolean
  /** composición java/native/graphics/code/stack — sólo Android (dumpsys meminfo). */
  memoryBreakdown: boolean
  /** memoria comprimida — sólo iOS (iOS comprime páginas; Android no lo reporta así). */
  memoryCompressed: boolean
  /**
   * ¿El tile de temperatura tiene ALGO que mostrar? True en las dos plataformas: Android
   * mide SoC y batería, iOS sólo batería — pero una temperatura real es una temperatura
   * real y merece su gauge. Antes esta bandera significaba "temperatura de SoC" y en iOS
   * escondía el tile entero, tirando a la basura la de batería, que sí se estaba midiendo.
   */
  temperature: boolean
  /**
   * ¿Existe la temperatura del SoC? Sólo Android (iOS no la expone sin entitlements
   * privados). Define quién va en el aro exterior del gauge: con SoC, el aro es el SoC y
   * la batería pasa al anillo interior; sin SoC, el aro es la batería.
   */
  temperatureSoc: boolean
  /** batería: nivel, temperatura DE BATERÍA, amperaje. */
  battery: boolean
  /** throughput de red del device. */
  network: boolean
  /** captura de logs de la app. */
  logs: boolean
  /** inspector HTTP (proxy MITM + proxy del device seteado por la tool). */
  httpInspector: boolean
}

const ANDROID: Capabilities = {
  fps: true,
  frameTimes: true,
  gpu: true,
  gpuBreakdown: false,
  cpu: true,
  deviceCpu: true,
  deviceMemory: true,
  memory: true,
  memoryBreakdown: true,
  memoryCompressed: false,
  temperature: true,
  temperatureSoc: true,
  battery: true,
  network: true,
  logs: true,
  httpInspector: true,
}

// Todo lo `false` de acá está justificado por el spike 033, medido contra un iPhone real:
//  - frameTimes: `graphics.opengl` da FPS pero NO histograma de frame-times. Recuperarlos
//    exige `coreprofilesessiontap` (ticket 043, sin compromiso) o el SDK Unity.
//  - temperatureSoc: la del SoC no existe sin entitlements privados (el sustituto honesto
//    sería el thermal state que reporte el juego — SDK Unity, en el fog del mapa). La de
//    BATERÍA sí llega por `diagnostics battery`, así que el tile se muestra igual.
//  - memoryBreakdown: sysmontap da physFootprint/resident/compressed, no la composición
//    java/native/graphics de `dumpsys meminfo`.
//  - network / httpInspector: fuera del corte de la iteración 3 (el inspector necesita
//    proxy y CA a mano en el device, sin el `settings put global http_proxy` de Android).
//  - logs SÍ: `syslog live` los entrega y se traducen al mismo LogEntry (ticket 039).
const IOS: Capabilities = {
  fps: true,
  frameTimes: false,
  gpu: true,
  gpuBreakdown: true,
  cpu: true,
  // El CPU y la RAM usada DEL DEVICE existen en iOS (`sysmon system` los trae), pero ese
  // comando es una foto que sale, no una suscripción: pedirlo por tick costaría el
  // handshake del túnel cada vez. Se pide una sola vez para la RAM TOTAL (que no cambia)
  // y estas dos, que sí son dinámicas, quedan fuera del v1.
  deviceCpu: false,
  deviceMemory: false,
  memory: true,
  memoryBreakdown: false,
  memoryCompressed: true,
  // El tile SE MUESTRA: iOS no tiene temperatura de SoC, pero `diagnostics battery` sí da
  // la de batería, y esconder el tile entero desperdiciaba una medición real.
  temperature: true,
  temperatureSoc: false,
  battery: true,
  network: false,
  logs: true,
  httpInspector: false,
}

export function capabilitiesFor(platform: Platform): Capabilities {
  return platform === 'ios' ? { ...IOS } : { ...ANDROID }
}

/**
 * Clave de comparabilidad de una métrica (decisión del grilling 2026-08-10).
 *
 * Dos series entran al MISMO eje de un reporte sólo si comparten clave. Es lo que impide
 * que el `PSS` de Android (prorratea memoria compartida) termine graficado contra el
 * `physFootprint` de iOS (no prorratea, incluye páginas comprimidas): son números
 * distintos midiendo cosas distintas, y en el mismo gráfico inventan una diferencia que
 * no existe.
 *
 * El FPS sí comparte clave: los dos los mide el compositor, no la app.
 */
export function comparabilityKey(metric: string, platform: Platform): string {
  switch (metric) {
    case 'fps':
      return 'fps.compositor'
    case 'cpu':
      // sysmontap reporta % del proceso igual que el share-of-device de Android
      // (verificado en el spike: picos de 52, no 0-1).
      return 'cpu.process-percent'
    case 'memory':
      // NO comparables: distinta definición de "memoria de la app" por plataforma.
      return platform === 'ios' ? 'mem.footprint' : 'mem.pss'
    case 'gpu':
      // Mali `gpu_busy` vs Metal `Device Utilization %` no miden lo mismo.
      return platform === 'ios' ? 'gpu.metal-device' : 'gpu.vendor-busy'
    case 'battery':
      return 'battery.level-percent'
    default:
      return `${metric}.${platform}`
  }
}
