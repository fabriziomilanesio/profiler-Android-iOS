---
label: wayfinder:ticket
title: Frame-time y jank primera clase (p50/p90/p99, sin overhead nuevo)
status: open
assignee:
blocked-by: []
---

# 024 — Frame-time y jank primera clase

## Question

Derivar frame-times individuales y jank del dump de SurfaceFlinger que **ya se hace por
tick** — el promedio de FPS esconde los tirones. ¿Qué estructura exacta (percentiles,
ventanas, conteos) exponemos en `Sample` y en el dashboard?

## Contexto (grilling 2026-07-31)

- **Restricción dura**: cero comandos nuevos al device. El colector de FPS ya lee el dump
  de latencia de SurfaceFlinger con timestamps por frame; los frame-times salen de ahí.
  Si un dato exige otra lectura por tick, queda afuera o va al carril lento.
- Umbral de jank **relativo al refresh rate real del panel** (60/90/120 Hz), leído una vez
  al conectar el device — no 16.6 ms hardcodeado.
- Métricas esperadas: frame-time p50/p90/p99, % de frames janky, frames > 1 vsync
  perdido. Persisten en la sesión JSONL como el resto (alimentan al reporte del 026).
- UI: los datos entran al dashboard (card/serie de FPS existente); el rediseño fino de
  presentación es del 031/032 — acá alcanza con que se vean y sean correctos.
- Tests contra fixtures reales (hay dumps del Galaxy A15 en `fixtures/sm-a155m-api36/`).
