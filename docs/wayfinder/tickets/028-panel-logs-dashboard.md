---
label: wayfinder:ticket
title: Panel de logs en el dashboard — filtro por nivel, texto y fecha
status: closed
assignee: claude
blocked-by: [027]
---

# 028 — Panel de logs en el dashboard

## Question

Sección de logs en el dashboard alimentada por el stream del 027. ¿Cómo se mantiene
fluida con miles de líneas (virtualización / cap de render) sin pesar en el browser que
además dibuja los charts en vivo?

## Contexto (grilling 2026-07-31)

- El "sorteo" pedido es acá: **filtro por nivel** (Error/Warn/Info/Debug), **búsqueda de
  texto** y **filtro por fecha/hora**, orden temporal asc/desc, **pausa de auto-scroll**
  para leer mientras siguen entrando líneas.
- Los crashes/ANR resaltados visualmente (son la señal que más se busca).
- Entra como sección propia colapsable — el layout definitivo lo decide el rediseño
  (031/032), acá alcanza con que sea usable y no rompa el layout actual.
- El filtrado corre en el cliente sobre el ring buffer sincronizado; el server no
  re-manda historia por cada cambio de filtro.

## Entregado

- **Sección "Logs" colapsable** en el dashboard, debajo del Network Inspector
  (misma familia visual card/insp-\*; el layout fino es del 031/032). Colapsada
  por defecto — el header muestra contadores vivos (total, mini-badges E y W que
  se encienden rojo/amarillo) aunque esté cerrada, así no rompe el layout actual.
- **Módulos nuevos** (sin libs, sin bundler; sumados al manifest de
  `embeddedUi.ts`):
  - `src/ui/logsCore.js` — TODA la lógica pura (filtro, orden, dedup, ventana de
    render, conteos) en un módulo UMD: el browser lo carga como script clásico
    (`window.LogsCore`) y bun:test lo `require()`a tal cual — un solo origen,
    cero espejos (a diferencia del semáforo del 025, acá la lógica es grande y
    duplicarla divergiría).
  - `src/ui/logsPanel.js` — solo DOM: consume `LogsCore`, expone
    `window.LogsPanel` (`onLogs`, `bootstrap`, `clear`, `getFilteredEntries`).
  - `live.js` rutea `{type:'logs'}` → `LogsPanel.onLogs`, dispara el bootstrap
    al abrir el WS y limpia el panel al cambiar de app o device.
- **El sorteo**: chips por nivel Error (E+F) / Warn / Info / Debug+Verbose,
  búsqueda de texto case-insensitive sobre message y tag (debounce 150 ms, sin
  regex), rango desde/hasta con `datetime-local` (hasta inclusive: +59.999 s),
  orden asc/desc, y pausa de auto-scroll doble: botón ⏸ explícito Y pausa
  automática al scrollear fuera del borde vivo (borde = fondo en asc, tope en
  desc), con botón flotante "volver al vivo (N nuevas)"; volver al borde
  scrolleando reanuda solo si la pausa fue automática (patrón consola estándar).
- **Estrategia de render (decisión): CAP DE RENDER, no virtualización por
  viewport.** Máximo 1000 filas en el DOM — las más nuevas que pasan el filtro —
  con indicador "N más antiguas pasan el filtro (refiná texto/fecha)". Sin math
  de scroll frágil ni libs; leer más atrás = refinar filtro, que es el flujo
  real. Camino caliente O(batch): los batches WS (250 ms) se appendean
  incremental al DOM con trim del extremo viejo; el recompute O(buffer) solo
  corre al cambiar filtro/orden, reanudar o abrir el panel. Con el panel
  colapsado o en pausa no se toca el DOM de la lista. Ring del cliente: 50k
  entradas (espejo del server, ~12 MB peor caso).
- **Crashes/ANR**: filas `isCrash` con fondo/borde izquierdo rojo y badge
  CRASH/ANR solo en la primera línea de cada bloque (líneas isCrash consecutivas
  del mismo pid = un badge, no 40 por stacktrace). Colores por nivel: E/F rojo,
  W amarillo, resto neutro — tokens `--bad`/`--warn` ⇒ correcto en ambos temas.
- **Contadores**: total del buffer, "M en filtro" (con el panel abierto) y
  mini-badges E/W siempre visibles en el header.
- **Bootstrap + dedup**: al (re)conectar el WS, `GET /api/logs?n=2000` y merge
  contra lo ya llegado. **Clave de dedup: `ts|pid|tid|level|tag|message`.**
  Limitación documentada: dos líneas idénticas del mismo thread en el mismo ms
  colapsan en una (aceptable: duplicado exacto sin señal). Segunda limitación:
  el ring del server no se limpia al cambiar de app, así que un re-bootstrap
  tras reconectar puede traer líneas de la app anterior (best-effort).
- **Smoke**: `scripts/smoke-selector.ts` ahora emite logcat sintético por el
  fake transport (app stream 1 línea/400 ms con errores y stack multi-línea;
  crash FATAL + am_anr a los ~8 s y cada 45 s) — panel visible en vivo sin
  device. Verificado por curl: `/api/logs` entrega los 6 niveles + 6 entradas
  isCrash adjudicadas; assets nuevos servidos 200.
- **Tests**: `src/ui/logsCore.test.js` (18 casos: chips, texto, rango, cap
  sobre lo filtrado, orden, badges con borde de cap, conteos, dedup/merge
  estable, appendCapped). Suite completa: **293 verdes** + typecheck + fmt.
  Server intacto (cero cambios en `src/server/`, salvo el manifest).
- **Para el 029 (export)**: `LogsPanel.getFilteredEntries()` devuelve TODAS las
  entries que pasan el filtro actual (sin cap de render), en el orden visible.
