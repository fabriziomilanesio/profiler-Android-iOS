---
label: wayfinder:ticket
title: Costura MetricSource — envolver Android sin tocarlo
status: closed
assignee: claude
blocked-by: [033]
---

# 035 — Costura `MetricSource`

## Question

¿Cuál es la forma exacta de la interfaz que emite `Sample`s, para que Android entre
envuelto sin modificarse y iOS entre con un loop propio?

## Contexto (grilling 2026-08-10)

**Por qué la costura NO va en `AdbTransport`.** Su contrato es
`shell(serial, command) → {stdout, stderr, exitCode}`: request/response de texto. DTX no
es eso — es una **suscripción** donde el device empuja mensajes (`sysmontap` tira un
sample cada N ms). Meter iOS adentro de `shell()` es inventar comandos falsos para tapar
un modelo que no coincide.

**Por qué el `Sampler` tampoco se comparte.** Son 384 LOC con `SHELL_COMMANDS`
hardcodeado adentro, y su arquitectura de dos carriles (rápido/lento con carry-forward)
existe por una razón exclusivamente Android: `dumpsys meminfo` tarda cientos de ms en
gama baja y contiende con el proceso del juego vía `mmap_lock` — el observer effect del
ticket 023. En iOS ese problema no existe. Compartirlo no ahorra nada y arrastra
complejidad sin sentido.

**Lo que se reusa gratis, sin tocarlo**: todo lo que consume `Sample` río arriba —
`core/session/` (store + stats + JSONL), `core/perf/` (semáforos y veredicto),
`report/` (HTML autocontenido y benchmarking), `server/` (HTTP + WS + UI embebida) y
`ui/` completo. Es la mayoría del valor del producto.

## Restricción dura

**Los 344 tests verdes no se mueven.** `AdbTransport`, `Sampler` y los 9 collectors
quedan **intactos**; `AndroidMetricSource` los envuelve. Android no se refactoriza para
acomodar una plataforma que recién se está probando — todo el riesgo queda confinado al
código iOS nuevo.

## A decidir en este ticket

- Shape de `MetricSource`: cómo emite samples (push vs pull), cómo entrega la ficha del
  device, cómo arranca/para, cómo reporta pérdida de conexión.
- Cómo expone las **capacidades** (qué métricas existen en esta plataforma/device) — el
  detalle del contrato de capacidades es del 037, acá sólo el punto de entrada.
- Dónde queda la selección de plataforma: CLI, descubrimiento automático, o el server
  ofreciendo devices de las dos fuentes en una sola lista.
- Qué pasa con `devices()`/`trackDevices()`: en iOS la fuente es la API HTTP local del
  `tunneld`, que tiene el mismo shape (lista de devices con estado) que
  `adb devices`/`track-devices`, así que la UI no debería enterarse de la diferencia.
