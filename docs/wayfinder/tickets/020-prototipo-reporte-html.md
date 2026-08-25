---
id: 20
title: Prototipo del reporte HTML — resumen de sesión + comparación
label: wayfinder:prototype
status: closed
assignee: agent-report
blocked-by: []
---

## Question

¿Cómo se ve y qué dice el reporte HTML exportado? Prototipo device-independent (datos de
sesión fake, como el del dashboard) para validar con el humano el resumen por sesión y la
comparación, y fijar la forma del `SessionSummary` que después consume el ticket 12 real.

El reporte debe responder de un vistazo, para una **sesión guardada**: cuánto usó de
**RAM, GPU, batería, temperatura, CPU y FPS** — avg / pico / mín por métrica, y para
batería el **drenaje %** durante la sesión (nivel inicial − final) + mA promedio. Más:
duración, app/bundle id, ficha del device.

Cubrir en el prototipo (`prototypes/report/`, HTML standalone offline, ECharts + fuentes
vendoreadas, branding sample/Generic, mismo look que el dashboard, **light default**):

1. **Modo 1 sesión:** tarjetas de resumen por métrica (número grande avg + pico/mín chico),
   la torta de composición de memoria promedio, timelines de la sesión completa, y una fila
   de "consumo": batería drenada %, temp máxima, RAM pico, etc.
2. **Modo comparación (2+ sesiones):** tabla de deltas avg/pico por métrica con dirección
   (mejor/peor coloreada), barras agrupadas por métrica-sesión, timelines superpuestas, y
   **advertencia visible si los devices/condiciones difieren** (benchmark no comparable).
3. Un generador de 2-3 "sesiones" fake distintas (misma app, distintos bundle id: qa vs
   prod) para poblar ambos modos.

Verificar headless (smoke + screenshots que se revisan). Al cerrar, anotar en el ticket la
forma del `SessionSummary` propuesta (contrato para el schema del ticket 3 y el reporte real
del ticket 12) y las preguntas de feedback para el humano.

## Resolution (2026-07-17)

Prototipo entregado en `prototypes/report/` (HTML standalone 100% offline: ECharts, fuentes
woff2 y logos vendoreados). Smoke (`bun prototypes/report/smoke.js`) → **SMOKE PASS** (95 checks).
Verificación headless con playwright-core (chrome-headless-shell): **0 errores de consola** y
**0 px de overflow** en 1440, 1024 y 390; screenshots revisados: `report-single.png`,
`report-compare.png`, `report-mobile.png`.

### (a) Forma final del `SessionSummary` — contrato propuesto para tickets 3 y 12

Precalculado por sesión (todo derivable de la serie 1 Hz; el reporte no re-agrega). Cada
métrica escalar es un `Stats { avg, peak, min, p90 }`. Batería y memoria tienen forma propia.

```ts
type Stats = { avg: number; peak: number; min: number; p90: number }

interface SessionSummary {
  cpu: Stats // %
  gpu: Stats // %
  fps: Stats // frames/s
  tempC: Stats // °C (temperatura del SoC)
  ramMb: Stats // MB (PSS total)

  battery: {
    levelStart: number // %  al inicio de la sesión
    levelEnd: number // %  al final
    drainPct: number // = levelStart - levelEnd  (>0 en sesión activa)  ← la métrica estrella
    avgMa: number // mA de descarga promedio
    tempPeak: number // °C  temperatura máx de la batería
    tempAvg: number // °C
  }

  memAvg: {
    // breakdown promedio de PSS por categoría; suma ≈ ramMb.avg (invariante)
    java: number
    native: number
    graphics: number
    code: number
    stack: number
    other: number
  }
}
```

La sesión completa que lo envuelve: `{ id, app, bundleId, label, device, startedAt (ISO),
durationS, samplingHz, sampleCount, series[], summary }`. `device` incluye
`batteryCapacityMah` (necesario para derivar `drainPct` de los mA). El sample 1 Hz agrega, sobre
lo del dashboard, `battery { level%, tempC, mA }`.

**Comparabilidad:** el reporte marca el benchmark como comparable ✓ solo si todas las sesiones
comparten `device.model`, `device.os` y `samplingHz`; si difieren, banner rojo "not directly
comparable" (rama de código presente y viva). Dirección better/worse por métrica: menos
batería/temp/RAM/CPU/GPU = mejor; más FPS = mejor.

### (b) Qué quedó en el prototipo

- `fixtures.js` — 3 sesiones **determinísticas** (PRNG seedeado) de la misma app con distinto
  bundle id: `com.sample.oda.qa` (intensity 1.18), `com.sample.oda` (0.92) y una RC (1.02).
  QA drena más batería, corre más caliente y usa más RAM que prod → la comparación tiene señal.
  Corre en browser (`ReportFixtures`) y en Bun.
- `report.html` + `report.js` — dos modos por toggle en el header:
  - **1 sesión:** selector de sesión, ficha de device (incl. mAh), ficha app/bundle/fecha/
    duración/sampling, fila de tarjetas de consumo (batería = estrella "🔋 −X% drained" + temp
    máx + mA prom; luego CPU/GPU/FPS/Temp/RAM con avg grande + pico/mín), torta de composición de
    memoria promedio y timeline de la sesión completa con toggles (incluye serie de batería).
  - **Comparación:** banner de comparabilidad, tabla de deltas avg/pico por métrica con pills
    better/worse coloreadas, barras agrupadas (normalizadas al máx por métrica) y timelines
    superpuestas alineadas por segundo transcurrido con selector de métrica.
  - Light default + toggle a dark (rebuild de charts), responsive sin overflow (1440/1024/390),
    header en una línea.
- `smoke.js` — sin browser: valida rangos/invariantes (drainPct>0, nivel de batería monótono,
  summary consistente con la serie, memAvg suma el PSS avg, señal qa>prod, determinismo), parsea
  `report.js`/`fixtures.js` con `new Function`, y chequea refs a assets/vendor.

### (c) Preguntas de feedback para el humano

1. **`drainPct` como % absoluto** (−1.8 % en 5 min) vs. **% normalizado por hora** (mAh/h o
   %/h, comparable entre sesiones de distinta duración). ¿Cuál es el número que querés grande?
2. **Timeline de una sola escala 0–100 normalizada** (como el dashboard) vs. **ejes separados
   por métrica**. En el reporte impreso, ¿preferís claridad de un eje real por métrica aunque
   sean varios gráficos apilados?
3. **Baseline de la comparación = primera sesión.** ¿Debería poder fijarse cuál es la baseline
   (dropdown), o siempre prod es el "golden"?
4. **`p90` en el summary:** ¿lo querés visible en las tarjetas (hoy en CPU/GPU) o alcanza con
   avg/pico/mín y p90 queda solo en el dato exportado?
5. **Temp:** ¿reportamos temp del **SoC** y de **batería** por separado (hoy sí) o el humano solo
   mira una?
6. **Export:** este prototipo es 1 archivo con datos embebidos. El reporte real (ticket 12),
   ¿un HTML self-contained por sesión, o un HTML + JSON de datos al lado?
