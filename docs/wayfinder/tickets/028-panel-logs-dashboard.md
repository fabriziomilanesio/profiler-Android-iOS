---
label: wayfinder:ticket
title: Panel de logs en el dashboard — filtro por nivel, texto y fecha
status: open
assignee:
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
