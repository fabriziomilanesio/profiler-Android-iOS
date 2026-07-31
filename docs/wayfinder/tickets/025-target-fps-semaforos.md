---
label: wayfinder:ticket
title: Target FPS configurable + semáforos verde/amarillo/rojo
status: open
assignee:
blocked-by: []
---

# 025 — Target FPS configurable + semáforos

## Question

Agregar el target de FPS como configuración persistida y aplicar el esquema de semáforos
a las métricas de FPS/frame-time del dashboard. ¿Dónde exactamente se pinta el estado
(gauge, card, badge) sin esperar al rediseño?

## Contexto (grilling 2026-07-31)

- Target editable en ☰ Configuración, **default 30 FPS** (gama baja donde testea Evermore),
  persistido en `config.json` como el resto (`appStore`).
- Esquema decidido: **verde ≥ target · amarillo ≥ 80% del target · rojo abajo**.
- El reporte (026) declara el target usado en la ventana exportada.
- Umbrales de semáforo para métricas no-FPS (CPU/GPU/temp) siguen en el fog del mapa —
  se calibran con datos reales, no acá.
