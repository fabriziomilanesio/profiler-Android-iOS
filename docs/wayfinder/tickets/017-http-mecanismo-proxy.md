---
id: 17
title: Decidir el mecanismo del proxy MITM dentro del stack TS/Bun
label: wayfinder:research
status: closed
assignee: agent-http-mechanism
blocked-by: []
---

## Question

¿Cómo intercepta la tool el tráfico sin romper la historia de "un ejecutable
self-contained por OS" ni la costura del profiler?

Evaluar opciones y decidir:

1. **Proxy MITM propio en TS** (Bun/Node: server TCP + TLS con cert generado al vuelo por
   host, estilo `http-mitm-proxy`/`node-http-mitm-proxy`). Pro: entra en el binario, cero
   deps externas del usuario, un solo lenguaje. Contra: reimplementar CONNECT/TLS/HTTP2 y
   la CA es laburo; verificar madurez de libs y licencias.
2. **Shell-out a mitmproxy** (Python). Pro: batería incluida (flows, HTTP2, WS). Contra:
   rompe el single-binary (el usuario necesita Python+mitmproxy), va contra el ADR del
   stack. Solo si la opción 1 no da.

Decidir además, informado por el gate 016:

- **Gestión del CA:** generar la CA una vez, guardarla en `~/.evermore-profiler/`, y el
  flujo para instalarla en el device (`adb push` + install del cert, o instrucciones si
  requiere acción manual en Ajustes).
- **Setear/limpiar el proxy del device** por adb al empezar/terminar la captura
  (`settings put/delete global http_proxy`), con cleanup garantizado aunque la tool crashee.
- **Modelo de datos del flow HTTP** (request/response, timing, tamaños, headers, cuerpo
  truncado a N KB) y cómo se guarda junto a la sesión (JSONL aparte, no mezclar con las
  muestras de recursos).
- Cómo se compone con el `AdbTransport` y el sampler existentes (es un subsistema paralelo,
  no un collector por-tick).

Entregable: doc `docs/research/http-inspector-mechanism.md` con la decisión y el diseño de
alto nivel; alimenta el ticket 018.

## Resolution (2026-07-17)

DECISIÓN: **proxy MITM propio en TS embebido en el binario** — `http-mitm-proxy` v1.1.0 (MIT) con
CA/certs vía `node-forge` v1.4.0 (BSD-3). Cero deps del usuario; **shell-out a mitmproxy descartado**
por violar single-binary. Salvedad dura: bug de Bun (`oven-sh/bun#17932`: `SNICallback`/`ALPNCallback`
no disparan en TLS server) golpea la generación de cert por-host → **spike bloqueante bajo Bun en
018**; fallbacks = certs eager por-host o correr el subsistema bajo Node (código agnóstico). CA:
generada 1 vez en `~/.evermore-profiler/ca/`; en **Android 11+ instalar el user CA es MANUAL**
(no automatizable sin root) y el APK QA necesita `network_security_config` que confíe en user CAs.
Proxy vía `AdbTransport` (`settings put/delete global http_proxy`, con restore idempotente del estado
previo persistido a disco + signal handlers). Flows en `network.jsonl` aparte (modelo estilo HAR 1.2,
body truncado a N KB), export HAR; subsistema paralelo (no collector por-tick), emite al WS del
dashboard como evento aparte, degrada suave si 016 dice no-interceptable. Riesgo cruzado con 016:
UnityWebRequest puede ignorar el proxy → interfaz `ProxyTransport` para caer a transparente (iptables/pf).

Doc completo: [docs/research/http-inspector-mechanism.md](../../research/http-inspector-mechanism.md)
