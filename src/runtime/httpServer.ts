// Thin adapter sobre la API de servidor de Bun (Bun.serve + WebSocket), para que
// el código del server quede agnóstico del runtime (misma costura que spawn.ts:
// nadie fuera de src/runtime toca Bun/`node:*` directo).
//
// Expone una interfaz mínima: rutas HTTP + broadcast a los WS conectados.

/** Un cliente WS abstracto (lo que el server necesita). */
export interface WsClient {
  send(data: string): void
}

export interface HttpServerHandlers {
  /** Responde una request HTTP. Devolvé null para dejar que el server intente upgrade a WS. */
  fetch(req: Request): Response | Promise<Response> | null
  /** Nuevo cliente WS conectado. */
  onOpen?(client: WsClient): void
  /** Cliente WS desconectado. */
  onClose?(client: WsClient): void
}

export interface RunningHttpServer {
  readonly port: number
  broadcast(data: string): void
  stop(): void
}

// Bun global (declarado laxo para no depender de @types/bun en el resto del código).
declare const Bun: {
  serve(options: unknown): {
    port: number
    stop(): void
    publish(topic: string, data: string): void
  }
}

const WS_TOPIC = 'samples'

/** ¿El Origin es una página servida por nosotros mismos (localhost)? */
function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** Levanta el server HTTP+WS con Bun. Aislado acá; el resto del código no ve Bun. */
export function startHttpServer(port: number, handlers: HttpServerHandlers): RunningHttpServer {
  const clients = new Set<WsClient>()

  const server = Bun.serve({
    port,
    // Tool local: solo loopback. Sin esto Bun bindea 0.0.0.0 y cualquiera en la LAN
    // vería métricas, serial del device y tráfico interceptado.
    hostname: '127.0.0.1',
    async fetch(req: Request, srv: { upgrade(req: Request): boolean }) {
      // Intento de upgrade a WebSocket primero (path /ws).
      const url = new URL(req.url)
      if (url.pathname === '/ws') {
        // Los WS no están sujetos a same-origin: sin este check, cualquier página
        // abierta en el browser podría leer el stream. Origin ausente (clientes
        // no-browser: scripts, curl) se permite.
        const origin = req.headers.get('origin')
        if (origin !== null && !isLocalOrigin(origin)) {
          return new Response('Forbidden origin', { status: 403 })
        }
        if (srv.upgrade(req)) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }
      const res = await handlers.fetch(req)
      return res ?? new Response('Not found', { status: 404 })
    },
    websocket: {
      open(ws: { subscribe(topic: string): void; send(data: string): void }) {
        ws.subscribe(WS_TOPIC)
        const client: WsClient = { send: (d) => ws.send(d) }
        ;(ws as unknown as { _client: WsClient })._client = client
        clients.add(client)
        handlers.onOpen?.(client)
      },
      close(ws: unknown) {
        const client = (ws as { _client?: WsClient })._client
        if (client) {
          clients.delete(client)
          handlers.onClose?.(client)
        }
      },
      message() {
        /* el dashboard es read-only: ignoramos mensajes entrantes */
      },
    },
  })

  return {
    port: server.port,
    broadcast(data: string) {
      // publish llega a todos los suscriptores del topic (más eficiente que iterar).
      server.publish(WS_TOPIC, data)
    },
    stop() {
      server.stop()
    },
  }
}
