---
label: wayfinder:ticket
title: Prototipo del rediseño del dashboard (evolución de la identidad actual)
status: closed
assignee: claude
blocked-by: [026, 029, 030]
---

# 031 — Prototipo del rediseño visual

## Question

Prototipo HTML estático (como el 007) del dashboard rediseñado, con **todas las piezas
nuevas ya existiendo** (frame-time/jank, semáforos, panel de logs, veredicto). HITL: se
itera con feedback humano hasta acordar el diseño; recién entonces se implementa (032).

## Contexto (grilling 2026-07-31)

- **Dirección decidida: evolucionar la identidad actual** (branding Evermore/Odaclick,
  dark theme, paleta `#EB008B`/`#00E6DA`, Baloo 2 + Inter) — no partir de cero. Look de
  herramienta pro (perfetto/grafana bien hecho).
- **Legible de un vistazo**: semáforos integrados, números grandes, menos ruido — que
  cualquiera del equipo lea el estado sin interpretar gauges.
- **Layout con jerarquía**: perf (FPS/frame-time, GPU) protagonista, logs como sección
  propia, cards agrupadas por tema.
- Retomar las 3 preguntas abiertas del prototipo 007 (eje del timeline, series default,
  chips GC/JANK) — ahora hay datos reales para decidirlas.
- Consultar el skill `frontend-design` al armarlo.

## Entregado

**Prototipo funcionando** en [`prototypes/redesign/`](../../../prototypes/redesign/index.html)
(abrir con doble click, offline; sim 1 Hz con historia guionada: caída de FPS a ~26 →
semáforo rojo + bandas rojas, y crash sintético → bloque FATAL en logs, marca CRASH en
la timeline, badge "waiting for process…" y relanzamiento; ciclo cada 150 s). Decisiones
completas y alternativas descartadas en su [README](../../../prototypes/redesign/README.md).

Decisiones clave (skills `frontend-design` + `dataviz` aplicados):

- **Tiles con números grandes en vez de donut-gauges**: FPS hero de 84 px coloreado por
  el semáforo del 025 con pill de estado en palabras (color nunca solo), chip del target,
  y jank%/p90/p99 (024) como sub-stats de primera clase; GPU al lado; CPU/Temp/Battery
  como tiles del grupo System (número + barra por umbral); RAM como números + barras
  app/device en el grupo Memory.
- **Layout por temas con rails**: Performance (protagonista) → Memory & System →
  Network → App logs (sección de primera clase, abierta en el prototipo). Header
  compacto en una línea con logo reducido (48 px).
- **Mini-veredicto vivo en el header (decidido: SÍ)**: pill PERF GOOD/WATCH/POOR,
  espejo del esquema del reporte 026 (`fpsStatus(avg FPS 60 s)` + % de ticks en verde);
  crashes de la sesión suman chip rojo; < 5 ticks con dato ⇒ WARMING UP.
- **Las 3 preguntas del 007**: (1) eje de la timeline → se abandona el 0–100 único;
  **dos carriles apilados con X/crosshair compartidos y unidades reales** (FPS con
  markline del target, bandas rojas y marcas CRASH; GPU%/CPU% abajo) — mismo patrón que
  la correlación del reporte 026; RAM/temp/red se van a sus cards temáticas con unidad
  real. (2) series default → **FPS + GPU% + CPU% on, CPU device % off** (leyenda).
  (3) chips GC/JANK → **flashes descartados**; jank = badge numérico permanente con
  semáforo en el hero, tramos malos = bandas rojas, crashes = marcas CRASH (marks del
  030), GC = punto ámbar sobre el trend de PSS.
- **Color validado (dataviz)**: neón de marca solo como chrome de UI; series con pasos
  profundos que pasan los 6 checks del validador en dark y light (FPS `#00A89E`/`#009E96`,
  GPU `#EB008B`, CPU `#8B6BE8`/`#7C5CE0`, ámbar `#C77F00`/`#B8860B`; donut en orden
  cromático validado + neutrales); status ok/warn/bad reservados a semáforos.
- **Dark default** con light consistente a un toggle (header y ☰). Target del prototipo
  = 60 (solo para ejercitar el semáforo; el default real sigue en 30). Ventana 180 s.
- Cobertura 1:1 del dashboard actual: selectores de device/app con popovers y badges de
  estado, ☰ (export/registros/configuración con target FPS aplicando en vivo), red +
  inspector (flows fake al prenderlo), panel de logs completo (filtros, rango, orden,
  pausa, export .txt/.jsonl funcionales), LIVE + timer, chip ⚡ CHARGING, chip de Hz.

Verificación: `bun prototypes/redesign/smoke.js` → SMOKE PASS (~4k checks, 5 corridas);
headless Chromium por `file://`: **0 errores de consola y 0 px de overflow** en
1440/1180/900/700/390; screenshots (`screenshot.png` dark, `screenshot-light.png`,
`screenshot-mobile.png`) revisados por el subagente eyes: PASS en los tres.

**HITL diferido**: el ciclo de feedback humano en vivo quedó explícitamente pospuesto a
la mañana por pedido del usuario (override overnight); el feedback itera sobre este
prototipo antes/durante el 032.
