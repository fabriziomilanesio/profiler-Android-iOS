---
label: wayfinder:ticket
title: Logger — captura logcat de la app + crashes/ANR vía AdbTransport
status: closed
assignee: claude
blocked-by: []
---

# 027 — Captura de logs: logcat por app + crashes

## Question

Capturar el logcat filtrado por el pid de la app seleccionada (Unity: Debug.Log/LogError
salen por el tag `Unity`) más el buffer de crashes/ANR de esa app, por la costura
`AdbTransport`. ¿Cómo se maneja el stream continuo (logcat es long-running, no
request/response como el resto de los colectores) y el re-enganche cuando la app muere y
renace con otro pid?

## Contexto (grilling 2026-07-31)

- **Ámbito decidido**: solo la app seleccionada + sus crashes (tombstones/ANR). Nada de
  logcat device-wide.
- **Esquema de log-entry genérico** con `source: 'logcat' | 'game'` — el SDK dentro del
  juego Unity es una iteración futura (fog del mapa) y debe enchufarse acá sin migración.
- Ring buffer en memoria con cap (supuesto: mismo espíritu que el cap ~8 h de la sesión)
  - **persistencia NDJSON junto a la sesión** existente, para exportar logs de sesiones
    pasadas.
- Cambio de app/device en caliente recablea el stream igual que el sampler.
- Overhead: `logcat --pid` corre en el device pero es barato (lector de ring buffer del
  kernel); verificar en gama baja que no aparezca en el top de CPU igual que se hizo en
  el ticket 023.
- Tests con fake-adb (stub del stream) + fixtures de logcat real del A15.

## Entregado

- **`AdbTransport.streamShell()`** — la costura gana procesos long-running: comando
  shell que entrega stdout línea a línea + `onExit`, devuelve `stop()`.
  `RealAdbTransport` lo implementa con el `streamLines` de `runtime/spawn.ts` (mismo
  adapter que `trackDevices`). Todos los fakes de tests/smokes actualizados.
- **`src/core/logs/`** (módulo nuevo):
  - `logEntry.ts` — esquema genérico `{ ts, level (V|D|I|W|E|F), tag, message, pid,
tid?, source: 'logcat' | 'game', isCrash? }`. `source: 'game'` reservado para el
    SDK Unity futuro: se enchufa sin migración.
  - `parseLogcat.ts` — parser puro de `logcat -v threadtime -v year` (year elegido
    para epoch determinístico en el cruce de año; acepta líneas sin año con fallback).
    Separadores/basura ⇒ null, nunca tira. Las continuation lines de un stacktrace
    son líneas completas con el mismo tag/pid/tid: el orden del stream las preserva
    agrupadas.
  - `logRing.ts` — ring buffer circular en memoria, cap **50k entradas** (~12 MB a
    ~250 B/entrada — mismo espíritu que el cap de 8 h del SessionBuffer), push O(1).
  - `logSink.ts` — persistencia NDJSON hermana de la sesión: `<id>.logs.jsonl` en el
    MISMO `~/.config/evermore-profiler/sessions/` que el `<id>.jsonl`; se crea recién
    en el primer append; `LogSink.read()` para sesiones pasadas (lo usa el 029).
  - `logcatCapture.ts` — ciclo de vida: **app stream** `logcat -b main,system
--pid=<pid> -v threadtime -v year -T 1` (solo la app; Unity loguea por tag
    `Unity`; `-T 1` evita re-ingestar el histórico al re-armar) + **crash stream**
    `logcat -b crash,events …` device-wide adjudicado en código (pids recientes de la
    app para stacktraces Java/nativos; `am_anr` que menciona el package = ANR
    best-effort sin root) ⇒ `isCrash: true`. `setPid()` idempotente re-arma al
    cambiar el pid (muerte/renacimiento detectado por el sampler); pid null corta el
    app stream y deja vivo el de crashes; si logcat muere solo, retry con backoff
    exponencial 1 s → 15 s (reseteado al recibir línea); generation guard contra
    streams zombie.
- **`LiveServer`**: arma la captura al arrancar con device y en cada switch de
  app/device (sin device o sin app ⇒ cero streams, cero ruido); el stream corre
  APARTE del tick del sampler (cero trabajo nuevo en el hot path). Batching WS:
  mensaje nuevo `{type:'logs', entries: LogEntry[]}` cada 250 ms (flush inmediato a
  las 500 pendientes) — nunca una entrada por mensaje. `GET /api/logs?n=500`
  (bootstrap del panel 028, n ≤ 50k). Persistencia pausada con la app muerta (no
  infla el archivo), **salvo crashes que se persisten siempre**; los eventos
  app-died/app-restarted ya quedan en el JSONL de la sesión. La UI actual ignora el
  mensaje nuevo (el panel es del 028).
- **Fixtures** `fixtures/logcat/`: `unity-threadtime.txt` (líneas representativas
  reales de una app Unity: Debug.Log/LogError con stacktrace multi-línea, tags de
  sistema, línea sin año, basura) y `crash-events.txt` (FATAL EXCEPTION Java
  multi-línea, crash nativo SIGSEGV libc/DEBUG, `am_anr`, crash de otra app que debe
  filtrarse).
- **Tests** (todo sin device, fake-adb/stubs): parser vs fixtures (niveles,
  threadtime±year, crash multi-línea con tabs), ring (cap, orden, vueltas), sink
  (round-trip, traversal, línea corrupta), captura (armado, filtro de crashes/ANR,
  re-arme por pid, app muerta, backoff, stop) y LiveServer (comandos logcat, GET
  /api/logs, batch WS único, `<id>.logs.jsonl`, switch de app re-arma, modo espera
  sin streams). Suite completa: **249 verdes** + typecheck + fmt.

**Pendiente: verificar overhead en gama baja con device real** (el A15 no está
conectado ahora) — `logcat --pid` lee el ring buffer del kernel vía logd y debería
ser barato, pero hay que confirmar que `logcat`/`logd` no aparezcan en el top de CPU
durante una sesión, igual que se hizo en el ticket 023.
