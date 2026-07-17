---
id: 8
title: Parsers de métricas contra fixtures (capa 1 del harness)
label: wayfinder:task
status: open
assignee:
blocked-by: [1, 2, 4]
---

## Question

Implementar test-first (skill /tdd) los parsers puros — string crudo → tipo del schema —
para: `dumpsys meminfo` (bloque App Summary), CPU (deltas `/proc/<pid>/stat` vs
`/proc/stat`), FPS/jank/percentiles vía `SurfaceFlinger --timestats` (primaria) y
`--latency` (fallback, con descubrimiento de layer por `--list` — gfxinfo NO ve Unity),
`thermalservice` (fallback thermal zones sysfs), fuente GPU disponible (probing
kgsl→Mali/Xclipse), `dumpsys netstats detail` por-uid, **`dumpsys battery`** (level %,
temperature ÷10 °C, current_now mA, status), y `getprop`+`SurfaceFlinger` → `DeviceInfo`.
Seguir las decisiones primaria/fallback de docs/research/dumpsys-formats.md.

Reglas: cada parser es una función pura sin I/O, testeada contra los fixtures reales del
ticket 1; ante formato desconocido devuelve "métrica no disponible" tipada, jamás lanza ni
devuelve basura silenciosa. Cobertura de al menos un fixture por device capturado.
