import { describe, expect, test } from 'bun:test'
import { resolveStaticFile } from './staticFiles'
import { staticHeaders } from './liveServer'

const ROOT = '/app/ui'

describe('resolveStaticFile', () => {
  test('/ → index.html', () => {
    expect(resolveStaticFile(ROOT, '/')).toEqual({
      path: '/app/ui/index.html',
      rel: 'index.html',
      contentType: 'text/html; charset=utf-8',
    })
  })

  test('rel usa / (clave del manifest embebido) también en subdirectorios', () => {
    expect(resolveStaticFile(ROOT, '/vendor/fonts/x.woff2')?.rel).toBe('vendor/fonts/x.woff2')
  })

  test('mapea content-type por extensión', () => {
    expect(resolveStaticFile(ROOT, '/app.js')?.contentType).toBe('text/javascript; charset=utf-8')
    expect(resolveStaticFile(ROOT, '/assets/logo.png')?.contentType).toBe('image/png')
    expect(resolveStaticFile(ROOT, '/vendor/fonts/x.woff2')?.contentType).toBe('font/woff2')
  })

  test('bloquea path traversal fuera del uiRoot', () => {
    expect(resolveStaticFile(ROOT, '/../../etc/passwd')).toBeNull()
  })

  test('bloquea escape a directorio hermano con prefijo común (ui vs ui-x)', () => {
    expect(resolveStaticFile(ROOT, '/../ui-secret/keys.json')).toBeNull()
  })

  test('%-encoding malformado ⇒ null (404), no URIError', () => {
    expect(resolveStaticFile(ROOT, '/%')).toBeNull()
  })

  test('extensión desconocida ⇒ octet-stream', () => {
    expect(resolveStaticFile(ROOT, '/file.xyz')?.contentType).toBe('application/octet-stream')
  })
})

describe('staticHeaders', () => {
  // Regresión: sin cache-control el browser se queda con el JS viejo. Se descubrió al
  // agregar los devices iOS — /api/devices ya los devolvía y la UI mostraba la copia
  // anterior, que ni sabía que existían.
  test('sirve el dashboard sin cache', () => {
    const h = staticHeaders('text/javascript; charset=utf-8')
    expect(h['cache-control']).toContain('no-store')
  })

  test('conserva el content-type que resolvió el router', () => {
    expect(staticHeaders('text/css')['content-type']).toBe('text/css')
  })
})
