// Inspector HTTP: proxy PASS-THROUGH que loguea el tráfico de la app sin desencriptar
// (primer corte del ticket 018). Tuneliza HTTPS (CONNECT → túnel TCP crudo, la app sigue
// andando) y ve los requests HTTP en claro (método + URL). Los payloads HTTPS requieren
// MITM con CA instalada (siguiente iteración). Emite un InspectorFlow por cada request.
//
// node:http/node:net (soportados por Bun y Node → agnóstico de runtime). El proxy corre
// en la máquina de la tool; el device llega vía `adb reverse` (lo cablea LiveServer).
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'

// Headers hop-by-hop: no se reenvían al origin (RFC 7230 §6.1).
const HOP_BY_HOP = [
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
]

export interface InspectorFlow {
  id: number
  ts: number
  kind: 'https' | 'http'
  method: string
  host: string
  url: string
  status: number | null
  bytes: number
}

export class InspectorProxy {
  private server: Server | null = null
  private seq = 0

  constructor(
    private readonly port: number,
    private readonly onFlow: (f: InspectorFlow) => void,
  ) {}

  start(): Promise<void> {
    const proxy = createServer((req, res) => this.handleHttp(req, res))
    proxy.on('connect', (req, socket, head) => this.handleConnect(req, socket, head))
    this.server = proxy
    return new Promise((resolve) => proxy.listen(this.port, '127.0.0.1', () => resolve()))
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    let url: URL
    try {
      url = new URL(req.url || '')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const flow: InspectorFlow = {
      id: ++this.seq,
      ts: Date.now(),
      kind: 'http',
      method: req.method || 'GET',
      host: url.host,
      url: req.url || '',
      status: null,
      bytes: 0,
    }
    const headers = { ...req.headers }
    for (const h of HOP_BY_HOP) delete headers[h]
    const upstream = httpRequest(
      {
        host: url.hostname,
        port: url.port || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers,
      },
      (up) => {
        flow.status = up.statusCode ?? null
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.on('data', (c: Buffer) => (flow.bytes += c.length))
        up.on('end', () => this.onFlow(flow))
        up.pipe(res)
      },
    )
    upstream.on('error', () => {
      flow.status = -1
      this.onFlow(flow)
      try {
        res.writeHead(502)
        res.end()
      } catch {
        /* ya cerrado */
      }
    })
    // Un 'error' sin listener en req/res (cliente que aborta) tira excepción no
    // capturada y voltea el proceso entero; además el upstream quedaría colgado.
    req.on('error', () => upstream.destroy())
    res.on('error', () => upstream.destroy())
    req.pipe(upstream)
  }

  private handleConnect(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    // lastIndexOf: el target puede ser IPv6 con corchetes ([::1]:443) — split(':') lo rompe.
    const target = req.url || ''
    const sep = target.lastIndexOf(':')
    const rawHost = sep > 0 ? target.slice(0, sep) : target
    const host = rawHost.replace(/^\[|\]$/g, '') // netConnect quiere ::1 sin corchetes
    const port = sep > 0 ? Number(target.slice(sep + 1)) || 443 : 443
    const flow: InspectorFlow = {
      id: ++this.seq,
      ts: Date.now(),
      kind: 'https',
      method: 'CONNECT',
      host: rawHost || '?',
      url: `${rawHost}:${port}`,
      status: null,
      bytes: 0,
    }
    const upstream = netConnect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      flow.status = 200
      this.onFlow(flow)
      upstream.on('data', (c: Buffer) => (flow.bytes += c.length))
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    const kill = (): void => {
      try {
        clientSocket.destroy()
      } catch {
        /* noop */
      }
      try {
        upstream.destroy()
      } catch {
        /* noop */
      }
    }
    upstream.on('error', () => {
      flow.status = -1
      this.onFlow(flow)
      kill()
    })
    clientSocket.on('error', kill)
  }
}
