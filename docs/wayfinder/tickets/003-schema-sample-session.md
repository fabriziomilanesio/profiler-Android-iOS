---
id: 3
title: Definir schema Sample/Session y metadata de device
label: wayfinder:grilling
status: open
assignee:
blocked-by: [1, 2]
---

## Question

¿Cuál es el modelo de datos exacto (tipos TS compartidos front/back) de una muestra
(`Sample`), una sesión (`Session`, JSONL + sidecar de metadata) y la ficha de device
(`DeviceInfo`)?

Decidir, informado por los fixtures reales (ticket 1) y el research de formatos (ticket 2):

- Campos de `Sample`: timestamp relativo/absoluto, cpu%, mem (pss total + breakdown),
  fps/jank/frame-times, temp por zona, gpu%, batería (nivel %, temp, mA), net rx/tx
  acumulado — y cómo se representa "métrica no disponible en este device" (null vs
  ausente) sin romper charts ni reporte.
- `Session`: naming del archivo, sidecar `meta.json` (app, bundle id, device, inicio,
  duración, versión de la tool, sampling rate), versionado del schema para sesiones viejas.
- `DeviceInfo`: modelo, fabricante, Android + API, RAM total, GPU vendor/renderer, SoC,
  resolución.
- Qué agregados precalcula el cierre de sesión (avg/p50/p90/max por métrica, y **drenaje
  de batería %** = nivel inicial − final) para que el historial y el reporte listen
  resúmenes sin re-parsear JSONL completos. El prototipo del reporte (ticket 20) fija la
  forma de este `SessionSummary`.
