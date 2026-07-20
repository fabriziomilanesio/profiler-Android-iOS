// Generador del reporte HTML standalone: ensambla template + ECharts + fuentes +
// logos + datos de la sesión en UN archivo auto-contenido (se abre sin el profiler).
// Los assets se leen vía imports `type:'file'`: ruta de disco en dev, bunfs en el
// binario compilado — readFileSync funciona en ambos.
import { readFileSync } from 'node:fs'
import templateHtmlPath from './template.html' with { type: 'file' }
import templateJsPath from './template.js' with { type: 'file' }
import { EMBEDDED_UI } from '../server/embeddedUi'
import type { ReportSession } from '../core/session/stats'

function read(path: string): Buffer {
  return readFileSync(path)
}

function dataUri(mime: string, path: string): string {
  return `data:${mime};base64,${read(path).toString('base64')}`
}

/** @font-face con las fuentes embebidas (el reporte no puede depender de la red). */
function fontsCss(): string {
  const face = (family: string, weight: number, rel: string): string =>
    `@font-face { font-family:'${family}'; font-weight:${weight}; font-style:normal; ` +
    `font-display:swap; src:url('${dataUri('font/woff2', EMBEDDED_UI[rel]!)}') format('woff2'); }`
  return [
    face('Baloo 2', 700, 'vendor/fonts/baloo-2-latin-700-normal.woff2'),
    face('Baloo 2', 800, 'vendor/fonts/baloo-2-latin-800-normal.woff2'),
    face('Inter', 400, 'vendor/fonts/inter-latin-400-normal.woff2'),
    face('Inter', 600, 'vendor/fonts/inter-latin-600-normal.woff2'),
  ].join('\n')
}

/** Nombre de archivo del reporte: evermore-report-<app>-<fecha>.html */
export function reportFilename(session: ReportSession, now: Date): string {
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\..*$/, '')
  return `evermore-report-${session.bundleId}-${stamp}.html`
}

export function generateReportHtml(
  session: ReportSession,
  theme: 'light' | 'dark',
  generatedAt: Date,
): string {
  const html = read(templateHtmlPath as unknown as string).toString('utf8')
  const js = read(templateJsPath).toString('utf8')
  const echarts = read(EMBEDDED_UI['vendor/echarts.min.js']!).toString('utf8')

  // split/join en lugar de replace: los datos pueden contener `$&` y otros
  // patrones especiales de String.replace
  const fill = (src: string, token: string, value: string): string => src.split(token).join(value)

  let out = html
  out = fill(out, '__TITLE__', `${session.bundleId} · ${session.startedAt.slice(0, 10)}`)
  out = fill(out, '__THEME__', theme)
  out = fill(out, '__FONTS_CSS__', fontsCss())
  out = fill(
    out,
    '__LOGO_EVERMORE__',
    dataUri('image/png', EMBEDDED_UI['assets/evermore-logo.png']!),
  )
  out = fill(
    out,
    '__LOGO_ODACLICK__',
    dataUri('image/png', EMBEDDED_UI['assets/odaclick-dog.png']!),
  )
  out = fill(
    out,
    '__GENERATED__',
    generatedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  )
  out = fill(out, '__ECHARTS__', echarts)
  // </script> dentro del JSON cortaría el <script> del template
  out = fill(out, '__REPORT_DATA__', JSON.stringify({ session }).replace(/<\//g, '<\\/'))
  out = fill(out, '__TEMPLATE_JS__', js)
  return out
}
