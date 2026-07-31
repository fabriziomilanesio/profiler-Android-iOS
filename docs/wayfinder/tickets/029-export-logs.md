---
label: wayfinder:ticket
title: Export de logs — .txt legible + .jsonl, sesión completa o filtrado
status: open
assignee:
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
