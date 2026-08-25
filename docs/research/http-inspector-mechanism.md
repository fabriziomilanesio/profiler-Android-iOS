# HTTP Inspector — Mecanismo de intercepción (research, ticket 017)

> Research para el **inspector HTTP secundario** del Mobile Profiler.
> Pregunta madre: ¿cómo intercepta la tool el tráfico HTTP(S) de `com.sample.oda.qa`
> **sin romper** "un ejecutable self-contained por OS" (`bun build --compile`) ni "código
> agnóstico de runtime, migrable a Node", y respetando la costura `AdbTransport`?
>
> Feature **secundaria**: es un panel aparte, no compite con las métricas de recursos (core).
> Es app propia: controlamos el build QA y el device.

## Nota sobre verificación de fuentes (dev-workflow)

La hard rule `use-context7-first` pide resolver libs vía Context7 MCP. En esta sesión el server
`context7` figura en `.mcp.json` pero está **`⏸ Pending approval`** (`claude mcp list`), así que
sus tools no estuvieron disponibles para el agente. En lugar de adivinar de memoria, **verifiqué
cada dato de versión/licencia/API contra fuentes primarias**: el registry npm
(`registry.npmjs.org`), los repos GitHub, docs oficiales (Android Developers, bun.com/reference,
mitmproxy, OpenSSL) y issues de los proyectos. Las versiones citadas al final llevan su fuente.
**Acción pendiente para el humano:** aprobar el server context7 (`claude` interactivo) si se quiere
re-confirmar vía Context7 antes de implementar (ticket 018).

---

## TL;DR — DECISIÓN

**Proxy MITM propio en TypeScript**, embebido en el binario, usando la librería
**`http-mitm-proxy` v1.1.0** (MIT) como base o como referencia de arquitectura, con la generación
de CA/certs delegada a **`node-forge` v1.4.0** (BSD-3-Clause). **Cero deps externas del usuario**
(no Python, no mitmproxy). Es la única opción que respeta el ADR del stack.

**PERO** con una salvedad dura de runtime: hay un **bug abierto de Bun** donde `SNICallback` /
`ALPNCallback` **no se disparan** al crear un TLS server (`node:tls`) — y ese callback es
exactamente donde un MITM genera el cert por-host al vuelo. Por eso:

- **Plan A (elegido):** proxy propio TS. Antes de comprometerlo hay un **spike bloqueante**
  (ticket 018) que corre `http-mitm-proxy` **bajo Bun** contra el device y confirma que el
  handshake TLS per-host funciona. Si el `SNICallback`/`ALPNCallback` de Bun falla, el fallback
  inmediato es **correr ese subsistema bajo Node** (el código ya es agnóstico) o **generar los
  certs por-host de forma eager** (sin depender del callback) — ver §1.4.
- **Plan B (degradado):** si 016 dice que el build Unity **no** es interceptable por HTTP-proxy
  (UnityWebRequest ignora el proxy del sistema, o hay pinning), el inspector cae a
  **proxy transparente (redirección a nivel red)** o directamente se marca **no soportado en v1**
  con un mensaje claro. Shell-out a mitmproxy queda **descartado** salvo emergencia (§1.5).

---

## 1. Proxy MITM propio (TS) vs shell-out a mitmproxy

### 1.1 Restricción de proyecto

El ADR del stack (map.md → Notes) es explícito: **TS + Bun, un ejecutable por OS vía
`bun build --compile`, código migrable a Node**. Cualquier mecanismo que exija que el usuario
instale **Python + mitmproxy** viola las dos restricciones a la vez:

- rompe "self-contained por OS" (mitmproxy no entra en el binario Bun),
- introduce una dependencia de runtime ajena que hay que instalar/versionar/documentar por SO.

Dado que el inspector es **feature secundaria**, no puede justificar arrastrar un intérprete de
Python al deploy. La barra para shell-out a mitmproxy es "el proxy propio directamente no es
técnicamente posible", y no es el caso.

### 1.2 Libs npm de MITM proxy evaluadas

| Lib                    | Última versión | Fecha          | Licencia               | Estado                                                                                                             |
| ---------------------- | -------------- | -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **`http-mitm-proxy`**  | **1.1.0**      | 2023-11-26     | MIT                    | Mantenida (fork activo de `joeferner`), TS-friendly. **Elegida.**                                                  |
| `node-http-mitm-proxy` | —              | —              | —                      | **No existe** en npm (404). Es el nombre viejo/redirect; el paquete real publicado es `http-mitm-proxy`.           |
| `node-forge`           | 1.4.0          | (BSD/GPL dual) | BSD-3-Clause (o GPLv2) | No es un proxy: es la **lib de cripto/X.509** que usa `http-mitm-proxy` para emitir certs. La reusamos para la CA. |

`http-mitm-proxy` v1.1.0 (verificado en `registry.npmjs.org`):

- **CONNECT/TLS:** sí. En un `CONNECT`, pausa al cliente, abre conexión al server upstream,
  completa el handshake, lee el CN del cert real del server y **genera un cert dummy por-host**
  firmado por la CA local (vía node-forge). Certs cacheados en `sslCaDir`.
- **WebSocket:** sí, de primera clase — hooks `onWebSocketConnection/Send/Message/Frame/Error/Close`
  (usa `ws` 8.14.x internamente).
- **HTTP/2:** **NO** documentado / no soportado. Es el gap grande (§1.3).
- **Deps (todas embebibles, sin binario nativo):** `node-forge`, `ws`, `async`, `debug`, `mkdirp`,
  `yargs`, `uuid`, `semaphore`. Requiere Node ≥16 (Bun cubre esa superficie salvo el gap de §1.4).
- **Genera la CA raíz** automáticamente (`sslCaDir + '/certs/ca.pem'`), que es justo lo que
  queremos importar al device.

No hay otra lib npm de MITM proxy más mantenida y con mejor cobertura de CONNECT+WS a la vista;
las alternativas o son wrappers de mitmproxy (Python) o están sin mantener.

### 1.3 El gap HTTP/2

`http-mitm-proxy` habla HTTP/1.1 al cliente. Impacto para nosotros:

- Cuando la tool setea el proxy del sistema y el cert propio, el cliente (la app) abre `CONNECT`
  y negocia TLS **con nuestro proxy**. Vía ALPN podemos **no ofrecer `h2`** y forzar `http/1.1`
  en la pata cliente↔proxy; muchos backends siguen sirviendo por 1.1. Esto degrada perf pero
  hace visible el tráfico, que es el objetivo del inspector.
- Riesgo: si el backend **exige** h2 y el server no acepta downgrade, ese flow no se ve. Se
  documenta como limitación conocida de v1 (riesgo abierto R3).
- No vamos a reimplementar h2 MITM en v1 (es exactamente el "reimplementar CONNECT/TLS/HTTP2 es
  laburo" del ticket). h2 queda diferido.

### 1.4 Correr en Bun: el riesgo real

Bun implementa `node:http`, `node:tls`, `node:net`, `node:http2` server (desde ~1.1.31). Pero hay
un bug **directamente sobre nuestra ruta crítica**:

- **`oven-sh/bun#17932`** — `SNICallback` y `ALPNCallback` **no se disparan** al crear un TLS
  server con `node:tls` en Bun (reportado en Bun 1.2.4, mar-2025), mientras que en Node funcionan.
  Un MITM proxy genera el cert por-host **dentro** de `SNICallback` (mira el `servername` del
  ClientHello y devuelve el `SecureContext` correcto). Si ese callback no corre en Bun, la
  intercepción TLS multi-host se rompe.
- **`oven-sh/bun#10603`** — control de ALPN en TLS para negociar h1/h2/h3: parcial.

Mitigaciones (en orden de preferencia):

1. **Spike bajo Bun (ticket 018, bloqueante):** correr `http-mitm-proxy` tal cual en Bun contra
   un target real y ver si el per-host cert funciona. El bug puede estar resuelto en la versión de
   Bun que fijemos — **verificar contra la versión pinneada, no asumir**.
2. **Generación eager de certs:** conocemos el package (`com.sample.oda.qa`) y podemos descubrir
   sus hosts. Si `SNICallback` no dispara, pre-generamos los certs de los hosts conocidos y los
   cargamos como `SecureContext` estáticos (o un TLS server por host), sin depender del callback.
3. **Aislar el subsistema para correrlo bajo Node:** el código es agnóstico de runtime (costura
   `runtime/spawn.ts`). El proxy es un subsistema paralelo (§5); si Bun no da, se puede lanzar el
   módulo proxy con Node embebido o como worker. Menos ideal (dos runtimes), pero preserva el
   binario principal Bun; sólo el inspector secundario dependería de Node.

Este riesgo es la razón por la que la decisión es "proxy propio TS **con spike de validación en
Bun antes de comprometer**", no "proxy propio TS y listo".

### 1.5 Shell-out a mitmproxy — descartado

Pros reales (h2/WS/flows out-of-the-box), pero rompe single-binary y mete Python. Sólo se
reconsidera si (a) el proxy propio no anda en ningún runtime **y** (b) 016 confirma que el HTTP
proxy es el único camino viable. No es el escenario esperado.

---

## 2. Gestión del CA

### 2.1 Emisión — ¿node:crypto o node-forge?

**node-forge v1.4.0** (BSD-3-Clause), no `node:crypto`. `node:crypto` firma/hashea pero **no tiene
API de alto nivel para construir y firmar certificados X.509** (crear un cert con extensions,
SAN, y firmarlo con la CA) — habría que ensamblar ASN.1/DER a mano. node-forge hace exactamente
esto y **ya es la dependencia de `http-mitm-proxy`**, así que no suma peso nuevo. Licencia BSD-3
compatible (evitar el opt-in GPLv2; usamos la BSD, que es el default recomendado del proyecto).

**Flujo de CA:**

1. **Una vez**, al primer uso del inspector: generar CA raíz (keypair RSA 2048 + cert
   self-signed con `basicConstraints cA:true`), persistir en
   `~/.sample-profiler/ca/` → `ca.key.pem` (0600) + `ca.cert.pem`.
2. Por-host, al vuelo: emitir leaf cert con SAN = hostname, firmado por la CA. Cachear en
   `~/.sample-profiler/ca/certs/<host>.pem` (o en memoria) para no re-emitir.
3. Reusar CA entre sesiones/devices: instalás la CA **una vez** por device y sirve para siempre.

Alineado con `~/.sample-profiler/` que ya usa el resto de la tool (sessions/).

### 2.2 Instalar la CA en el device Android sin root — el flujo real

Este es el punto más rígido y **parcialmente manual en Android 11+**. Dos caminos:

**Camino A — User CA (sin root, Android ≤13, el realista para nosotros):**

- `adb push ca.cert.pem /sdcard/Download/sample-ca.pem` (poner el PEM al alcance del picker).
- En **Android 11+ el install del user CA NO se puede automatizar**: el `CertInstaller` verifica
  quién lo invoca y **rechaza** cualquier install que no venga de la app Settings del sistema.
  `KeyChain.createInstallIntent()` ya no sirve y no se puede disparar desde adb.
  ⇒ **el usuario debe** hacerlo a mano: _Ajustes → Seguridad → Cifrado y credenciales →
  Instalar desde almacenamiento → Certificado de CA → aceptar el warning → elegir el archivo_.
  La tool **guía** con instrucciones exactas y puede abrir la pantalla de Seguridad
  (`adb shell am start -a android.settings.SECURITY_SETTINGS`), pero **no puede completar** los
  taps sin root/device-owner.
- **Requisito del APK (cruza con 016):** un user CA sólo lo respeta la app si el APK declara un
  `network_security_config` que **confíe en user CAs** (`<certificates src="user"/>`) para el
  build de debug/QA. En un APK Play Store release **no aplica** (Android 7+ ignora user CAs por
  default). ⇒ el build QA de sample tiene que traer ese config; es un ítem que 016 debe
  confirmar/pedir.

**Camino B — System CA (requiere root, fuera de scope v1):**

- Sin root **es imposible** instalar en el system store desde Android 7. Con root:
  renombrar el PEM al hash que espera Android — `HASH=$(openssl x509 -subject_hash_old -in
ca.cert.pem | head -1)`, archivo `${HASH}.0`, PEM plano — y copiarlo a
  `/system/etc/security/cacerts/` (o, en runtime sin remount, `/data/misc/user/0/cacerts-added/`).
  **map.md dice "device stock sin root" ⇒ este camino queda documentado pero NO es el default.**

**Conclusión CA:** en v1 asumimos **user CA + build QA con network_security_config que confía en
user CAs**, y la **instalación de la CA es un paso manual asistido, una sola vez por device**
(Android 11+ no deja automatizarlo sin root). La tool detecta si la CA ya está confiable
(probando una request interceptada) y sólo entonces habilita la captura.

---

## 3. Setear/limpiar el proxy del device por adb (con cleanup garantizado)

Todo pasa por la costura `AdbTransport.shell(serial, cmd)` — nada de adb directo.

**Setear (al arrancar la captura):**

```
settings put global http_proxy <hostReachableDesdeElDevice>:<port>
```

`<host>` es la IP de la máquina de la tool en la LAN (el device tiene que poder llegar; no
`127.0.0.1` salvo `adb reverse`). Alternativa robusta: **`adb reverse tcp:<port> tcp:<port>`** y
apuntar el proxy a `127.0.0.1:<port>` — evita pedir la IP de LAN y firewall. (Verificar en 016 si
UnityWebRequest respeta `adb reverse`; es TCP forward, no depende del proxy DNS del device.)

**Limpiar (al terminar / crash):**

```
settings put global http_proxy :0        # forma canónica de "sin proxy"
# o
settings delete global http_proxy
```

**Cleanup garantizado (patrón):**

1. Antes de tocar nada, **leer y guardar el estado previo**:
   `settings get global http_proxy` → guardar el valor (puede ser `null`/`:0`/un proxy real del
   usuario) en memoria y también en `~/.sample-profiler/proxy-restore.json` (por si el proceso
   muere sin correr el handler).
2. Restaurar **exactamente** ese valor previo en el teardown, no asumir "sin proxy".
3. Registrar handlers de `SIGINT`/`SIGTERM`/`beforeExit` + un `try/finally` alrededor de la
   sesión de captura, que llamen a `restore()`. `restore()` debe ser **idempotente**.
4. Al **arrancar la tool**, si existe `proxy-restore.json` de una corrida anterior que crasheó,
   ofrecer/ejecutar el restore huérfano antes de nada (recuperación de crash previo).
5. También borrar/limpiar `adb reverse` si se usó.

Esto es simétrico al patrón que ya vive en la tool para recursos y encaja con `runtime/spawn.ts`
(streams de larga vida con `stop()`).

**Gotcha Unity (cruza con gate 016 — NO se resuelve acá):**
`UnityWebRequest` / algunos stacks de red **pueden ignorar el proxy global del sistema**
(problema documentado en el issue tracker de Unity; Flutter/dart:io tienen el mismo síntoma).
Si 016 confirma que sample no respeta `http_proxy`, el enfoque "HTTP proxy vía settings" **no
ve nada** y hay que ir a **proxy transparente**: redirección a nivel red (iptables/pf en la
máquina host, o hotspot con NAT) para forzar el tráfico al proxy sin cooperación del cliente.
Eso implica: (a) el device tiene que rutear por nuestra máquina (hotspot/tethering o VPN
`tun`), (b) más setup por-OS y probablemente privilegios elevados, (c) choca con "self-contained
por OS" (iptables no está en macOS/Windows; sería `pf`/WFP). **Impacto de diseño:** el módulo de
transporte del proxy debe ser una **interfaz** con dos implementaciones (`HttpProxyTransport`
vs `TransparentProxyTransport`) para poder cambiar según lo que diga 016, sin reescribir el
inspector. En v1 arrancamos con HTTP-proxy y dejamos transparent como extensión.

---

## 4. Modelo de datos del flow HTTP

Un flow por request/response. Persistencia **aparte** de las muestras de recursos:
**`network.jsonl`** (una línea por flow) en el directorio de la sesión, junto a las muestras
de recursos (que van a su propio JSONL). No se mezcla con el sampler.

Campos (alineados conceptualmente con **HAR 1.2** para poder exportar sin re-modelar):

```ts
interface HttpFlow {
  id: string // uuid
  sessionId: string
  startedAt: string // ISO8601 (HAR: entry.startedDateTime)
  request: {
    method: string
    url: string
    httpVersion: string // "HTTP/1.1"
    headers: Header[] // [{name, value}]
    queryString: KV[]
    bodySize: number // bytes reales
    postData?: {
      mimeType: string
      text: string // truncado a maxBodyKB
      truncated: boolean
    }
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    headers: Header[]
    content: {
      size: number // bytes reales del body
      mimeType: string
      text?: string // truncado a maxBodyKB (base64 si binario)
      encoding?: 'base64'
      truncated: boolean
    }
    bodySize: number
  }
  timings: {
    // HAR-style, ms
    blocked?: number
    dns?: number
    connect?: number
    ssl?: number
    send: number
    wait: number // TTFB
    receive: number
  }
  timeMs: number // total (HAR: entry.time)
  serverIPAddress?: string
  error?: string // si el flow falló (TLS, timeout, etc.)
}
```

- **Body truncado a N KB configurable** (`maxBodyKB`, default p.ej. 32 KB) con flag `truncated` y
  `size` real preservado. Binario → base64 con `encoding: 'base64'`.
- **Export HAR 1.2:** trivial — `network.jsonl` → `{ log: { version:"1.2", creator, entries:[...] }}`
  mapeando cada `HttpFlow` a un `entry`. Esto habilita abrir la captura en Chrome DevTools / Charles
  / cualquier viewer HAR sin escribir un viewer propio.
- WebSocket: opcional en v1; si se agrega, frames como sub-eventos con `opcode`/`direction`/`data`
  truncado (no encaja en HAR estándar → JSONL propio, export HAR omite WS).

---

## 5. Composición con el resto

**El proxy es un subsistema paralelo, NO un collector por-tick del sampler.** El sampler corre a
1 Hz y produce muestras de recursos; el proxy es event-driven (un flow cuando la app hace una
request) y vive en su propio módulo.

**Ciclo de vida (atado a la sesión):**

- Al **empezar** una sesión con inspector habilitado: (1) generar/cargar CA, (2) verificar CA
  confiable en el device (§2.2), (3) setear proxy vía `AdbTransport` (§3), (4) levantar el TLS
  server MITM. Si (2) falla → sesión sigue **sin** inspector (degradación, no error fatal).
- Al **terminar/crash**: teardown que **siempre** restaura el proxy previo (§3) y cierra el server.

**Emisión al UI:** mismo WebSocket del dashboard que ya usa la tool, **evento aparte**
(`{ type: "http.flow", flow: HttpFlow }`) para no contaminar el stream de muestras de recursos.
El panel HTTP es una vista separada (map.md: "panel aparte, no compite con las métricas de
recursos"). Persistencia y stream son independientes del sampler.

**Degradación si 016 dice que no es interceptable:** el inspector es opt-in y **falla suave** —
si UnityWebRequest ignora el proxy, o hay pinning sin build sin-pinning, o la CA no está
instalada, la tool: (a) no rompe la sesión de recursos (que es el core), (b) muestra en el panel
HTTP un estado explícito ("no interceptable: <razón>") con el remedio, (c) deja lugar para el
transporte transparente como extensión futura (§3, interfaz `ProxyTransport`).

---

## Diseño de alto nivel (módulos / interfaces)

Nuevo subsistema `src/core/http-inspector/` (agnóstico de runtime; adb sólo vía `AdbTransport`;
subprocesos sólo vía `runtime/spawn.ts` si hiciera falta):

```ts
// Emisión de CA/certs — implementable con node-forge
interface CertAuthority {
  ensureRootCA(): Promise<{ certPem: string; keyPem: string }> // genera 1 vez, persiste
  certForHost(host: string): Promise<{ certPem: string; keyPem: string }>
  rootCertPath(): string // el ca.cert.pem a pushear al device
}

// Instalación/verificación de la CA en el device (usa AdbTransport)
interface DeviceCaInstaller {
  isTrusted(serial: string): Promise<boolean> // probe de intercepción
  instructions(serial: string): CaInstallSteps // pasos manuales Android 11+
  pushCert(serial: string): Promise<void> // adb push del PEM
}

// Set/clear del proxy del device con restore garantizado (usa AdbTransport)
interface DeviceProxyController {
  capturePrevious(serial: string): Promise<ProxyState> // settings get + persist a disco
  set(serial: string, host: string, port: number): Promise<void>
  restore(serial: string): Promise<void> // idempotente, corre en signal handlers
}

// El transporte del proxy: HTTP-proxy (v1) o transparente (futuro) — intercambiable por 016
interface ProxyTransport {
  start(onFlow: (f: HttpFlow) => void): Promise<{ host: string; port: number }>
  stop(): Promise<void>
}
class HttpMitmProxyTransport implements ProxyTransport {
  /* http-mitm-proxy + CertAuthority */
}
// class TransparentProxyTransport implements ProxyTransport { /* iptables/pf/tun, diferido */ }

// Persistencia + export
interface FlowStore {
  append(sessionId: string, flow: HttpFlow): Promise<void> // → network.jsonl
  exportHar(sessionId: string): Promise<HarLog> // HAR 1.2
}

// Orquestador: ata todo al ciclo de vida de la sesión y emite al WS del dashboard
class HttpInspector {
  async startForSession(serial: string, sessionId: string): Promise<InspectorStatus>
  async stop(): Promise<void> // restore proxy + close server, SIEMPRE
}
```

Costuras respetadas: **todo adb pasa por `AdbTransport`**; cualquier subproceso (si el fallback
transparente lo requiere) por `runtime/spawn.ts`; el core no conoce Bun vs Node (permite el
fallback de §1.4).

---

## Riesgos abiertos

- **R1 — Bun TLS server callbacks (`SNICallback`/`ALPNCallback` no disparan, bun#17932).**
  Es la ruta crítica del MITM per-host. Mitigación: spike bajo la versión pinneada de Bun (018);
  fallbacks = certs eager, o correr el proxy bajo Node. **Bloqueante para "proxy propio en Bun".**
- **R2 — Unity ignora el proxy del sistema (gate 016).** Si `UnityWebRequest` no respeta
  `http_proxy`, todo el enfoque HTTP-proxy no ve nada ⇒ hay que ir a transparente (más setup,
  privilegios, choca con self-contained). Depende del veredicto de 016.
- **R3 — HTTP/2:** `http-mitm-proxy` no hace h2; forzamos http/1.1 vía ALPN. Backends h2-only
  no se ven en v1.
- **R4 — Instalación de CA manual (Android 11+):** no automatizable sin root; UX = paso manual
  guiado una vez por device. Riesgo de fricción, no técnico.
- **R5 — Pinning (gate 016):** si el build QA pinnea certs, ni con CA confiable se ve el payload;
  requiere build QA sin pinning (o Frida+root, fuera de scope).
- **R6 — network_security_config del APK QA:** el build de sample debe declarar
  `<certificates src="user"/>` para debug/QA; ítem a confirmar/pedir en 016.
- **R7 — Alcance de red device→host:** proxy apuntando a la IP de LAN puede fallar por firewall;
  mitigación `adb reverse` (verificar que Unity lo respeta).

---

## Libs citadas (con versión y fuente)

> Context7 estaba `Pending approval` en esta sesión (ver nota arriba); versiones verificadas
> contra fuentes primarias.

- **`http-mitm-proxy` v1.1.0** — MIT — publicada 2023-11-26.
  Fuente: `https://registry.npmjs.org/http-mitm-proxy`,
  repo `https://github.com/joeferner/node-http-mitm-proxy`.
  CONNECT/TLS + WebSocket sí; HTTP/2 no. Usa node-forge para certs.
- **`node-forge` v1.4.0** — BSD-3-Clause (dual con GPLv2; usamos BSD) —
  `https://registry.npmjs.org/node-forge`. Emisión X.509 / CA / per-host certs.
- **`node-http-mitm-proxy`** — **no existe en npm (404)**; nombre viejo, el real es
  `http-mitm-proxy`.
- Bun `node:tls` / `node:http2` — `https://bun.com/reference/node/tls`,
  `https://bun.com/reference/node/http2/createSecureServer`. Server h2 desde ~1.1.31.
  Bug ruta-crítica: `oven-sh/bun#17932` (SNI/ALPN callbacks no disparan), `oven-sh/bun#10603`
  (control ALPN).

**Fuentes primarias (no-lib):**

- Android 11 CA restrictions — httptoolkit.com/blog/android-11-trust-ca-certificates,
  developer.android.com (network security config, user CAs Android 7+).
- Filename `subject_hash_old` + `.0` para system store —
  cs.android.com README.cacerts, OpenSSL issue #13565.
- `settings put/delete global http_proxy` — Android `settings` provider (documentado en múltiples
  gists/guías de proxying).
- Unity ignora proxy del sistema — Unity Issue Tracker (UnityWebRequest does not respect proxy
  settings) + Unity Discussions.
- Proxy transparente Android — docs.mitmproxy.org/stable/howto/transparent.
