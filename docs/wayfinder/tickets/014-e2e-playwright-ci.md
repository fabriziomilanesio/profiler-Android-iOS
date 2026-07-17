---
id: 14
title: E2E Playwright + CI matrix 3 OS
label: wayfinder:task
status: open
assignee:
blocked-by: [7, 9, 10]
---

## Question

Cerrar la capa 2 del harness: suite Playwright que levanta la tool completa apuntando al
fake-adb standalone y verifica de punta a punta:

- preflight pasa y aparece el device fake con su ficha
- al seleccionar la app, gauges y timeline actualizan con los valores esperados del guion
- escenario desconexión/reconexión: UI muestra el estado y se re-engancha
- sesión se graba, aparece en Historial con agregados correctos
- export del reporte: el HTML resultante contiene los números esperados (assert sobre los
  datos inline, no screenshot-diff)

Más CI (GitHub Actions cuando el repo tenga remoto): matrix ubuntu/macos/windows corriendo
unit + e2e, y el build `bun build --compile` por OS como artifact. Umbral: suite e2e < 5
min para que se corra siempre.
