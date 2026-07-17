---
id: 11
title: Session store + vista Historial
label: wayfinder:task
status: open
assignee:
blocked-by: [3, 4]
---

## Question

Implementar la persistencia (`~/.evermore-profiler/sessions/`, JSONL + `meta.json` según
el schema del ticket 3) y la vista **Historial** del UI: listar sesiones (fecha, app,
duración, device, resumen avg/pico), abrir una para verla con los mismos componentes del
dashboard, borrar con confirmación, y seleccionar 2+ para comparar/exportar.

Incluye tolerancia a sesiones truncadas (crash a mitad de grabación → se listan igual,
recuperando lo que haya) y a schemas viejos (campo de versión).
