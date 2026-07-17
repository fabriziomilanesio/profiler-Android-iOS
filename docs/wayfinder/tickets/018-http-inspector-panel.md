---
id: 18
title: Inspector HTTP — panel secundario + resumen en el reporte
label: wayfinder:task
status: open
assignee:
blocked-by: [16, 17]
---

## Question

Implementar el inspector HTTP como **feature secundaria** (panel aparte, no compite con las
métricas de recursos que son el core), según el mecanismo del ticket 17 y el veredicto de
viabilidad del 16:

- **Captura:** proxy MITM levantado por la tool, cert gestionado, proxy del device seteado
  al empezar y limpiado al terminar/crashear; flows guardados junto a la sesión (JSONL
  aparte).
- **Panel UI:** tab/sección "Network" separada del dashboard de recursos — lista de
  requests (método, URL, status, tiempo, tamaño ↓/↑), con detalle al click (headers de
  request/response, cuerpo truncado, timing). Filtro por host/status. Contador en vivo.
- **Reporte:** el HTML de comparación suma una sección **resumen** de red HTTP (top hosts,
  # requests, bytes, status codes, requests más lentas) — resumen, no el waterfall
  completo, coherente con "network = resumen en el reporte".
- **Degradación:** si el gate 016 dice que el device/build no es interceptable, el panel
  muestra el motivo y el remedio (igual que el preflight), sin romper el resto de la tool.

Alineado con el mapa: el inspector es secundario pero presente; las métricas de recursos
no dependen de él.

## Ya resuelto por el ticket 019 (no rehacer)

El core device-independent ya está en `src/core/http-inspector/` con 28 tests: `CertAuthority`
(CA + certs por-host), `DeviceProxyController` (set/get/restore del proxy por adb con
restauración exacta + recuperación de crash), `FlowStore` + tipos `HttpFlow`/HAR 1.2 (export HAR).
Este ticket **reusa** esos módulos; sólo agrega lo que necesita device/UI.

**Restricción dura del spike R1 (Bun 1.3.11): `SNICallback`/`ALPNCallback` NO disparan.** El
proxy MITM real NO puede emitir el leaf por-host dentro del callback TLS. Opciones (research §1.4):
un TLS server por-host cargando el `SecureContext` eager de `CertAuthority.certForHost()`, o
correr el subsistema proxy bajo Node. Validar el enfoque elegido en un spike de `http-mitm-proxy`
bajo Bun al arrancar 018.

Falta implementar acá: `HttpMitmProxyTransport` (proxy real), `DeviceCaInstaller` (push + probe
`isTrusted` + instrucciones manuales de install del user CA en Android 11+), el orquestador
`HttpInspector` (ata todo al ciclo de sesión + signal handlers que llaman `restore()`), el panel
UI "Network", y el resumen HTTP en el reporte.
