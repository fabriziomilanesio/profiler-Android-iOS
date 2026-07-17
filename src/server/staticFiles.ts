// Resolución de archivos estáticos del UI (ticket 021). Puro y testeable: dado un
// pathname de request, devuelve la ruta de archivo dentro del uiRoot y su content-type,
// con guard de path traversal. La lectura real del disco la hace el server (runtime).
import { extname, join, normalize, sep } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
}

export interface ResolvedFile {
  path: string
  contentType: string
}

/** Mapea un pathname a un archivo dentro de uiRoot. null ⇒ 404 (o traversal bloqueado). */
export function resolveStaticFile(uiRoot: string, pathname: string): ResolvedFile | null {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null // %-encoding malformado ⇒ 404, no URIError hasta el handler
  }
  if (rel === '/' || rel === '') rel = '/index.html'
  // normalizar y bloquear traversal fuera de uiRoot. La comparación lleva separador:
  // con startsWith a secas, un directorio hermano con prefijo común (ui-x) pasaría.
  const root = normalize(uiRoot)
  const path = normalize(join(root, rel))
  if (path !== root && !path.startsWith(root + sep)) return null
  const ext = extname(path).toLowerCase()
  return { path, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' }
}
