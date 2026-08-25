---
label: wayfinder:ticket
title: Reporte — correlación FPS↔GPU/CPU/temp + veredicto de perf
status: closed
assignee: claude
blocked-by: [024, 025]
---

# 026 — Reporte: correlación y veredicto de perf

## Question

El reporte HTML pasa de cards sueltas a responder "¿por qué bajó el framerate acá?":
timeline con FPS/frame-time superpuesto a GPU%, CPU% y temperatura, y una apertura con
**veredicto de perf**. ¿Qué señales definen "throttling detectado" y "peor tramo" de
forma robusta con los datos que ya hay?

## Contexto (grilling 2026-07-31)

- Veredicto al inicio del reporte: semáforo general, **% del tiempo en target** (30/60,
  el configurado en 025), peores N tramos con timestamp, throttling térmico detectado
  (temperatura sostenida + caída de FPS/GPU correlacionada).
- Todo es **análisis sobre datos ya capturados** — el reporte no agrega ninguna carga al
  device.
- Se apoya en frame-time/jank del 024 y el target del 025; declara el target usado.
- Mantener el patrón actual: HTML standalone (~2.5 MB, ECharts + datos embebidos), recorte
  al tramo continuo de la app actual.

## Entregado

- **Core puro `src/core/perf/verdict.ts`** (importa `fpsStatus` del 025, no lo
  reimplementa): `timeInTarget`, `worstWindows`, `detectThrottling`, `redSpans` y el
  ensamblador `buildPerfVerdict(series, fpsTarget)`. Todo null-safe: sesión vieja sin
  `frame` ⇒ el score degrada a solo-FPS; sin FPS ⇒ `overall: null` ("datos
  insuficientes"), nunca throw.
- **"Peor tramo" (decisión)**: ventana deslizante de **30 s** anclada en cada tick;
  score 0–100 por tick con FPS = **70 % déficit de FPS contra el target
  (`(target−fps)/target`) + 30 % jank% del tick** (sin jank ⇒ 100 % FPS). Ventanas con
  < 3 ticks con FPS no compiten; **score < 1 es ruido** y no se reporta (el jank real
  de 0.93 % del A15 no fabrica tramos); se eligen las **top 3 sin solaparse** (greedy
  por score, empate ⇒ la más temprana).
- **Throttling térmico (heurística conservadora — mejor no acusar que acusar mal)**:
  temperatura **≥ 42 °C sostenida ≥ 60 s** Y caída **≥ 15 %** del FPS y/o GPU% promedio
  del tramo caliente contra la **línea de base fría anterior** (≥ 5 ticks fríos con
  dato; ≥ 3 ticks calientes). Sesión que arranca ya caliente ⇒ sin línea de base ⇒ NO
  se acusa. El reporte igual muestra el tramo caliente cuando existió sin caída
  ("sustained heat… not calling it throttling"). Umbrales exportados como constantes
  (`THROTTLE_*`, `WORST_*`, `SCORE_WEIGHT_*`) en `verdict.ts`.
- **Cadena del target**: `BuildReportOptions.fpsTarget` (ausente ⇒ 30, el default del
  AppStore) → `ReportSession.fpsTarget` + `ReportSession.verdict` (embebidos en el
  HTML) → `handleReport` pasa `config().fpsTarget` al momento de exportar. El reporte
  declara "target: N FPS" en la apertura y como markLine del chart.
- **Apertura del reporte (template)**: sección "Performance verdict" con semáforo
  general (luz + título; agregado usado = **FPS promedio de la ventana** vía
  `fpsStatus`), chip del target, **barra apilada de % del tiempo en
  verde/amarillo/rojo ponderada por ticks con dato**, lista de peores 3 tramos
  (score, HH:MM:SS–HH:MM:SS, FPS avg/min · jank · GPU · CPU · temp del tramo) y caja
  de throttling con el detalle (tramo caliente, peak, FPS/GPU antes→durante y −%).
- **Chart de correlación** ("Correlation — FPS ↔ GPU · CPU · Temp"): dos grids ECharts
  con **x-time y dataZoom (inside + slider) compartidos** — arriba FPS (eje izq, con
  markLine del target) + frame-time p90 en ms (eje der, violeta punteado); abajo
  GPU%/CPU% (eje izq 0–100) + temp °C (eje der). Los **tramos rojos**
  (`verdict.redSpans`, precalculados en el core y testeados) se sombrean como markArea
  **en ambos grids**, así el "por qué" queda alineado verticalmente con el "cuándo".
  El timeline normalizado del 020 (RAM/batería/device) sigue igual debajo.
- **Hook para el 030 (crashes/errores en el timeline)**: contrato documentado en
  `template.js` — si la sesión embebida trae `session.marks = [{ ts, label }]`, se
  pintan solas como markLines verticales sobre el grid de FPS; el 030 solo tiene que
  poblar ese array al armar la sesión, sin tocar el chart.
- **Tests (275 verdes, +31)**: `verdict.test.ts` con series sintéticas (reparto
  ponderado, spans rojos, bajón detectado como peor tramo con contexto GPU/temp, no
  solapamiento y máximo N, degradación sin jank y sin FPS, throttling
  detectado/corto/estable/sin base/sin temp/umbral exacto) **y contra el dump real del
  A15** (`parseFrameStats` del fixture: jank 0.93 % no fabrica tramos a target 30; los
  mismos ~30 FPS reales contra target 60 dan rojo 100 % coherente);
  `generateReport.test.ts` cubre veredicto embebido, target declarado (30 y 60) y
  sesión legacy sin FPS degradando sin romper. `bun test` + `typecheck` + `fmt`
  limpios; smoke sin browser generando el HTML (1.9 MB standalone) con escenario
  sintético de throttling validado por estructura.

## Pendiente / ideas futuras

- Los umbrales del throttling (42 °C / 60 s / 15 %) son a priori razonables para gama
  baja; calibrarlos con sesiones reales largas de sample cuando existan (mismo fog
  que los semáforos no-FPS del mapa).
- El tooltip del chart de correlación es por-grid (el crosshair sí está linkeado);
  unificarlo en uno solo cross-grid es cosmético y puede caer en el rediseño 031/032.
