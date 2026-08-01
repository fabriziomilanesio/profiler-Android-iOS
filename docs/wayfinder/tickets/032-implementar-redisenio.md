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
