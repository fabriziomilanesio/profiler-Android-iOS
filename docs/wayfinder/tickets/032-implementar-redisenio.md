---
label: wayfinder:ticket
title: Implementar el rediseño en src/ui (y coherencia con el reporte)
status: closed
assignee: claude
blocked-by: [031]
---

# 032 — Implementación del rediseño

## Question

Llevar el prototipo aprobado del 031 a `src/ui/` (y ajustar el reporte HTML para que
hable el mismo lenguaje visual). ¿Migración en un paso o por secciones, manteniendo el
dashboard usable en cada commit?

## Contexto

- El UI embebido va en el binario (`src/server/embeddedUi.ts` — todo asset nuevo se suma
  al manifest o el standalone lo sirve 404).
- Tema claro/oscuro persistido debe seguir funcionando.
- Verificación visual con el flujo de evidencia del workspace (eyes + smoke-selector
  `bun scripts/smoke-selector.ts` para probar sin device).

## Entregado

**Migración en un paso** (respuesta a la Question: el rediseño toca layout + charts +
tema a la vez — por secciones habría dejado commits intermedios con dos lenguajes
visuales conviviendo; el dashboard quedó 100% funcional al final, verificado con el
smoke). El prototipo del 031 es ahora el dashboard real de `src/ui/`.

**Qué cambió vs el dashboard viejo:**

- `index.html` reescrito con el layout del contrato: secciones por tema con rails
  (Performance → Memory & System → Network → App logs), header compacto de una línea
  (logo 48 px), **dark default** (tokens de ambos temas del prototipo; light a un
  toggle nuevo ☀️ en el header, además del switch de ☰ — ambos persisten). El default
  de `theme` en `appStore.ts` pasó de `light` a `dark` (test actualizado). Textos de
  la UI unificados en inglés (decisión del 007 que el dashboard había perdido).
- `render.js` reescrito (misma API pública + `noteCrash`/`noteGc`/`setAppRunning`):
  mueren los 5 donut-gauges; FPS hero de 84 px con semáforo del 025 + pill en
  palabras + chip target + jank/p90/p99 (024); tiles GPU/CPU/Temp/Battery con barras
  por umbral; timeline de **dos carriles con unidades reales** (FPS con markline del
  target, bandas rojas, marcas CRASH; GPU/CPU abajo; `CPU device %` off por leyenda;
  ventana 180 s, techo del carril FPS adaptativo al target/datos); memoria como
  donut con KPIs PSS/RSS, barras app/device y trend de PSS con puntos ámbar de GC;
  paleta de series validada del prototipo (dataviz). **Mini-veredicto vivo** en el
  header: `fpsStatus(avg FPS 60 s)` + % de ticks en verde (espejo del esquema del
  026), `WARMING UP` con < 5 ticks, chip rojo de crashes.
- `live.js`: detecta en el stream de logs el inicio de bloques de crash (→ marca
  CRASH + chip del veredicto) y líneas de GC del ART (→ punto ámbar); toggle de tema
  del header; estado app-running al hero ("app not running" vs "no data").
- `scripts/smoke-selector.ts`: ahora emite **métricas sintéticas guionadas** (los
  parsers reales las consumen tal cual — timestats con histograma, meminfo, /proc,
  gpu_busy, thermal, battery, net) con ciclo de 150 s: FPS ~32/target 30, caída a
  ~11 FPS (rojo), crash, GC. Antes todo daba N/A y el smoke no ejercitaba nada.

**Qué quedó igual (cero regresiones):** selectores de device/app contra
`/api/devices`/`/api/packages` con badges esperando/launched, ☰ completo (export de
reportes, registros de sesiones con export de logs, configuración con target
FPS/intervalo/carpeta/tema aplicando en caliente), card de red + inspector toggle,
panel de logs completo (`logsCore.js` UMD **intacto**, `logsPanel.js` solo textos),
espejo guardado de `fpsStatusOf` (mirrors.test.ts pasa sin cambios), consumo de
`sample.frame`/`config.fpsTarget`/mensajes logs/flows/status igual que antes,
manifest de `embeddedUi.ts` sin cambios (mismos archivos). Coherencia con el reporte:
mismo lenguaje del 026 (dos carriles, bandas, semáforo) — el HTML del reporte ya lo
hablaba, no necesitó cambios.

**Verificación:** `bun test` 342 pass · `tsc --noEmit` limpio · prettier limpio.
Evidencia visual en `.logs/evidence/2026-07-31/032-redesign/` (`dark-1440.png`,
`light-1440.png`, `dark-390.png` + `evidence-report.json`): 0 errores de consola,
0 px de overflow horizontal en los tres, veredicto/crash-chip/hero funcionando con
datos del smoke; subagente **eyes: PASS en los tres** contra
`prototypes/redesign/screenshot*.png`.

**Pendiente (fuera de alcance acá):** el feedback humano HITL sobre el rediseño quedó
diferido a la mañana (override overnight del 031) — itera sobre esta implementación.

## Iteración de feedback (2026-08-01)

Feedback HITL del usuario sobre el rediseño: **"me sacaste los pie charts de
temperatura y eso, no deberías haberlos sacado"** — pedía de vuelta los gauges
circulares del dashboard viejo.

**Restaurado:** los donut-gauges circulares ECharts para **GPU, CPU, Temp y
Battery** (lenguaje visual del dashboard pre-rediseño: aro de progreso con el
número grande al centro, coloreado por umbral) DENTRO del layout nuevo por
secciones, reemplazando los tiles planos número+barra de esos cuatro. El gauge
de CPU recupera además el anillo interior tenue con el CPU total del device.
Colores por umbral con los mismos tokens ok/warn/bad de ambos temas (batería con
umbrales inversos); sin dato ⇒ aro en track + "—". `resetSeries` limpia también
los gauges (extensión del fix de eec564e), y el rebuild por cambio de tema los
incluye. Sin libs nuevas ni archivos nuevos (mismo manifest de `embeddedUi.ts`).

**Se mantiene todo lo demás del rediseño:** FPS hero con semáforo/pill/target/
jank-p90-p99, mini-veredicto del header, timeline de dos carriles, panel de
memoria (donut PSS + KPIs + trend con GC), network, panel de logs, dark default
y los fixes de eec564e (resetSeries completo, deviceRamMb null-safe, redSpans
con padding, scanLogSignals por gap).

**Verificación:** `bun test` 344 pass · `tsc --noEmit` limpio · prettier limpio ·
mirrors.test.ts pasa sin cambios. Evidencia visual contra el **dashboard real**
en :4517 (Galaxy A15 físico con el juego corriendo) en
`.logs/evidence/2026-08-01/032-gauges-feedback/` (`dark-1440.png`,
`light-1440.png` + `evidence-report.json`): 0 errores de consola, 0 px de
overflow, los 4 gauges con canvas renderizado; subagente **eyes: PASS 10/10 en
ambos temas** (gauges presentes, centrados, legibles, umbrales coherentes,
layout intacto).

### Tanda 2 (2026-08-01)

Segunda tanda de feedback HITL, 4 pedidos:

1. **"Memoria es muy importante, porque es algo que medimos"** — memoria con
   protagonismo: donut de composición más grande (270×248 px) y KPIs PSS/RSS a
   34 px en la card, y **la historia de RAM vuelve al timeline principal**:
   serie nueva `PSS MB` (azul `--s-mem`, agregado a ambas paletas) en el carril
   de FPS contra un **eje derecho en MB** (`scale:true` + `minInterval:1` — la
   variación es lo que importa, no la distancia a 0), encendida por default en
   la leyenda. El trend chico de la card queda (detalle con puntos de GC).
2. **"La temperatura me la sacaste"** — serie `Temp °C` (ámbar) en el **carril
   inferior contra un eje derecho en °C**, copiando el patrón del chart de
   correlación del reporte (026). Los ejes derechos van SIN `name` ("MB"/"°C"):
   chocaban con la leyenda de 6 items (lo detectó eyes); la unidad la lleva el
   nombre de la serie en la leyenda y el tooltip (formatter con unidades reales
   por serie, mismo patrón del reporte).
3. **Aviso del inspector** — banda `#inspWarn` de ancho completo en la card de
   red, visible mientras el inspector está ON (la maneja `setInspectorUi`, así
   también aparece si arrancó prendido): "⚠️ **The phone loses internet if
   unplugged while the inspector is ON.** Turn the inspector off before
   disconnecting the USB cable." + remedio en chico
   (`adb shell settings delete global http_proxy` como code-chip).
4. **Switch de tema duplicado eliminado** — el ☰ ya no tiene el row "Dark
   mode": queda SOLO el toggle ☀️ del header (aplica y persiste vía
   `/api/config` igual que antes). Limpieza completa: markup + CSS `.switch`
   muertos fuera, `cfgTheme` fuera del form/patch de Configuración y de
   `applyTheme` (sin listeners muertos).

**Fix extra encontrado por la verificación:** los charts solo se redimensionaban
con `resize` de ventana; cuando los KPIs de red se ensanchan con datos reales el
`netSpark` conservaba el ancho del init y desbordaba la card (275 px de overflow
horizontal medidos). Ahora un `ResizeObserver` sobre los contenedores de charts
dispara `chart.resize()`.

**Verificación:** `bun test` 344 pass · `tsc --noEmit` limpio · prettier limpio ·
mirrors.test.ts intacto (fpsStatusOf/CRASH_BLOCK_GAP_MS sin cambios). El Galaxy
A15 estaba desenchufado durante esta tanda (adb sin devices), así que la
evidencia con datos usa el smoke guionado (`bun scripts/smoke-selector.ts 4899`,
parsers reales) + un shot del dashboard real en :4517 (renderiza la UI nueva,
sin datos por no haber device). Evidencia en
`.logs/evidence/2026-08-01/032-feedback-tanda2/` con `evidence-report.json`:
0 errores de consola y 0 px de overflow en todos los checkpoints; **eyes: PASS
en los 6 checkpoints** (cp1 mem+PSS, cp2 temp — FAIL intermedio por el choque
name-de-eje/leyenda, corregido y re-verificado PASS —, cp3 aviso inspector
10/10, cp4 settings sin switch, final light 1440 y mobile 390).

### Tanda 3 — pasada de alineación + drawer + Motion (2026-08-01)

Auditoría visual (eyes sobre screenshots reales) + captura del usuario con la
sección Memory & System rota. **Pasada de alineación completa** (los 8 hallazgos
de la auditoría + 5 de la captura, todos CORREGIDO por eyes en 2 iteraciones):
fila Memory/System pareja sin aire muerto (cards flex column, gauges de System a
190 px, subs ancladas abajo, centro del donut al 45% ≈ centro de los aros);
tiles de System columnar auto-contenidos (título/aro/número/2 sub-líneas
centradas con baseline común — Battery suma `draw −XXX mA` real); números
concéntricos en los 4 gauges (chunk fantasma que balancea la unidad + offset
óptico +3 px con valor); FPS hero centrado H+V (`.fps-hero` flex); KPIs PSS/RSS
con clase común y baseline alineada; leyenda del timeline a `right:10` (margen
derecho parejo); ritmo de secciones unificado (rail 10 px + padding top 14 en
todas las cards); RX/TX sin flecha en el valor; donut sin datos = aro track +
"—" (sin seis "0%") y leyenda plana sin paginación "1/2"; `.net-na` a ancho
completo (estiraba la col de KPIs a ~435 px).

**Además, tres cambios pedidos en la misma pasada:**

1. **Tema revertido al ☰** (deshace el punto 4 de la tanda 2): fuera el toggle
   ☀️ del header; vuelve el switch "Dark mode" en Settings (markup/CSS/listener
   de `cfgTheme` restaurados de `6483d2c~1`), aplica en vivo y persiste vía
   `/api/config` (verificado contra el server).
2. **☰ como side drawer**: panel lateral fijo a la derecha, full-height
   (min(400px, 100vw−24) / full-width ≤480px), con backdrop que cierra al click
   y con Escape; mismo contenido (Export / Session records / Settings). Slide-in
   spring + fade con Motion.
3. **Modo espera congelado**: el server emite samples all-null sin device — ahora
   `render()` los descarta (`sampleHasData`), así ni el timer LIVE ni el timeline
   ni el verdict se mueven sin device/app (timer nuevo: contador acumulado
   sample-driven, congelado a los 5 s sin samples, sin saltos al reconectar el
   WS; "app died" con métricas de device vivas sigue avanzando — el dato decide).
   Verificado: 00:00 fijo y 0 puntos en :4517; avanza normal con el smoke.

**Lib nueva: `motion` 12.43.0** (motion.dev, vanilla — NO framer-motion/React),
vendoreada en `src/ui/vendor/motion.min.js` (UMD → `window.Motion`) y sumada al
manifest de `embeddedUi.ts`; registrada en `docs/references/libs.md` (Context7
MCP no estaba cableado en la sesión — se usó npm + docs oficiales). Uso con buen
gusto y solo en cambios de estado: drawer, popovers de device/app, pulso del
hero al cambiar el semáforo, chips CHARGING/crash, botón "back to live" de
logs. Guardas: sin `window.Motion` o con `prefers-reduced-motion` todo funciona
sin animar; nada anima por tick ni toca los charts de ECharts.

**Verificación:** `bun test` 344 pass · `tsc --noEmit` limpio · prettier limpio ·
mirrors.test.ts intacto. Evidencia (5 checkpoints + probes de comportamiento:
drawer Escape/backdrop, tema en vivo, timer congelado/avanzando) en
`.logs/evidence/2026-08-01/032-alineacion/` con `evidence-report.json`; **eyes:
todos los puntos A–P en PASS, sin regresiones nuevas** (iteración 2).
