---
id: 9
title: fake-adb — transport de replay para el harness (capa 2)
label: wayfinder:task
status: open
assignee:
blocked-by: [1, 4]
---

## Question

Implementar el `AdbTransport` falso que hace posible el e2e sin device: replayea las
sesiones grabadas del ticket 1 con timing realista y permite guionar escenarios:

- device presente → responde fixtures secuenciados a 1 Hz
- device se desconecta a los N segundos y reaparece a los M (prueba la reconexión)
- app muere y revive (pid cambia)
- output corrupto/truncado (prueba que los parsers degradan sin romper)
- device sin fuente GPU/temp (prueba métricas N/A)

Decidir el formato del guion de escenario (JSON declarativo versionado en el repo) y
exponer el fake tanto como clase in-process (para tests de integración) como ejecutable
standalone que imita el CLI de adb (para el e2e de la tool completa empaquetada).
