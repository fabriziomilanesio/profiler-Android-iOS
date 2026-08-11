// Parser del canal `com.apple.instruments.server.services.graphics.opengl` (ticket 038).
//
// `pymobiledevice3 developer dvt graphics` emite UN JSON por línea. Las claves salen del
// device tal cual — no las normaliza nadie — así que esta lista se capturó del iPhone real
// en el spike 033 (iPhone15,3 / iOS 26.5.2) y está documentada en ese ticket.
//
// Es el equivalente iOS del parser de `dumpsys SurfaceFlinger --timestats`, con una
// diferencia que define el corte de la iteración 3: **acá no hay histograma de
// frame-times**, así que p50/p90/p99 y jank no son derivables (ver capabilities).

/** Una muestra del canal de gráficos. Todo nullable: campos que el device no mandó. */
export interface IosGraphicsSample {
  /**
   * FPS del compositor (CoreAnimation).
   *
   * OJO: `0` es un valor LEGÍTIMO — significa "no se compuso ningún frame en esta
   * ventana" (app en segundo plano, pantalla quieta). No es lo mismo que `null`, que es
   * "el device no mandó el campo". Confundirlos arruina el promedio de la sesión: en una
   * captura real de 149 muestras, 107 fueron ceros de app en background y el promedio
   * crudo daba 16 FPS contra 57 reales.
   */
  fps: number | null
  /** uso de GPU total (`Device Utilization %`) — el análogo del gpu_busy de Android. */
  gpu: number | null
  /** parte del renderer (no tiene equivalente en Android). */
  gpuRenderer: number | null
  /** parte del tiler (no tiene equivalente en Android). */
  gpuTiler: number | null
  /** memoria de GPU en uso, en MB. */
  gpuMemUsedMb: number | null
  /** memoria de GPU asignada, en MB. */
  gpuMemAllocMb: number | null
  /**
   * Recuperaciones del driver de GPU desde que arrancó el canal. Un salto acá es un
   * evento feo (el driver se reinició); candidato a marca en el timeline del reporte.
   */
  recoveryCount: number | null
}

const BYTES_TO_MB = 1 / (1024 * 1024)

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function mb(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * BYTES_TO_MB
}

/**
 * Parsea una línea del stream. Devuelve null si la línea no es un JSON de muestra
 * (`pymobiledevice3` mezcla warnings y banners en el mismo stdout/stderr).
 */
export function parseGraphicsLine(line: string): IosGraphicsSample | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
  // Una muestra de gráficos SIEMPRE trae el FPS de CoreAnimation; si no está, es otro
  // tipo de mensaje del canal y no se inventa un sample vacío.
  if (!('CoreAnimationFramesPerSecond' in obj)) return null

  return {
    fps: num(obj['CoreAnimationFramesPerSecond']),
    gpu: num(obj['Device Utilization %']),
    gpuRenderer: num(obj['Renderer Utilization %']),
    gpuTiler: num(obj['Tiler Utilization %']),
    gpuMemUsedMb: mb(obj['In use system memory']),
    gpuMemAllocMb: mb(obj['Alloc system memory']),
    recoveryCount: num(obj['recoveryCount']),
  }
}
