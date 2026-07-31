---
label: wayfinder:ticket
title: Logger — captura logcat de la app + crashes/ANR vía AdbTransport
status: open
assignee:
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
  + **persistencia NDJSON junto a la sesión** existente, para exportar logs de sesiones
  pasadas.
- Cambio de app/device en caliente recablea el stream igual que el sampler.
- Overhead: `logcat --pid` corre en el device pero es barato (lector de ring buffer del
  kernel); verificar en gama baja que no aparezca en el top de CPU igual que se hizo en
  el ticket 023.
- Tests con fake-adb (stub del stream) + fixtures de logcat real del A15.
