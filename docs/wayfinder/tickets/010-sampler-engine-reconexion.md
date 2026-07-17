---
id: 10
title: Sampler engine — scheduling, sesiones y reconexión
label: wayfinder:task
status: open
assignee:
blocked-by: [4, 8]
---

## Question

Implementar el corazón de la tool: el loop que cada tick (1 Hz default, configurable) corre
los collectors sobre `AdbTransport`, arma el `Sample`, lo emite al WS y lo appendea al
JSONL de la sesión activa.

Debe resolver: ciclo de vida de sesión (start/stop, metadata al abrir, agregados al
cerrar), selección de device y de app (listar packages, recordar la última), captura de
`DeviceInfo` al conectar, y **reconexión automática** — device que se cae marca la sesión
con un gap y re-engancha solo cuando vuelve (vía `adb track-devices`), app que muere idem.
Collectors best-effort (GPU/temp) que fallan una vez quedan marcados N/A sin reintentar
cada tick. Testeado contra el fake-adb in-process (escenarios de desconexión del ticket 9).
