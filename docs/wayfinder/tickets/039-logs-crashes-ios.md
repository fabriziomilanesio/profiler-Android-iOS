---
label: wayfinder:ticket
title: Logs y crashes en iOS — syslog + crashreportcopymobile
status: closed
assignee: claude
blocked-by: [038]
---

# 039 — Logs y crashes iOS

## Question

Llenar el panel de logs y las marcas de crash del reporte con datos de iOS, reusando
todo lo que ya existe del lado Android.

## Contexto (grilling 2026-08-10)

- El esquema `LogEntry` del ticket 027 nació genérico a propósito (`source: 'logcat' |
'game'`). Acá gana un tercer origen iOS, y **todo lo de arriba se reusa sin tocar**:
  ring de 50k (027), panel con filtros por nivel/texto/fecha (028), export .txt/.jsonl
  (029) y marcas de crash sobre el timeline del reporte (030).
- Fuentes: `syslog` para los logs de la app (filtrado por proceso), y
  `crashreportcopymobile` para los crashes. **Los crash reports de iOS son bastante más
  ricos que los tombstones de Android** — hay que decidir cuánto se muestra en el panel
  y cuánto se guarda como adjunto.
- ~~Diferencia de modelo a resolver: en iOS el crash report aparece como archivo, después
  del hecho.~~ **Descartado por el research del 044**: existe `pymobiledevice3 crash watch`,
  un stream de crashes en vivo. El modelo del 027 (crash stream separado, adjudicado por
  pid/package) se traslada casi tal cual, y la marca sobre el timeline del reporte funciona
  igual que en Android. `crash pull`/`crash parse-latest` quedan para el detalle completo
  del reporte, que en iOS es bastante más rico que un tombstone.
- Comandos confirmados: `syslog live --process-name <app>` (con `--match` y
  `--match-insensitive` para filtrar), `crash watch`, `crash ls`, `crash pull <dir>`,
  `crash parse-latest`. Todos son **lockdown, no DTX** — no dependen del túnel ni del DDI,
  así que este ticket puede avanzar aunque el camino DTX del 038 se complique.
- Mapeo de niveles: los niveles de `os_log` (default/info/debug/error/fault) no son los
  de logcat (V/D/I/W/E/F). Hay que decidir la traducción, porque los chips del panel del
  028 están cableados a los niveles de Android.

## Pendiente heredado que aplica acá

El overhead de captura de logs en gama baja quedó anotado sin verificar en el 027. En
iOS conviene medirlo desde el principio, no dejarlo para después.

## Entregado (2026-08-10) — logs sí, crashes pendientes

`syslog live` → el MISMO `LogEntry` que produce logcat, así que ring de 50k (027), panel
con filtros (028), export .txt/.jsonl (029) y marcas del reporte (030) se reusan sin
tocar una línea. La capability `logs` pasó a true en iOS y el panel deja de esconderse.

**Verificado contra el device**: 5.756 entradas en 60 s desde un proceso real, parseadas
con nivel, tag, pid y mensaje.

- `parseSyslog.ts` — formato `ts proceso{imagen}[pid] <NIVEL>: mensaje`. El mapeo de
  niveles es una DECISIÓN, no un hecho: os_log tiene `Notice` y `Fault`, que logcat no
  tiene; se traducen por severidad (`Notice`→I, `Fault`→F) porque es lo que filtran los
  chips del panel. Un nivel desconocido cae a Info en vez de perder la línea.
- El nivel se captura como `[^>]+` y no como `\w+`: `\w` es ASCII en JS y una etiqueta
  acentuada haría fallar la línea entera.
- **Filtrado en dos etapas**, y la primera importa para el overhead: `--process-name`
  filtra EN EL DEVICE (sin eso `syslog live` empuja el sistema entero por USB y el costo
  lo paga el teléfono — choca con la regla de "cero overhead nuevo" de la iteración 2), y
  el pid se filtra en el host, que es exacto y permite seguir un reinicio de la app sin
  re-armar el stream (re-armarlo costaría el handshake del túnel entero).

## Pendiente: crashes

`crash watch`/`crash ls`/`crash pull` están confirmados por el research 044 pero **no
implementados**. Falta decidir cuánto del reporte de crash entra al panel y cuánto queda
como adjunto — los de iOS son bastante más ricos que un tombstone.
