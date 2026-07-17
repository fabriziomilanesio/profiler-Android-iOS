---
id: 22
title: Retirar todo lo mockeado — integración final real end-to-end
label: wayfinder:task
status: open
assignee:
blocked-by: [21]
---

## Question

Los prototipos (`prototypes/dashboard`, `prototypes/report`) fueron andamios para validar
diseño con datos fake. Con la conexión real del ticket 21 en pie, el producto pasa a ser la
integración real y **todo lo mockeado se retira**:

- Eliminar los **generadores de datos fake**: `prototypes/dashboard/sim.js` y
  `prototypes/report/fixtures.js` (y sus smoke que dependen de datos inventados).
- El **dashboard real** (src/ui, alimentado por WS) es el único; la UI no debe tener ningún
  camino que use datos simulados. Los screenshots de prototipo se borran o se regeneran con
  datos reales.
- El **reporte real** se genera desde **sesiones grabadas reales** (JSONL del sampler), no
  desde fixtures: mover la lógica de layout validada del prototipo a src/report/ y
  alimentarla con el `SessionSummary` calculado sobre sesiones reales.
- Dejar el layout/estilo/branding ya validado (eso se conserva), pero sin ninguna fuente de
  datos inventada en el árbol final.
- Actualizar README y el mapa: los prototipos dejan de ser el artefacto; el entrypoint es
  `profiler live` (monitor real) + `profiler report <session…>` (export real).

Resultado: correr la tool contra el device produce el monitor en vivo y el reporte, sin una
sola línea de mock en el camino de producción.
