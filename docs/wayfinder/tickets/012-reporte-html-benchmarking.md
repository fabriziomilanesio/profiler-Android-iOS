---
id: 12
title: Reporte HTML autocontenido de comparación/benchmarking
label: wayfinder:task
status: open
assignee:
blocked-by: [7, 11, 20]
---

## Question

Implementar el export: N sesiones seleccionadas → **un solo archivo HTML** sin
dependencias de red (ECharts + datos inline), enfocado en comparación entre builds
(misma app, distintos bundle ids):

- Cabecera con ficha de cada sesión (app, bundle id, device, fecha, duración) y
  **advertencia visible si los devices/condiciones difieren** (benchmark no comparable).
- Timelines superpuestas por métrica (serie por sesión).
- Tabla de deltas: avg/p50/p90/max por métrica (incl. **batería drenada %** y temp máxima),
  con dirección (mejor/peor) coloreada.
- Barras agrupadas por métrica-sesión; percentiles de frame time.
- Resumen de red (total rx/tx por sesión).
- Branding sample/Generic del ticket 6.

Reusa el layout y el `SessionSummary` validados en el prototipo del ticket 20 (no rediseñar).

Decidir además el naming del archivo exportado y que el caso N=1 (reporte de una sola
sesión) también funcione. Los números del reporte deben salir de los mismos agregados que
muestra el Historial — una sola fuente de verdad.
