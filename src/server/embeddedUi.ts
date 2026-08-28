// Manifest de assets del dashboard embebidos en el ejecutable (`bun build --compile`).
// En dev los estáticos se sirven del disco (src/ui); en un binario compilado ese
// directorio no existe, así que el server cae a estas rutas embebidas (bunfs).
// Si agregás un asset a src/ui, sumalo acá o el .exe lo servirá 404.
import indexHtml from '../ui/index.html' with { type: 'file' }
import renderJs from '../ui/render.js' with { type: 'file' }
import liveJs from '../ui/live.js' with { type: 'file' }
import capabilitiesJs from '../ui/capabilities.js' with { type: 'file' }
import dualComparisonJs from '../ui/dualComparison.js' with { type: 'file' }
import logsCoreJs from '../ui/logsCore.js' with { type: 'file' }
import logsPanelJs from '../ui/logsPanel.js' with { type: 'file' }
import echarts from '../ui/vendor/echarts.min.js' with { type: 'file' }
import motion from '../ui/vendor/motion.min.js' with { type: 'file' }
import inter400 from '../ui/vendor/fonts/inter-latin-400-normal.woff2' with { type: 'file' }
import inter500 from '../ui/vendor/fonts/inter-latin-500-normal.woff2' with { type: 'file' }
import inter600 from '../ui/vendor/fonts/inter-latin-600-normal.woff2' with { type: 'file' }
import inter700 from '../ui/vendor/fonts/inter-latin-700-normal.woff2' with { type: 'file' }
import baloo600 from '../ui/vendor/fonts/baloo-2-latin-600-normal.woff2' with { type: 'file' }
import baloo700 from '../ui/vendor/fonts/baloo-2-latin-700-normal.woff2' with { type: 'file' }
import baloo800 from '../ui/vendor/fonts/baloo-2-latin-800-normal.woff2' with { type: 'file' }

/** ruta relativa del request (con /) → ruta del asset embebido, legible con readFileSync. */
export const EMBEDDED_UI: Record<string, string> = {
  // @types/bun tipa los import de .html como HTMLBundle (loader html); con
  // `type: 'file'` el runtime devuelve la ruta igual que el resto.
  'index.html': indexHtml as unknown as string,
  'render.js': renderJs,
  'live.js': liveJs,
  'capabilities.js': capabilitiesJs,
  'dualComparison.js': dualComparisonJs,
  'logsCore.js': logsCoreJs,
  'logsPanel.js': logsPanelJs,
  'vendor/echarts.min.js': echarts,
  'vendor/motion.min.js': motion,
  'vendor/fonts/inter-latin-400-normal.woff2': inter400,
  'vendor/fonts/inter-latin-500-normal.woff2': inter500,
  'vendor/fonts/inter-latin-600-normal.woff2': inter600,
  'vendor/fonts/inter-latin-700-normal.woff2': inter700,
  'vendor/fonts/baloo-2-latin-600-normal.woff2': baloo600,
  'vendor/fonts/baloo-2-latin-700-normal.woff2': baloo700,
  'vendor/fonts/baloo-2-latin-800-normal.woff2': baloo800,
}
