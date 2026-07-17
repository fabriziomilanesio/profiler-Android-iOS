import { describe, expect, test } from 'bun:test'
import { resolveStaticFile } from './staticFiles'

const ROOT = '/app/ui'

describe('resolveStaticFile', () => {
  test('/ → index.html', () => {
    expect(resolveStaticFile(ROOT, '/')).toEqual({
      path: '/app/ui/index.html',
      contentType: 'text/html; charset=utf-8',
    })
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
