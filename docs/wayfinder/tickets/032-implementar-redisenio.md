---
label: wayfinder:ticket
title: Implementar el rediseño en src/ui (y coherencia con el reporte)
status: open
assignee:
blocked-by: [031]
---

# 032 — Implementación del rediseño

## Question

Llevar el prototipo aprobado del 031 a `src/ui/` (y ajustar el reporte HTML para que
hable el mismo lenguaje visual). ¿Migración en un paso o por secciones, manteniendo el
dashboard usable en cada commit?

## Contexto

- El UI embebido va en el binario (`src/server/embeddedUi.ts` — todo asset nuevo se suma
  al manifest o el standalone lo sirve 404).
- Tema claro/oscuro persistido debe seguir funcionando.
- Verificación visual con el flujo de evidencia del workspace (eyes + smoke-selector
  `bun scripts/smoke-selector.ts` para probar sin device).
