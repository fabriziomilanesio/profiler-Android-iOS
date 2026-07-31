---
label: wayfinder:ticket
title: Reporte — correlación FPS↔GPU/CPU/temp + veredicto de perf
status: open
assignee:
blocked-by: [024, 025]
---

# 026 — Reporte: correlación y veredicto de perf

## Question

El reporte HTML pasa de cards sueltas a responder "¿por qué bajó el framerate acá?":
timeline con FPS/frame-time superpuesto a GPU%, CPU% y temperatura, y una apertura con
**veredicto de perf**. ¿Qué señales definen "throttling detectado" y "peor tramo" de
forma robusta con los datos que ya hay?

## Contexto (grilling 2026-07-31)

- Veredicto al inicio del reporte: semáforo general, **% del tiempo en target** (30/60,
  el configurado en 025), peores N tramos con timestamp, throttling térmico detectado
  (temperatura sostenida + caída de FPS/GPU correlacionada).
- Todo es **análisis sobre datos ya capturados** — el reporte no agrega ninguna carga al
  device.
- Se apoya en frame-time/jank del 024 y el target del 025; declara el target usado.
- Mantener el patrón actual: HTML standalone (~2.5 MB, ECharts + datos embebidos), recorte
  al tramo continuo de la app actual.
