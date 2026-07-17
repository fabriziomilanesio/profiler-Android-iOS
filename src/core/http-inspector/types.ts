// Modelo de datos del inspector HTTP (ticket 019, §4 del research).
// Tipos puros — sin dependencias de runtime. `HttpFlow` es nuestro modelo de
// captura (una línea por request/response en network.jsonl); los tipos `Har*`
// son HAR 1.2 para exportar la captura y abrirla en Chrome DevTools / Charles.

/** Par nombre/valor de HAR (headers, query string, cookies). */
export interface Header {
  name: string
  value: string
}

/** Un flow HTTP capturado: un request/response. Alineado con HAR 1.2 entry. */
export interface HttpFlow {
  /** uuid */
  id: string
  sessionId: string
  /** ISO8601 (HAR: entry.startedDateTime) */
  startedAt: string
  request: HttpFlowRequest
  response: HttpFlowResponse
  /** HAR-style, ms */
  timings: HttpFlowTimings
  /** total en ms (HAR: entry.time) */
  timeMs: number
  serverIPAddress?: string
  /** si el flow falló (TLS, timeout, etc.) */
  error?: string
}

export interface HttpFlowRequest {
  method: string
  url: string
  /** "HTTP/1.1" */
  httpVersion: string
  headers: Header[]
  queryString: Header[]
  /** bytes reales del body */
  bodySize: number
  postData?: HttpBody
}

export interface HttpFlowResponse {
  status: number
  statusText: string
  httpVersion: string
  headers: Header[]
  content: HttpContent
  /** bytes reales del body */
  bodySize: number
}

/** Body de request (postData). `text` truncado a maxBodyKB. */
export interface HttpBody {
  mimeType: string
  /** truncado a maxBodyKB; base64 si binario */
  text: string
  encoding?: 'base64'
  truncated: boolean
}

/** Body de response (content). `size` es el tamaño real, `text` puede venir truncado. */
export interface HttpContent {
  /** bytes reales del body */
  size: number
  mimeType: string
  /** truncado a maxBodyKB (base64 si binario) */
  text?: string
  encoding?: 'base64'
  truncated: boolean
}

export interface HttpFlowTimings {
  blocked?: number
  dns?: number
  connect?: number
  ssl?: number
  send: number
  /** TTFB */
  wait: number
  receive: number
}

// ---- HAR 1.2 (subset que emitimos) — http://www.softwareishard.com/blog/har-12-spec/ ----

export interface HarLog {
  version: '1.2'
  creator: HarCreator
  entries: HarEntry[]
}

export interface HarCreator {
  name: string
  version: string
}

export interface HarEntry {
  startedDateTime: string
  /** total ms */
  time: number
  request: HarRequest
  response: HarResponse
  cache: Record<string, never>
  timings: HarTimings
  serverIPAddress?: string
}

export interface HarRequest {
  method: string
  url: string
  httpVersion: string
  headers: Header[]
  queryString: Header[]
  cookies: Header[]
  headersSize: number
  bodySize: number
  postData?: HarPostData
}

export interface HarPostData {
  mimeType: string
  text: string
}

export interface HarResponse {
  status: number
  statusText: string
  httpVersion: string
  headers: Header[]
  cookies: Header[]
  content: HarContent
  redirectURL: string
  headersSize: number
  bodySize: number
}

export interface HarContent {
  size: number
  mimeType: string
  text?: string
  encoding?: 'base64'
}

export interface HarTimings {
  blocked: number
  dns: number
  connect: number
  ssl: number
  send: number
  wait: number
  receive: number
}
