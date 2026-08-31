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

/** Nombre de archivo del reporte: sample-report-<app>-<fecha>.html */
export function reportFilename(session: ReportSession, now: Date): string {
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\..*$/, '')
  return `sample-report-${session.bundleId}-${stamp}.html`
}

export function dualReportFilename(now: Date): string {
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\..*$/, '')
  return `sample-dual-report-${stamp}.html`
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
    '__GENERATED__',
    generatedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  )
  out = fill(out, '__ECHARTS__', echarts)
  // </script> dentro del JSON cortaría el <script> del template
  out = fill(out, '__REPORT_DATA__', JSON.stringify({ session }).replace(/<\//g, '<\\/'))
  out = fill(out, '__TEMPLATE_JS__', js)
  return out
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Dos reportes standalone completos, apilados A → B sin colisiones de ids o scripts. */
export function generateDualReportHtml(
  primary: ReportSession,
  secondary: ReportSession,
  themes: { primary: 'light' | 'dark'; secondary: 'light' | 'dark' },
  generatedAt: Date,
): string {
  const a = generateReportHtml(primary, themes.primary, generatedAt)
  const b = generateReportHtml(secondary, themes.secondary, generatedAt)
  const generated = generatedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Dual report · ${escapeText(primary.bundleId)} ↔ ${escapeText(secondary.bundleId)}</title>
  <style>
    ${fontsCss()}
    *{box-sizing:border-box}body{margin:0;background:#0b0b10;color:#f2f2f6;font-family:'Inter',system-ui,sans-serif}
    header{padding:18px 24px;border-bottom:1px solid #2a2a38;background:#15151d}h1{margin:0;font:800 26px 'Baloo 2',sans-serif}header p{margin:2px 0 0;color:#9b9bab;font-size:12px}
    .lane{border-bottom:1px solid #2a2a38}.lane-title{position:sticky;top:0;z-index:2;padding:8px 24px;background:#1b1b25;color:#9b9bab;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
    iframe{display:block;width:100%;height:1200px;border:0;background:white}.note{padding:12px 24px;color:#9b9bab;font-size:11px;text-align:center}
  </style>
</head>
<body>
  <header><h1>Dual performance report</h1><p>${escapeText(primary.bundleId)} · ${escapeText(primary.device?.name ?? 'Device A')} &nbsp;↔&nbsp; ${escapeText(secondary.bundleId)} · ${escapeText(secondary.device?.name ?? 'Device B')} · generated ${generated}</p></header>
  <section class="lane"><div class="lane-title">Device A · ${escapeText(primary.device?.name ?? primary.bundleId)}</div><iframe title="Device A report" srcdoc="${escapeAttr(a)}"></iframe></section>
  <section class="lane"><div class="lane-title">Device B · ${escapeText(secondary.device?.name ?? secondary.bundleId)}</div><iframe title="Device B report" srcdoc="${escapeAttr(b)}"></iframe></section>
  <div class="note">This file contains two independent device reports. Automated comparison will be added in Export Comparison Report.</div>
  <script>document.querySelectorAll('iframe').forEach(function(frame){frame.addEventListener('load',function(){try{frame.style.height=Math.max(1200,frame.contentDocument.documentElement.scrollHeight+24)+'px'}catch(e){}})})<\/script>
</body>
</html>`
}
