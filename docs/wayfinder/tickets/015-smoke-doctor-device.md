---
id: 15
title: Comando doctor — smoke con device real (capa 3)
label: wayfinder:task
status: open
assignee:
blocked-by: [10, 13]
---

## Question

Implementar `profiler doctor`: con un device real enchufado, corre el preflight, detecta
la app (default `com.sample.oda.qa`, override por flag), samplea ~30s y reporta por
consola qué métrica anda y cuál no en ese device (CPU ✓, RAM ✓, FPS ✓, temp ✓/N-A,
GPU ✓/N-A, net ✓), con valores de muestra para sanity-check humano.

Además: modo `doctor --capture` que guarda los outputs crudos como fixtures nuevos
(alimenta el corpus del ticket 1 con cada device/OEM nuevo que toque la tool). Se corre a
mano antes de cada release.
