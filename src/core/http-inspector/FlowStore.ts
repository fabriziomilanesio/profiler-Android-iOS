// FlowStore (ticket 019): persistencia de flows HTTP en network.jsonl (una
// línea JSON por flow, aparte de las muestras de recursos del sampler) y export
// a HAR 1.2 para abrir la captura en Chrome DevTools / Charles. Lógica pura +
// FS; device-independent. baseDir inyectable.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  HarContent,
  HarEntry,
  HarLog,
  HarRequest,
  HarResponse,
  Header,
  HttpFlow,
} from './types'

/** HAR raíz (`{ log: {...} }`), lo que devuelve exportHar. */
export interface Har {
  log: HarLog
}

const CREATOR = { name: 'evermore-android-profiler', version: '0.1.0' } as const

/** Resultado del truncado de un body: mimeType + texto (posiblemente base64) + size real. */
export interface TruncatedBody {
  mimeType: string
  /** truncado a maxBodyKB; base64 si binario */
  text: string
  encoding?: 'base64'
  truncated: boolean
  /** bytes reales del body original */
  size: number
}

export class FlowStore {
  constructor(private readonly baseDir: string) {}

  /** Agrega una línea JSON con el flow a sessions/<sessionId>/network.jsonl. */
  async append(sessionId: string, flow: HttpFlow): Promise<void> {
    const path = this.pathFor(sessionId)
    mkdirSync(join(this.baseDir, 'sessions', sessionId), { recursive: true })
    const line = JSON.stringify(flow) + '\n'
    appendFileSync(path, line)
  }

  /** Relee todos los flows de una sesión. [] si no hay captura. */
  async read(sessionId: string): Promise<HttpFlow[]> {
    const path = this.pathFor(sessionId)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as HttpFlow)
  }

  /** Exporta la captura de la sesión como HAR 1.2. */
  async exportHar(sessionId: string): Promise<Har> {
    const flows = await this.read(sessionId)
    return {
      log: {
        version: '1.2',
        creator: { name: CREATOR.name, version: CREATOR.version },
        entries: flows.map(flowToHarEntry),
      },
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.baseDir, 'sessions', sessionId, 'network.jsonl')
  }
}

/**
 * Trunca un body a maxBodyKB. Texto (string) queda como texto; binario (Buffer)
 * se codifica base64 (`encoding: 'base64'`). En ambos casos preserva el `size`
 * real y marca `truncated` si se recortó.
 */
export function truncateBody(
  body: string | Buffer,
  mimeType: string,
  maxBodyKB: number,
): TruncatedBody {
  const maxBytes = maxBodyKB * 1024

  if (typeof body === 'string') {
    const size = Buffer.byteLength(body, 'utf8')
    if (size <= maxBytes) {
      return { mimeType, text: body, truncated: false, size }
    }
    // Truncamos por bytes UTF-8, no por chars, para respetar maxBodyKB.
    const text = Buffer.from(body, 'utf8').subarray(0, maxBytes).toString('utf8')
    return { mimeType, text, truncated: true, size }
  }

  const size = body.length
  const slice = size <= maxBytes ? body : body.subarray(0, maxBytes)
  return {
    mimeType,
    text: slice.toString('base64'),
    encoding: 'base64',
    truncated: size > maxBytes,
    size,
  }
}

function flowToHarEntry(flow: HttpFlow): HarEntry {
  return {
    startedDateTime: flow.startedAt,
    time: flow.timeMs,
    request: toHarRequest(flow),
    response: toHarResponse(flow),
    cache: {},
    timings: {
      blocked: flow.timings.blocked ?? 0,
      dns: flow.timings.dns ?? 0,
      connect: flow.timings.connect ?? 0,
      ssl: flow.timings.ssl ?? 0,
      send: flow.timings.send,
      wait: flow.timings.wait,
      receive: flow.timings.receive,
    },
    ...(flow.serverIPAddress ? { serverIPAddress: flow.serverIPAddress } : {}),
  }
}

function toHarRequest(flow: HttpFlow): HarRequest {
  const req = flow.request
  return {
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    headers: req.headers,
    queryString: req.queryString,
    cookies: [],
    headersSize: -1,
    bodySize: req.bodySize,
    ...(req.postData
      ? { postData: { mimeType: req.postData.mimeType, text: req.postData.text } }
      : {}),
  }
}

function toHarResponse(flow: HttpFlow): HarResponse {
  const res = flow.response
  const content: HarContent = {
    size: res.content.size,
    mimeType: res.content.mimeType,
    ...(res.content.text !== undefined ? { text: res.content.text } : {}),
    ...(res.content.encoding ? { encoding: res.content.encoding } : {}),
  }
  return {
    status: res.status,
    statusText: res.statusText,
    httpVersion: res.httpVersion,
    headers: res.headers,
    cookies: [] as Header[],
    content,
    redirectURL: locationHeader(res.headers),
    headersSize: -1,
    bodySize: res.bodySize,
  }
}

function locationHeader(headers: Header[]): string {
  return headers.find((h) => h.name.toLowerCase() === 'location')?.value ?? ''
}
