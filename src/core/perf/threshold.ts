// Semáforo de FPS (ticket 025): verde ≥ target · amarillo ≥ 80% del target · rojo abajo.
// Función pura, sin dependencias: el dashboard la espeja en render.js (UI JS plano) y el
// reporte del ticket 026 la importa para el veredicto de perf de la ventana exportada.
//
// Best-effort/null-safe como el resto del core: sin FPS (o target inválido) ⇒ null,
// nunca rojo — "no sé" no es "mal".

export type FpsStatus = 'green' | 'yellow' | 'red'

/** Fracción del target que separa amarillo de rojo (amarillo = FPS ≥ 80% del target). */
export const FPS_YELLOW_RATIO = 0.8

/**
 * Estado de semáforo para un valor de FPS contra el target configurado.
 * null ⇒ sin dato (fps null/no-finito/negativo, o target inválido): sin color.
 */
export function fpsStatus(fps: number | null, target: number): FpsStatus | null {
  if (fps === null || !Number.isFinite(fps) || fps < 0) return null
  if (!Number.isFinite(target) || target <= 0) return null
  if (fps >= target) return 'green'
  if (fps >= target * FPS_YELLOW_RATIO) return 'yellow'
  return 'red'
}
