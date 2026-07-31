---
label: wayfinder:ticket
title: Errores y crashes marcados sobre el timeline del reporte HTML
status: open
assignee:
blocked-by: [026, 027]
---

# 030 — Logs dentro del reporte HTML

## Question

El reporte de perf suma la dimensión de logs: errores/warnings de la ventana exportada
listados, y crashes/errores **marcados sobre el timeline de FPS** (un crash = marca roja
sobre la curva, con tooltip). ¿Cuánto log se embebe en el HTML standalone sin inflarlo
(hoy ~2.5 MB) — solo Error/Warn con cap, o resumen + conteos?

## Contexto (grilling 2026-07-31)

- Es la pieza que une los dos frentes: "el juego se cayó acá" visible en la misma vista
  que "y el GPU/temp estaban así".
- Respeta el recorte por tramo continuo de la app actual que ya hace el reporte.
- Depende de la correlación del 026 (timeline nuevo) y de la persistencia de logs
  del 027.
