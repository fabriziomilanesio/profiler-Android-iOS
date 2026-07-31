---
label: wayfinder:ticket
title: Errores y crashes marcados sobre el timeline del reporte HTML
status: closed
assignee: claude
blocked-by: [026, 027]
---

# 030 — Logs dentro del reporte HTML

## Question

El reporte de perf suma la dimensión de logs: errores/warnings de la ventana exportada
listados, y crashes/errores **marcados sobre el timeline de FPS** (un crash = marca roja
sobre la curva, con tooltip). ¿Cuánto log se embebe en el HTML standalone sin inflarlo
(hoy ~2.5 MB) — solo Error/Warn con cap, o resumen + conteos?

## Contexto (grilling 2026-07-31)

- Es la pieza que une los dos frentes: "el juego se cayó acá" visible en la misma vista
  que "y el GPU/temp estaban así".
- Respeta el recorte por tramo continuo de la app actual que ya hace el reporte.
- Depende de la correlación del 026 (timeline nuevo) y de la persistencia de logs
  del 027.

## Entregado

- **Core puro `src/core/logs/reportLogs.ts`** (23 tests): `filterLogsToWindow`,
  `countByLevel`, `buildReportLogs`, `crashBlocks`, `buildLogMarks`; umbrales
  exportados como constantes (`REPORT_LOG_CAP`, `CRASH_END_GRACE_MS`,
  `CRASH_BLOCK_GAP_MS`, `BURST_*`, `MAX_MARKS`, `MARK_LABEL_MAX`).
- **Presupuesto de embebido (la Question — decisión)**: se embeben SOLO W/E/F +
  todos los `isCrash`, con **cap de 500 entradas no-crash** (~125 KB a ~250 B/entry
  sobre un HTML de ~1.9 MB); ante overflow sobreviven las **más recientes** (el
  final de la ventana es donde la sesión murió) y `truncated` dice cuántas quedaron
  fuera. Los **bloques de crash van completos siempre** (stacktrace entero, sin cap:
  son el evento que importa). El resto de los niveles queda como **conteo por nivel**
  (`totalByLevel` — "además hubo N verbose/debug/info"). Smoke real: 1.9 MB, igual
  que antes del 030.
- **Clustering de marcas (decisión)**: una marca por **bloque de crash** (entradas
  `isCrash` con gap ≤ 2 s = el mismo stacktrace), label `CRASH: <primer mensaje>`
  (o `ANR: <reason>` parseado del formato de `am_anr`) truncado a 40 chars. Los
  **errores E/F sueltos NO marcan** (ruido: quedan en la lista); una **ráfaga de
  ≥ 5 errores con gaps ≤ 10 s** colapsa en una única marca `"N errores"`. Máximo
  **20 marcas** (crashes con prioridad; ráfagas por tamaño). Las arma
  `buildLogMarks` ⇒ `session.marks = [{ ts, label }]` y el hook del 026 las pinta
  solo (cero cambios al chart).
- **Recorte (decisión)**: el rango es exactamente la ventana exportada
  `[primer sample, último sample]`, con una **gracia de 10 s al final SOLO para
  crashes**: el crash que mata la app llega por el crash stream DESPUÉS del último
  sample (la persistencia pausa con la muerte); su marca se clampea al borde del
  chart para no caer fuera del eje.
- **Contrato**: `ReportSession.marks: ReportMark[]` + `ReportSession.logs:
ReportLogs | null`; `BuildReportOptions.logEntries` (el recorte lo hace
  `buildReportSession` con los ts de los samples). `handleReport` lee los logs por
  el mismo camino que el export del 029: `LogSink.read` del NDJSON hermano (flush
  previo para la sesión en curso; sin `sessionsDir` cae al ring en memoria);
  `?session=<id>` lee la sesión pasada. Sesión sin logs ⇒ `logs: null`, `marks: []`
  ⇒ el reporte sale exactamente como hoy, sección oculta — nunca rompe.
- **Sección "Logs — errors & warnings" del template** (entre correlación y
  memory/timeline): lista monoespaciada con timestamp `HH:MM:SS.mmm`, nivel
  coloreado (W ámbar, E/F rojo), tag y mensaje; los bloques de crash son
  `<details>` colapsables (borde rojo, badge CRASH/ANR, primera línea + "+N
  líneas") con el stacktrace completo dentro; subtítulo con conteos (warns ·
  errors · crash blocks) y footer con truncadas por presupuesto + niveles no
  embebidos. Todo con las CSS vars del template ⇒ ambos temas gratis; mensajes
  escapados (input hostil del device).
- **Tests (342 verdes, +20)**: `reportLogs.test.ts` (recorte estricto + gracia
  solo-crash, conteos, cap con crashes intactos y truncated, bloques multi-línea,
  labels CRASH/ANR/truncado, clamp al borde, errores sueltos sin marca, ráfaga
  única, líneas E de crash excluidas de ráfagas, cap de 20 marcas con prioridad) y
  `generateReport.test.ts` (reporte con crashes ⇒ marks + sección embebidas; sin
  logs ⇒ degrada con `"logs":null`/`"marks":[]`; cap respetado; rango respetado).
  `bun test` + `typecheck` + `fmt` limpios. Verificado end-to-end contra el smoke
  (`bun scripts/smoke-selector.ts 4599`, crashes sintéticos): el HTML real trae
  `marks` = crash + ráfaga "6 errores", sección con 18 entries (6 de crash),
  conteos por nivel y todos los ts dentro de la ventana.

## Pendiente / ideas futuras

- El rediseño (031/032) puede querer linkear cada marca del chart con su entrada
  en la sección (anchor/scroll); los datos ya alcanzan (`ts` es la clave común).
- `CRASH_BLOCK_GAP_MS` (2 s) y la ráfaga (5/10 s) son a priori razonables;
  calibrar con crashes reales de evermore cuando existan sesiones largas.
