---
id: 19
title: Inspector HTTP — módulos core device-independent + spike Bun TLS
label: wayfinder:task
status: closed
assignee: agent-http-core
blocked-by: [17]
---

## Question

Implementar la parte del inspector HTTP que NO necesita device ni el build QA, siguiendo el
diseño de docs/research/http-inspector-mechanism.md, y resolver empíricamente el riesgo R1
(bug de Bun `#17932`: `SNICallback`/`ALPNCallback` no disparan en TLS server) para desriesgar
018:

1. **Spike R1 (primero, define notas del diseño):** un TLS server mínimo con `SNICallback`
   bajo la versión pinneada de Bun — ¿dispara o no? Documentar el veredicto. Si no dispara,
   confirmar el fallback (certs eager por-host, o subsistema bajo Node).
2. **`CertAuthority`** (node-forge): `ensureRootCA()` genera 1 vez y persiste en
   `~/.evermore-profiler/ca/` (key 0600 + cert), `certForHost()` emite leaf con SAN cacheado,
   `rootCertPath()`. Pura cripto/FS, testeable sin device.
3. **`DeviceProxyController`** (vía `AdbTransport`): `capturePrevious()` (settings get +
   persist a `proxy-restore.json`), `set()`, `restore()` idempotente. Restauración exacta del
   estado previo + recuperación de crash huérfano. Testeado con un stub de `AdbTransport`.
4. **`FlowStore` + tipos** `HttpFlow`/HAR: append a `network.jsonl`, `exportHar()` → HAR 1.2.
   Body truncado a `maxBodyKB`, binario base64. Lógica pura, testeada.

Costuras: todo bajo `src/core/http-inspector/`, adb sólo por `AdbTransport`, core agnóstico
de runtime. `bun test` + `typecheck` verdes. NO el proxy real ni el panel (eso es 018, que
sigue bloqueado por el device en 016).

Nota dev-workflow: context7 está pending approval; se instalan las libs y se verifican los
tipos contra el paquete instalado + las fuentes primarias del research.

## Resolution (2026-07-17)

### (a) VEREDICTO del spike R1 — Bun 1.3.11

**`SNICallback` NO DISPARA. `ALPNCallback` NO DISPARA.** El bug `oven-sh/bun#17932`
**sigue presente** en Bun 1.3.11 (la versión pinneada del proyecto).

Metodología: `node:tls` server con `SNICallback` + `ALPNCallback`, dos conexiones cliente
con servernames distintos (`alpha.local`, `beta.local`) a `127.0.0.1`. Spike descartable en
`/tmp/bun-tls-sni-spike.ts` (no versionado; usa `node-forge` para la CA/leaf on-the-fly).

Resultado textual:

```
=== Spike R1 — Bun 1.3.11 ===
TLS handshakes OK: 2 errors: 0
SNICallback hits: 0 []
ALPNCallback hits: 0 []
VERDICT SNICallback: NO DISPARA
VERDICT ALPNCallback: NO DISPARA
```

Clave: **los dos handshakes TLS COMPLETAN (2/2, 0 errores)** — el server sirve el cert por
default — pero **los callbacks nunca corren** (0 hits). No es que el TLS falle: es que Bun
ignora `SNICallback`/`ALPNCallback` al crear el server y resuelve el handshake con el
`key`/`cert` estático de las opciones.

**Consecuencia de diseño (confirma la mitigación #2 del research §1.4):** bajo Bun **no se
puede** emitir el leaf cert por-host _dentro_ del callback TLS (que es el patrón clásico de un
MITM). ⇒ **`CertAuthority` debe soportar emisión EAGER**: `certForHost(host)` emite y **cachea**
el leaf **antes** del handshake, y el proxy (018) tiene que cargar el `SecureContext` correcto
por otra vía (p.ej. un TLS server por-host, o `secureContext` por conexión resuelto con el host
del `CONNECT`, sin depender de que el callback dispare). `CertAuthority` ya quedó implementado
con esa semántica eager+cacheada. Fallbacks alternativos documentados en el research §1.4
(pre-generar certs de hosts conocidos; o correr el subsistema proxy bajo Node) siguen vigentes
como plan B si el enfoque per-host-server no alcanza en 018.

### (b) Módulos entregados (en `src/core/http-inspector/`) + cobertura de tests

Todos device-independent, adb sólo por la costura `AdbTransport`, sin spawnear adb, baseDir
inyectable (tests corren en `tmpdir`, nada toca `~/.evermore-profiler`). `bun test`: **81 pass /
0 fail** (28 nuevos en estos 3 módulos). `bun run typecheck` (tsc estricto): **verde**.

- **`types.ts`** — `HttpFlow` (+ sub-tipos request/response/timings/body) y HAR 1.2
  (`HarLog`/`HarEntry`/`HarRequest`/`HarResponse`/`HarContent`/`HarTimings`/`Header`, etc.).
  Tipos puros, sin runtime.
- **`CertAuthority.ts`** (node-forge 1.4.0) — `ensureRootCA()` genera RSA-2048 + CA self-signed
  (`basicConstraints cA:true`) una vez y persiste en `<baseDir>/ca/` (`ca.key.pem` modo 0600,
  `ca.cert.pem`), relee si existe; `certForHost(host)` **emite eager** leaf con SAN=host firmado
  por la CA, cacheado en memoria + `ca/certs/<host>.pem`; `rootCertPath()`. Tests: CA idempotente
  (misma CA en re-instancia), leaf con SAN correcto y verificable con `caCert.verify(leaf)`, leaf
  no-CA, cache por-host persistente, key 0600.
- **`DeviceProxyController.ts`** (vía `AdbTransport`) — `capturePrevious(serial)` corre
  `settings get global http_proxy`, parsea (`null`/`:0`/`host:port`) y persiste a
  `<baseDir>/proxy-restore.json`; `set(serial,host,port)` → `settings put global http_proxy
host:port`; `restore(serial)` restaura EXACTO el previo (`settings delete` si era none, o el
  `host:port` real del usuario), idempotente, y borra el restore file; `recoverOrphan()` rescata
  un restore file de una corrida que crasheó. `parseProxy()` exportado y testeado aparte. Tests
  con `FakeAdbTransport` in-line (registra los comandos exactos): comandos emitidos verbatim,
  restauración exacta (incl. proxy previo real del usuario), idempotencia, recuperación huérfana,
  no-op sin captura previa.
- **`FlowStore.ts`** — `append(sessionId, flow)` agrega una línea JSON a
  `<baseDir>/sessions/<sessionId>/network.jsonl`; `read()` roundtrip; `exportHar(sessionId)`
  → HAR 1.2 válido (mapea cada `HttpFlow` a un `HarEntry`, defaults de campos requeridos, timings
  con 0 por defecto, postData/content con base64 preservado). `truncateBody()` exportado: trunca
  a `maxBodyKB` (por bytes UTF-8 en texto), base64 en binario con `encoding:'base64'`, flag
  `truncated` + `size` real. Tests: append+read roundtrip, truncado texto/binario, export HAR con
  estructura válida (`log.version "1.2"`, creator, entries alineados).

### (c) Explícitamente para 018 (NO se hizo acá)

- **Proxy MITM real** (`HttpMitmProxyTransport implements ProxyTransport`, `http-mitm-proxy` +
  la carga del `SecureContext`/TLS-server por-host que el veredicto R1 obliga a resolver sin
  depender del callback). `http-mitm-proxy` **no** se instaló (es de 018).
- **`DeviceCaInstaller`** — `adb push` de la CA, `isTrusted()` (probe de intercepción),
  instrucciones manuales del install del user CA en Android 11+ (no automatizable sin root).
- **Panel UI "Network"** y el resumen HTTP en el reporte de comparación.
- **`HttpInspector`** orquestador (ata CA + proxy + `DeviceProxyController` + `FlowStore` al
  ciclo de vida de la sesión, emite al WS del dashboard) y los signal handlers
  SIGINT/SIGTERM/beforeExit que llaman a `restore()`.
- Todo lo que depende del **gate 016** (viabilidad real contra device/build QA: si Unity respeta
  el proxy, pinning, `network_security_config`).
