---
id: 7
title: Prototipo del dashboard realtime con datos fake
label: wayfinder:prototype
status: closed
assignee: agent-proto
blocked-by: []
---

## Question

¿El layout acordado se siente bien con datos moviéndose? Prototipo (skill /prototype) del
dashboard con ECharts y un generador de datos fake a 1 Hz:

- Header: ficha del device (modelo, Android, RAM, GPU, SoC) + app seleccionada + estado REC.
- Fila central: donut-gauges con umbrales de color — CPU%, GPU%, FPS, temperatura, RAM.
- Torta real de composición de memoria (java/native/graphics/code/otros).
- Timeline en vivo multi-serie (CPU/RAM/temp/FPS) con ventana deslizante.
- Resumen de red (↓rx ↑tx por segundo y acumulado).
- Branding: logo sample grande, Generic presente (placeholders si el ticket de logos
  no cerró — no bloquea).

Validar con el humano: legibilidad de gauges, qué serie merece estar en la timeline por
default, dark/light. El prototipo es descartable pero define la estructura de componentes
que el UI real reusa. Linkear el prototipo como asset del ticket.

## Resolution (2026-07-16)

**Prototipo funcionando** en [`prototypes/dashboard/`](../../../prototypes/dashboard/index.html)
([screenshot](../../../prototypes/dashboard/screenshot.png)). HTML standalone, sin build step y
100% offline: abrir con `open prototypes/dashboard/index.html`. Datos fake a 1 Hz.

### Qué quedó

- `index.html` — layout completo + tema oscuro paleta Generic (`#0B0B10`/`#EB008B`/`#00E6DA`),
  fuentes Baloo 2 + Inter **vendoreadas** como woff2 (`vendor/fonts/`, @font-face con fallback
  system — cero dependencias de red).
- `vendor/echarts.min.js` — ECharts 5 bajado de jsdelivr (1 MB).
- `sim.js` — simulador de sesión de juego con **fases** (menu/loading/gameplay/combat) que
  driftean las métricas: CPU 20–70%, GPU 30–80%, FPS 40–60 con dips de jank de 1–3 s, RAM en
  serrucho (crece con el load, GC drops del 12–28% del java heap), temp 32→44° subiendo lento,
  red con baseline bajo + bursts de 250–900 KB/s. Corre en browser y en Bun (mismo archivo).
- `app.js` — wiring ECharts: 5 donut-gauges (progress ring cerrado, número grande al centro,
  color por umbral verde→amarillo→rojo; **FPS invertido**: rojo abajo de 45), torta de memoria
  (java/native/graphics/code/stack/other, actualización animada suave, PSS total al centro),
  timeline multi-serie con ventana deslizante de 120 s y toggles por leyenda, sparkline+números
  de red (↓rx ↑tx por segundo + acumulados). Chips de evento "GC"/"JANK" que flashean sobre los
  gauges de RAM/FPS cuando el simulador los emite.
- Header: logo sample **grande protagonista** (92 px, con glow magenta) + subtítulo "Android
  Profiler", ficha del device fake (SM_G973F · Android 12 API 31 · 8 GB · Adreno 640 · SD 855 ·
  1440×3040), selector de app fake (default `com.sample.oda.qa`; cambiarla resetea la sesión),
  badge **● REC** pulsante con timer mm:ss (click = pausa), logo Generic chico a la derecha.
- `smoke.js` — validación sin browser: `bun prototypes/dashboard/smoke.js` (verde, 5/5 corridas).
  Chequea rangos e invariantes del simulador en 600 ticks, sintaxis de los JS, y que todos los
  assets referenciados existan.

### Verificación

- `bun prototypes/dashboard/smoke.js` → **SMOKE PASS** (44 checks), estable en 5 corridas.
- Headless Chromium (playwright-core global + browser cacheado): carga por `file://`, corre 30 s
  reales, **0 errores de consola**, 8 canvas renderizados, timer y red actualizando. Screenshot
  capturado como `screenshot.png`.

### Decisiones de layout tomadas (a validar con feedback)

1. **Timeline normalizada a un solo eje 0–100**: CPU% crudo, FPS como %/60, RAM como %/8 GB del
   device, temp mapeada 25–50° → 0–100. El tooltip siempre muestra el valor real con unidad.
   Alternativa descartada por ahora: ejes Y múltiples (más fiel pero más ruido visual).
2. **RAM gauge escala 0–8 GB del device** (no % del heap): dice "cuánto del teléfono está usando
   la app", que es la pregunta QA. El número central va en GB.
3. **Umbrales placeholder** (CPU 55/75, GPU 65/85, FPS 45/54 invertido, temp 38/42, RAM 45%/70%
   del device) — el mapa dice que se calibran con sesiones reales, acá son solo demo visual.
4. Donut-gauges de **anillo completo** (360°) en vez de arco 270°: más compacto y el número queda
   perfectamente centrado.
5. Torta de memoria **a la izquierda** de la timeline (340 px fijos), gauges arriba como fila
   protagonista, red como footer delgado con sparkline — jerarquía: gauges > timeline > pie > red.
6. Solo dark theme (paleta Generic); light no se prototipó.

### Preguntas de feedback para el humano (pendiente — no bloquea el cierre)

1. ¿La timeline normalizada (todo 0–100, valores reales en tooltip) se entiende, o preferís ejes
   separados / unidades reales aunque haya más ruido?
2. ¿Qué series deben venir **encendidas por default** en la timeline? (hoy: las 4 — CPU/RAM/FPS/
   temp; ¿arrancar solo con CPU+FPS?)
3. ¿Los 5 gauges se leen bien de un vistazo a distancia de "segunda pantalla"? ¿Tamaño del número
   central OK? ¿Sobra o falta alguna métrica en la fila protagonista?
4. ¿El gauge de RAM en GB sobre 8 GB del device es la lectura correcta, o preferís % o MB?
5. ¿Los chips GC/JANK flasheando aportan o distraen? ¿Los querés también como marcas en la timeline?
6. ¿Hace falta light theme o dark-only está bien para v1?
7. ¿El balance de branding (sample grande + Generic chico) está bien o el logo sample pisa
   demasiado espacio útil del header?

## Human feedback applied (2026-07-17)

Feedback recibido del humano sobre el prototipo — **estas decisiones son contrato para el UI real**:

1. **Todo el texto de UI en inglés.** Aplicado: títulos, labels de gauges, leyendas, tooltips,
   footer, ficha del device, badge y botones ("Profiled app", "Memory composition", "Live
   timeline", "total …", "PAUSED", "Disposable prototype…"). `lang="en"`.
2. **GPU y FPS unificados en UN solo donut.** El donut muestra GPU% con sus umbrales de color
   verde→amarillo→rojo como los demás; el FPS va como **número pelado** debajo del GPU% dentro
   del mismo círculo, en color neutro, **sin umbrales ni colores** ("para FPS no hay menor ni
   mayor, solo mostramos la data"). Se eliminó `bandsInv` y el gauge `#gFps`. La fila central
   queda con **4 círculos: CPU, GPU·FPS, TEMP, RAM**. El chip JANK vive en la card GPU·FPS.
3. **Light mode por default.** Tema claro con los acentos de marca intactos (#EB008B primary,
   #00E6DA secondary — este último oscurecido a `#009E96` cuando es texto/línea sobre fondo claro,
   por contraste). Toggle chico light/dark en el header (default light) que reutiliza el tema
   oscuro Generic existente; al togglear, los charts ECharts se **rebuild-ean con la paleta
   nueva** (ejes, splitLines, tooltips, textos, track de los gauges) y se re-inyecta la data
   buffereada, así nada se resetea visualmente. El logo Generic (wordmark blanco) va siempre
   sobre un chip oscuro para que funcione en ambos temas.
4. **Responsive arreglado** — verificado en 1440 / 1024 / 768 / 390 px sin overflow horizontal:
   gauges en grid `auto-fit minmax(150px, 1fr)` (4 columnas en desktop, 2 en 390), header se
   apila prolijo (device card y controles pasan a fila completa bajo 820 px), la fila pie+timeline
   colapsa a 1 columna bajo 1100 px, el footer de red pasa a 2 columnas con la sparkline abajo
   bajo 700 px, `min-width: 0` en cards/grids para que ECharts no desborde, y resize de todos los
   charts en `window.resize`.
5. **Badge ● REC alineado con el selector de app**: misma fila, misma altura (38 px) y
   `align-items: flex-end` en el bloque derecho del header (verificado por bounding box:
   centros verticales idénticos).

Verificación de este pase: `bun prototypes/dashboard/smoke.js` → **SMOKE PASS** (56 checks,
incluye asserts nuevos de inglés/light-default/GPU·FPS unificado). Headless Chromium
(playwright-core): carga `file://`, 10 s corriendo, **0 errores de consola** en 1440/1024/768/390,
0 px de overflow horizontal en los 4 anchos, toggle a dark funcionando. Screenshots regenerados:
[`screenshot.png`](../../../prototypes/dashboard/screenshot.png) (1440×900, light),
[`screenshot-dark.png`](../../../prototypes/dashboard/screenshot-dark.png) (1440×900, dark),
[`screenshot-mobile.png`](../../../prototypes/dashboard/screenshot-mobile.png) (390×844).

## Human feedback round 2 (2026-07-17)

Feedback sobre el mock en el browser real (~1660 px):

1. **Torta de memoria truncaba labels** ("Java h…", "Nat…") a anchos intermedios →
   los nombres se movieron a una **leyenda scrolleable abajo** + % adentro de cada
   porción (oculto en porciones < 18°). No hay labels externos: no trunca a ningún ancho.
2. **Header quedaba en 2 líneas; debe ser 1** → `flex-wrap: nowrap` en el header,
   el device-card absorbe/encoge (sus chips wrappean adentro) y `header-right` no se
   parte; el stack por filas solo aparece ≤ 820 px.
3. **Logo Generic = solo el perro, transparente, sin chip de fondo** → se usa el ícono
   oficial full-color del sitio (72×72, ver assets/brand/README.md); la variante
   recortada del logo grande quedó descartada (ojos blancos, era para fondo oscuro).

Verificación: SMOKE PASS, 0 px de overflow y header en una línea en 1660/1440/1180/900,
0 errores de consola; screenshots light/dark/mobile regenerados.
