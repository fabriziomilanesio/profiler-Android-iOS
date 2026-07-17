// Parser de FPS (ticket 021).
//
// Fuente primaria (confirmada, Unity): `dumpsys SurfaceFlinger --timestats -dump`
// → campo `averageFPS` del layer de la app (los buffers presentados que SurfaceFlinger
// sí ve; gfxinfo da 0 frames en Unity — NO usar). Ver research §2.
//
// OJO (bug real observado en device): el dump lista VARIOS layers (NotificationShade,
// StatusBar, el SurfaceView de la app…), cada uno con su `averageFPS`. Hay que quedarse
// con el averageFPS del bloque cuyo `layerName` matchea la SurfaceView del package,
// no con el primero. Si no se pasa package (o no matchea), cae al primer averageFPS.
//
// Requiere que timestats esté habilitado (Sampler.init hace `--timestats -enable`);
// si no hay frames presentándose (app idle/background) el layer no aparece → N/A.
//
// Fallback (research §2, NO implementado acá): `--latency '<layer>'`.

function firstAverageFps(text: string): number | null {
  const m = text.match(/averageFPS\s*=\s*([\d.]+)/)
  if (!m || m[1] === undefined) return null
  const fps = Number(m[1])
  return Number.isFinite(fps) ? fps : null
}

export function parseFps(timestatsDump: string, packageName?: string): number | null {
  if (packageName) {
    // Recorrer los bloques por layer; quedarnos con el averageFPS del que menciona el package.
    // El dump separa layers con líneas "layerName = ...". Partimos por esa marca.
    const blocks = timestatsDump.split(/^layerName\s*=\s*/m)
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i]!
      // la primera línea del bloque es el nombre del layer
      const layerLine = block.split('\n', 1)[0] ?? ''
      if (layerLine.includes(packageName)) {
        const fps = firstAverageFps(block)
        if (fps !== null) return fps
      }
    }
    // no encontramos el layer de la app (idle/background o dump legacy sin layers) → N/A
    // salvo que el dump NO tenga layers (formato "Legacy stats"): ahí cae al global.
    if (/^layerName\s*=/m.test(timestatsDump)) return null
  }
  return firstAverageFps(timestatsDump)
}
