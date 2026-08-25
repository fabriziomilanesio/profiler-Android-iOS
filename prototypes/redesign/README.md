# Prototipo del rediseño del dashboard (ticket 031)

HTML estático standalone y 100% offline: `open prototypes/redesign/index.html` (doble
click también sirve). Datos simulados a 1 Hz (`sim.js`) con una historia guionada para
ver todo en acción: **caída de FPS a ~26** (semáforo rojo + bandas rojas en la timeline,
t≈40–58 de cada ciclo) y un **crash sintético** (bloque FATAL en logs, marca CRASH en la
timeline, badge "waiting for process…" y relanzamiento, t≈80; el ciclo se repite cada
150 s). Arranca con 75 s de historia pre-cargada para que nada esté vacío.

> **Nota:** `app.js` quedó congelado como referencia del 031; los fixes post-032 viven
> solo en `src/ui`.

Verificación: `bun prototypes/redesign/smoke.js` (SMOKE PASS, ~4k checks, 5 corridas) +
headless Chromium: **0 errores de consola, 0 px de overflow horizontal** en
1440/1180/900/700/390. Screenshots: `screenshot.png` (dark), `screenshot-light.png`,
`screenshot-mobile.png` (390).

## Dirección (del grilling — no re-decidido acá)

Evolución de la identidad actual, no partir de cero: branding Sample/Generic,
Baloo 2 + Inter, **dark theme protagonista** (default) con light consistente, look de
herramienta pro estilo Perfetto/Grafana — sin gamer-neon saturado.

## Decisiones de diseño de este prototipo

### 1. Tiles con números grandes en vez de donut-gauges

La fila de 5 donuts muere. Lo clave se lee **sin interpretar aros**:

- **FPS hero tile**: número de 84 px coloreado por el semáforo del target (025), pill
  de estado con palabra + punto (`ON TARGET` / `BELOW TARGET` / `WAY BELOW TARGET` —
  color nunca solo, siempre con texto), chip `target N`, y debajo jank% (hereda el
  semáforo) + p90/p99 de frame-time (024) como sub-stats de primera clase.
- **GPU tile** al lado del hero: número grande + barra fina coloreada por umbral.
- CPU / Temp / Battery pasan a tiles del grupo **System** (número + barra por umbral;
  CPU conserva el `≈ % of one core` y la barra fina del device; Battery su chip
  ⚡ CHARGING).
- RAM vive en el grupo **Memory**: PSS y RSS como números + dos barras finas
  (app-de-8GB y device-usado) que reemplazan los dos anillos del gauge.

### 2. Layout por temas con jerarquía (rails estilo Grafana)

Secciones rotuladas con rail (tick degradé magenta→teal + hairline):
**Performance** (protagonista, arriba: hero FPS + GPU + timeline) → **Memory & System**
→ **Network** (+ inspector) → **App logs** (sección propia de primera clase, abierta
por default). Header compacto en una línea: logo Sample reducido (48 px vs 84),
ficha de device con chips (Hz en teal), veredicto vivo, selector de app + badge de
estado, LIVE + timer, toggle de tema, ☰, perro Generic.

### 3. Mini-veredicto vivo en el header (decidido: SÍ)

Pill `PERF GOOD / WATCH / POOR` — espejo del esquema del reporte (026):
estado = `fpsStatus(FPS promedio de los últimos 60 s)`; subtítulo = `% de ticks en
verde · 60 s`. Los crashes de la sesión agregan un chip rojo (`N crashes`). Con < 5
ticks con dato: `WARMING UP`, nunca rojo. Cualquiera del equipo lee el estado general
sin mirar un solo chart.

### 4. Las 3 preguntas abiertas del 007 — resueltas

1. **Eje de la timeline**: se abandona la normalización única 0–100. La timeline de
   perf usa **dos carriles apilados con eje X y crosshair compartidos, unidades
   reales por carril** (arriba FPS en fps con markline del target + bandas rojas de
   tramos bajo target + marcas CRASH; abajo GPU%/CPU% en 0–100) — el mismo patrón del
   chart de correlación del reporte (026), así dashboard y reporte cuentan la misma
   historia. Nada de dual-axis en un grid (regla dataviz). RAM/temp/red ya no compiten
   en esa timeline: cada una grafica en su card temática con su unidad real (trend de
   PSS en MB con auto-escala, barras de temp/batería, sparkline de red).
2. **Series default**: FPS + GPU% + CPU% encendidas; `CPU device %` apagada (se
   prende por leyenda). Temp/RAM/batería salieron de la timeline (punto 1), que era
   la fuente del ruido de 7 series.
3. **Chips GC/JANK**: los chips que flashean quedan **descartados** (avisan sin
   cuantificar y distraen). Con datos reales del 024, el jank es un **badge numérico
   permanente con semáforo** en el hero de FPS, los tramos malos son **bandas rojas
   persistentes** en la timeline y los crashes **marcas CRASH** verticales (patrón
   `session.marks` del 030). El GC es un **punto ámbar sobre el trend de PSS**
   (tooltip con el valor) — queda la marca temporal sin flash.

### 5. Sistema de color validado (skill dataviz)

Los acentos neón de marca (`#EB008B`/`#00E6DA`) quedan como **chrome de UI** (header,
badges, rail ticks, focos). Las **series de charts** usan pasos más profundos validados
con `validate_palette.js` (6 checks: banda de luminosidad, croma, separación CVD,
piso normal-vision, contraste — PASS en dark `#15151D` y light `#FFFFFF`):

- dark: FPS `#00A89E` · GPU `#EB008B` · CPU `#8B6BE8` · ámbar `#C77F00`
- light: FPS `#009E96` · GPU `#EB008B` · CPU `#7C5CE0` · ámbar `#B8860B`
- Donut de memoria en orden cromático validado (magenta·violeta·teal·ámbar) +
  Stack/Other como neutrales; bordes de 2 px color card como separador.
- Los colores de **status** (ok/warn/bad) quedan reservados a semáforos; nunca se usan
  como color de serie, y nunca van solos (siempre palabra/ícono al lado).

### 6. Otros

- **Target FPS del prototipo = 60** (editable en ☰ Settings, aplica en vivo y
  re-evalúa buffers) para que el sim ejercite los 3 estados del semáforo. El default
  real de la app sigue siendo 30 (025) — no es una decisión de producto.
- Ventana de la timeline: **180 s** (vs 120) para que quepa un ciclo completo de la
  historia; a decidir con feedback si el real la adopta.
- Panel de logs completo (chips por nivel, búsqueda, rango de fechas, orden, pausa,
  export .txt/.jsonl funcionales por blob, cap de render 500, crash resaltado con
  badge) — abierto por default en el prototipo; en el real puede arrancar colapsado
  con los contadores vivos como hoy.
- Fondo con glows radiales de marca + micro-grilla de puntos (textura de instrumento,
  casi imperceptible); tema claro con los mismos tokens.

## Alternativas descartadas

- **Donut-gauges refinados** (mantener los 5 aros): el grilling pidió leer sin
  interpretar gauges; el aro además desperdicia el espacio del centro y esconde el
  frame-time.
- **Timeline única normalizada 0–100** (la del 007/actual): mezcla unidades, el
  tooltip es la única verdad y el jank visual de la RAM re-normalizada confunde.
- **Ejes Y duales en un solo grid**: prohibido por la regla de un-eje del método
  dataviz; los carriles apilados dan la misma correlación sin mentir con dos escalas.
- **Chips GC/JANK flasheando** (007): reemplazados por datos persistentes (arriba).
- **Verdict como card propia en el body**: pisa espacio del layout y duplica lo que el
  header puede decir en una pill siempre visible.
- **Light como default** (estado actual post-007): el grilling del 031 fijó dark
  protagonista; light queda a un toggle (header y ☰) y persiste igual que hoy.

## Contrato para el 032

`index.html` (layout + tokens CSS de ambos temas) y `app.js` (estructura de charts y
tiles) son la spec. El 032 los implementa sobre `src/ui/` reusando la infraestructura
real (render.js/live.js/logsCore/logsPanel): mismos ids/roles de componentes donde sea
razonable, `LogsCore` intacto, semáforo y veredicto espejando `threshold.ts`/`verdict.ts`.
El feedback humano sobre este prototipo (HITL diferido a la mañana por pedido
explícito) itera sobre esta base antes o durante el 032.
