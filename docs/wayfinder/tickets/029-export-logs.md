---
label: wayfinder:ticket
title: Export de logs — .txt legible + .jsonl, sesión completa o filtrado
status: closed
assignee: claude
blocked-by: [028]
---

# 029 — Export de logs

## Question

Botón de export en el panel de logs y entrada en el menú ☰ para sesiones pasadas. ¿El
export de "lo filtrado" serializa en el cliente (lo que se ve) o pide al server con los
filtros como query?

## Contexto (grilling 2026-07-31)

- **Dos alcances**: la sesión completa, o exactamente lo visible con los filtros
  aplicados.
- **Dos formatos**: `.txt` legible (para pegar en Jira/Slack) y `.jsonl` estructurado
  (para procesar). Descarga en el browser + copia en la carpeta de reportes, como el
  reporte HTML.
- **Sesiones pasadas**: los logs persisten junto a la sesión (027), así que el panel
  "Registros de sesiones" del ☰ permite exportar logs de cualquier sesión, igual que hoy
  permite exportar el reporte.

## Entregado

- **Decisión de arquitectura (la Question): el export de "lo filtrado" viaja del
  cliente al server como entries, no como spec de filtro.** Un solo endpoint
  `POST /api/logs/export` con `{ scope: 'session'|'filtered', format: 'txt'|'jsonl',
sessionId?, entries? }`: para `filtered` el cliente manda las entries visibles
  (`LogsPanel.getFilteredEntries()`) y el server serializa, guarda copia y devuelve
  el archivo. Se descartó re-aplicar el filtro server-side con logsCore porque el
  buffer del cliente es el único que sabe exactamente qué se ve: se limpia al
  cambiar de app/device mientras el ring del server conserva líneas de la app
  anterior (limitación documentada del 028), y el dedup bootstrap↔WS también es
  del cliente — "exactamente lo visible" solo existe ahí. El peor caso (50k
  entries ≈ 12 MB) viaja por localhost: irrelevante para una tool local. El doble
  destino (descarga browser + copia en la carpeta de reportes) replica el patrón
  de `/api/report`.
- **`src/core/logs/exportLogs.ts`** (puro, 13 tests): `serializeLogsTxt` — una
  línea por entry `HH:MM:SS.mmm LEVEL/tag(pid): message` (hora local, como el
  panel), crashes marcados con prefijo `[CRASH]` (o `[ANR]` para am_anr) en CADA
  línea del bloque — greppeable al pegar en Jira/Slack; `serializeLogsJsonl` —
  las LogEntry tal cual, una por línea (mismo esquema del sink);
  `logsExportFilename` — `sample-logs-<sesión|fecha>[-filtered].<ext>`;
  `parseExportEntries` — valida/normaliza las entries del cliente (input hostil
  que termina en disco): forma de LogEntry estricta, campos desconocidos afuera.
- **Server** (`liveServer.ts`): `POST /api/logs/export` con check de origin como
  el resto de los POST. Scope `session` sin `sessionId` = sesión en curso (flush
  de lo pendiente + `LogSink.read`; sin sessionsDir cae al ring en memoria);
  con `sessionId` = sesión pasada vía `LogSink.read` (el id se valida ahí: path
  traversal ⇒ 404). Sesión sin logs ⇒ 404 `"la sesión no tiene logs"`, sin error.
  Copia best-effort en `reportsDir` + attachment con content-type según formato.
  `GET /api/sessions` ahora incluye `hasLogs` por sesión.
- **UI panel de logs**: 4 chips junto a los filtros — `⬇ filtro .txt/.jsonl`
  (serializa `getFilteredEntries()`; 0 líneas ⇒ status "sin líneas", sin request)
  y `⬇ sesión .txt/.jsonl` — con status inline, tokens de ambos temas.
  `LogsPanel.downloadExport()` es el único camino POST→blob→descarga y lo reusa
  el menú ☰.
- **UI menú ☰ / Registros de sesiones**: junto a `⬇ reporte`, botones `⬇ .txt` y
  `⬇ .jsonl` por sesión; `hasLogs: false` ⇒ deshabilitados con tooltip "Sesión
  sin logs guardados". Sin archivos nuevos en `src/ui` ⇒ manifest de
  `embeddedUi.ts` intacto.
- **Tests**: 13 de serializadores (crash multi-línea, no-ASCII, filename,
  validación) + 6 del endpoint (ambos scopes y formatos, copia en reportes,
  sesión en curso y pasada, 404 sin logs, 400 de validación, 409 filtered vacío,
  `hasLogs`). Suite completa: **322 verdes** + typecheck + fmt. Verificado
  end-to-end por curl contra el smoke (`bun scripts/smoke-selector.ts`): ambos
  scopes/formatos, `[CRASH]` marcado, copias en la carpeta de reportes, 404 de
  sesión sin logs.
- **Para el 030**: los logs de una sesión se leen con `LogSink.read` y se
  serializan con `serializeLogsTxt`/`serializeLogsJsonl` — si el reporte HTML
  quiere embeber logs, ese es el camino. Para el rediseño (031/032): los chips de
  export viven en `.logs-export` dentro de `.logs-controls`; el status inline es
  `.logs-export-status`.
