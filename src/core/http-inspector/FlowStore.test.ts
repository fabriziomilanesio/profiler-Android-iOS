import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowStore, truncateBody } from './FlowStore'
import type { HttpFlow } from './types'

const dirs: string[] = []
function freshBaseDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'evermore-flow-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function flow(overrides: Partial<HttpFlow> = {}): HttpFlow {
  return {
    id: 'flow-1',
    sessionId: 'sess-1',
    startedAt: '2026-07-17T10:00:00.000Z',
    request: {
      method: 'GET',
      url: 'https://api.evermore.example/ping',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'accept', value: 'application/json' }],
      queryString: [],
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'content-type', value: 'application/json' }],
      content: { size: 12, mimeType: 'application/json', text: '{"ok":true}', truncated: false },
      bodySize: 12,
    },
    timings: { send: 1, wait: 40, receive: 3 },
    timeMs: 44,
    ...overrides,
  }
}

describe('FlowStore.append / read', () => {
  test('append escribe una línea JSON por flow en sessions/<id>/network.jsonl', async () => {
    const baseDir = freshBaseDir()
    const store = new FlowStore(baseDir)
    await store.append('sess-1', flow({ id: 'a' }))
    await store.append('sess-1', flow({ id: 'b' }))

    const path = join(baseDir, 'sessions', 'sess-1', 'network.jsonl')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).id).toBe('a')
    expect(JSON.parse(lines[1]!).id).toBe('b')
  })

  test('roundtrip: lo appendeado se relee igual', async () => {
    const store = new FlowStore(freshBaseDir())
    const f = flow({ id: 'rt' })
    await store.append('sess-1', f)
    const read = await store.read('sess-1')
    expect(read).toEqual([f])
  })

  test('read de una sesión sin flows devuelve []', async () => {
    const read = await new FlowStore(freshBaseDir()).read('nope')
    expect(read).toEqual([])
  })
})

describe('truncateBody', () => {
  test('texto por debajo del límite queda intacto', () => {
    const body = truncateBody('hola', 'text/plain', 1)
    expect(body).toEqual({
      mimeType: 'text/plain',
      text: 'hola',
      truncated: false,
      size: 4,
    })
  })

  test('texto por encima del límite se trunca con size real preservado', () => {
    const big = 'x'.repeat(3000)
    const body = truncateBody(big, 'text/plain', 1) // 1 KB = 1024 bytes
    expect(body.truncated).toBe(true)
    expect(body.size).toBe(3000)
    expect(body.text.length).toBe(1024)
    expect(body.encoding).toBeUndefined()
  })

  test('binario se codifica base64 con encoding=base64', () => {
    const bin = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x03])
    const body = truncateBody(bin, 'application/octet-stream', 32)
    expect(body.encoding).toBe('base64')
    expect(body.truncated).toBe(false)
    expect(body.size).toBe(5)
    expect(Buffer.from(body.text, 'base64').equals(bin)).toBe(true)
  })

  test('binario grande se trunca en base64 con size real', () => {
    const bin = Buffer.alloc(4096, 0xab)
    const body = truncateBody(bin, 'application/octet-stream', 1)
    expect(body.encoding).toBe('base64')
    expect(body.truncated).toBe(true)
    expect(body.size).toBe(4096)
    // truncamos a 1024 bytes ANTES de base64
    expect(Buffer.from(body.text, 'base64').length).toBe(1024)
  })
})

describe('FlowStore.exportHar', () => {
  test('devuelve un HarLog 1.2 válido con creator y entries alineados', async () => {
    const store = new FlowStore(freshBaseDir())
    await store.append('sess-1', flow({ id: 'a', timeMs: 44 }))
    await store.append('sess-1', flow({ id: 'b', timeMs: 100 }))

    const har = await store.exportHar('sess-1')

    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBeTruthy()
    expect(har.log.creator.version).toBeTruthy()
    expect(har.log.entries).toHaveLength(2)

    const entry = har.log.entries[0]!
    expect(entry.startedDateTime).toBe('2026-07-17T10:00:00.000Z')
    expect(entry.time).toBe(44)
    expect(entry.request.method).toBe('GET')
    expect(entry.request.url).toBe('https://api.evermore.example/ping')
    expect(entry.response.status).toBe(200)
    expect(entry.response.content.size).toBe(12)
    // campos requeridos por HAR que agregamos con defaults
    expect(entry.cache).toEqual({})
    expect(entry.request.cookies).toEqual([])
    expect(entry.response.cookies).toEqual([])
    expect(entry.timings.wait).toBe(40)
    expect(entry.timings.blocked).toBe(0)
  })

  test('mapea postData y content con encoding base64 cuando corresponde', async () => {
    const store = new FlowStore(freshBaseDir())
    await store.append(
      'sess-1',
      flow({
        request: {
          method: 'POST',
          url: 'https://api.evermore.example/upload',
          httpVersion: 'HTTP/1.1',
          headers: [],
          queryString: [],
          bodySize: 3,
          postData: { mimeType: 'application/json', text: '{}', truncated: false },
        },
        response: {
          status: 201,
          statusText: 'Created',
          httpVersion: 'HTTP/1.1',
          headers: [],
          content: {
            size: 5,
            mimeType: 'application/octet-stream',
            text: 'AAECAwQ=',
            encoding: 'base64',
            truncated: false,
          },
          bodySize: 5,
        },
      }),
    )

    const har = await store.exportHar('sess-1')
    const entry = har.log.entries[0]!
    expect(entry.request.postData).toEqual({ mimeType: 'application/json', text: '{}' })
    expect(entry.response.content.encoding).toBe('base64')
    expect(entry.response.content.text).toBe('AAECAwQ=')
  })

  test('exportHar de una sesión vacía → log con entries []', async () => {
    const har = await new FlowStore(freshBaseDir()).exportHar('empty')
    expect(har.log.version).toBe('1.2')
    expect(har.log.entries).toEqual([])
  })
})
