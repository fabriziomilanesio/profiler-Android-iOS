---
label: wayfinder:ticket
title: Prototipo del rediseño del dashboard (evolución de la identidad actual)
status: open
assignee:
blocked-by: [026, 029, 030]
---

# 031 — Prototipo del rediseño visual

## Question

Prototipo HTML estático (como el 007) del dashboard rediseñado, con **todas las piezas
nuevas ya existiendo** (frame-time/jank, semáforos, panel de logs, veredicto). HITL: se
itera con feedback humano hasta acordar el diseño; recién entonces se implementa (032).

## Contexto (grilling 2026-07-31)

- **Dirección decidida: evolucionar la identidad actual** (branding Evermore/Odaclick,
  dark theme, paleta `#EB008B`/`#00E6DA`, Baloo 2 + Inter) — no partir de cero. Look de
  herramienta pro (perfetto/grafana bien hecho).
- **Legible de un vistazo**: semáforos integrados, números grandes, menos ruido — que
  cualquiera del equipo lea el estado sin interpretar gauges.
- **Layout con jerarquía**: perf (FPS/frame-time, GPU) protagonista, logs como sección
  propia, cards agrupadas por tema.
- Retomar las 3 preguntas abiertas del prototipo 007 (eje del timeline, series default,
  chips GC/JANK) — ahora hay datos reales para decidirlas.
- Consultar el skill `frontend-design` al armarlo.
