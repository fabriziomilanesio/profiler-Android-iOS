---
label: wayfinder:ticket
title: Desconexión y reconexión de iOS — dejar de mostrar datos viejos como vivos
status: open
assignee: claude
blocked-by: [038, 039]
---

# 046 — Desconexión y reconexión iOS

## Question

Qué hace el profiler cuando el iPhone (o su túnel) se cae en medio de una sesión, y cómo
vuelve solo cuando reaparece.

## El estado antes de este ticket

No existía desconexión ni reconexión: `startDeviceWatch()` corre **sólo** mientras
`serial === null` y se auto-mata en el primer enganche. Nada volvía a poner `serial = null`.
La "reconexión automática" del ticket 010 quedó sin implementar (`RealAdbTransport.trackDevices`
está escrito y no lo llama nadie).

En iOS eso se manifestaba peor que en Android, porque los canales son suscripciones:

1. `IosMetricSource` abría sus tres streams **sin pasar `onExit`**: si el hijo de
   `pymobiledevice3` moría, nadie se enteraba.
2. `LastValues` no caducaba: el tick seguía empujando el último FPS/GPU/batería **cada
   segundo con `ts: Date.now()` fresco**. No era un hueco — era dato viejo presentado como
   vivo, persistido en la sesión y metido en el reporte.
3. `setProcessName` era idempotente **por nombre**: muerto el stream de sysmon, la app
   seguía llamándose igual y el canal no se re-armaba nunca. Silencio permanente.
4. `startIosProcessWatch` hacía `.catch(() => [])` — "no pude preguntar" se convertía en
   "el proceso no está" y a los ~15 s emitía un **`app-died` falso** por cada desconexión.
   Android ya distinguía los dos casos (`refreshPid` devuelve `null` = no concluir nada);
   la rama iOS había tirado esa distinción.
5. El comentario de `IosLogCapture.ts` prometía que "el server re-arma al reenganchar".
   Ese reenganche no existía.

Contexto que sube la apuesta: el spike (`docs/research/ios-instruments-stack.md` §7) dejó
**abierto** si el túnel userspace aguanta 30+ min sin degradarse, y corremos **4 procesos
pmd3 concurrentes** — graphics y sysmon por DTX/túnel, batería y syslog por lockdown. La
caída parcial es el caso esperado, no el raro.

## Decisiones (grilling 2026-08-13)

- **El dashboard nunca muestra un dato viejo como vivo.** Estado de conexión explícito, se
  corta la emisión de samples cuando no hay device.
- **Detección en tres capas**: `onExit` de cada stream (señal rápida) + TTL de frescura por
  canal (atrapa el stream vivo pero mudo) + `usbmux list` como **árbitro bajo demanda** —
  se sondea sólo ante sospecha, porque cuesta ~1,2 s de proceso Python.
- **`graphics` es el canal vital.** Su caída no degrada: se avisa como caída completa y se
  rehace el enganche entero. `sysmon` y `battery` sí degradan a null por su cuenta.
- **Ventana de gracia de ~3 s** antes de tirar nada, con sondas secuenciales del árbitro. Si
  el canal revive dentro de la ventana, el microcorte no deja rastro.
- **El re-enganche reusa el modo espera**: teardown → `serial = null` → se revive
  `startDeviceWatch()`, que engancha por el mismo `switchToIosDevice` de siempre. Cero rutas
  de enganche nuevas.
- **Un device a la vez**: no se construye pin por UDID. El watcher toma el que aparezca.
- **Protocolo**: mensaje aditivo `{type:'connection', state, serial}`, emitido en cada
  transición y en `onOpen` (un dashboard abierto tarde no debe pintar un device fantasma).
- **Latencia**: túnel mudo ⇒ ~6 s hasta el aviso (TTL 3 s = 3× la cadencia de graphics, más
  la ventana de 3 s). Hijo muerto ⇒ ~3 s, sólo la ventana.
- **Nada en la sesión ni en el reporte.** Sólo en vivo. Consecuencia aceptada: al revisar
  una corrida vieja, un hueco por cable no se distingue de un hueco por juego cerrado.
- **Android queda como está**, con su semántica distinta (samples todo-null, sin gap ni
  reconexión). Decisión explícita, no olvido.

## Fuera de alcance

Android; eventos `device-lost` en sesión/reporte; pin multi-device; `trackDevices`/`tunneld`.

~~auto-restart del canal de batería~~ — **entró al alcance el 2026-08-13**: el hardware
mostró que sin él la temperatura desaparece para siempre. Ver más abajo.

## Entregado (2026-08-13) — falta la validación contra el iPhone real

- `IosMetricSource`: `onExit` en graphics y sysmon, `receivedAt` por canal y TTL en `emit()`
  (`staleMs`, default 3000). El canal vital avisa por `onVitalDown`/`onVitalUp`, una sola vez
  por transición y nunca durante `stop()` (el teardown mata a los hijos y sus `onExit`
  habrían abierto una ventana de gracia por un device ya soltado).
- `setProcessName` mira la salud del stream además del nombre, con **generación** para que el
  `onExit` tardío del hijo viejo no marque muerto al nuevo — si no, el watch re-armaba cada
  5 s pagando un handshake de túnel por vuelta.
- `IosTransport.processes()` devuelve `IosProcess[] | null`.
- `LiveServer`: `connState`, `startIosGrace()`/`cancelIosGrace()`/`loseIosDevice()`,
  `teardownIos()` compartido, revivido de `startDeviceWatch()` y `connectionMessage` en cada
  transición y en `onOpen`. Opciones nuevas para tests: `iosGraceMs`, `iosStaleMs`,
  `iosProcessPollMs`.
- UI: el badge `recBadge` pinta el peor de los dos vínculos — `OFFLINE` (WS caído),
  `NO DEVICE` (device perdido), `RECONNECTING` (ventana de gracia), `LIVE`.
- Tests: 8 en `IosMetricSource.test.ts` (frescura, canal vital, re-armado) y 5 nuevos en
  `iosConnection.test.ts` (transiciones, microcorte que se recupera, re-enganche solo,
  regresión del `app-died` falso). Suite completa: 494 verdes.

## Verificado contra el iPhone real (2026-08-13, iPhone15,3 · iOS 26.6)

Ciclo completo matando el proceso del canal vital con el device enchufado:

```
 5.0s  CONNECTION → reconnecting          ← kill del hijo de `dvt graphics`
 8.0s  APP pid=null / CONNECTION → lost   ← vencida la gracia de 3 s, teardown
11.6s  APP pid=… / CONNECTION → connected ← re-enganche solo
```

**6,6 s de punta a punta**, sin un solo sample en el hueco, y estable dos minutos después.
El handshake del túnel al reenganchar resultó bastante más rápido que las "decenas de
segundos" que temíamos por el spike 033.

Otras dos cosas que sólo aparecieron con el teléfono en la mano:

1. **Cadencia de batería medida**: 1 Hz exacto (`Temperature` 3259 → 3300 → 3319 centi-°C).
   El TTL de 3 s es seguro para ese canal; no borra la temperatura.
2. **Un canal lockdown muerto no volvía nunca.** Matar `diagnostics battery monitor` dejaba
   la temperatura en N/A por el resto de la sesión — y es lo único térmico que iOS entrega.
   Decisión nueva (2026-08-13): batería y syslog se reponen solos con backoff
   (2 s → 5 s → 15 s → 30 s) vía `ResilientStream`. Son LOCKDOWN, no pagan el handshake del
   túnel: reponer uno cuesta ~2 s. Verificado — al matar el proceso, el canal vuelve y la
   temperatura ni llega a irse a N/A. Los canales DTX NO usan esto: `graphics` es el vital
   (lo maneja el server) y `sysmon` ya se repone por el watch de procesos.

### El bug que casi arruina todo, y que sólo el hardware encontró

El primer intento contra el iPhone **mató el server entero**:

```
TypeError: null is not an object (evaluating 'this.iosSource.setProcessName')
    at liveServer.ts (startIosProcessWatch)
```

El watch chequeaba `this.iosSource` **antes** del `await` de `processes ps` (hasta 30 s de
timeout) y el teardown lo dejaba en null en el medio. La excepción llegaba a
`unhandledRejection`, que en el CLI baja el proceso — así que la reconexión nunca podía
ocurrir. Con fakes instantáneos ese hueco no existe y los 494 tests pasaban en verde.

Arreglado revalidando identidad después del await (`this.iosSource !== source` ⇒ salir) y
con `.catch()` en los dos `void` async del ciclo, para que ningún error del watch o de la
ventana de gracia pueda tumbar el server. Tiene test de regresión con un `processes()` que
se cuelga a propósito.

## E2E (ticket 014, escenario de desconexión)

`e2e/connection.spec.ts` + `scripts/e2e-harness.ts`: el LiveServer y el dashboard REALES
contra un `pymobiledevice3` falso, manejados por Playwright. Cubre el camino
server → WebSocket → UI, que los unitarios no tocaban — llegaban hasta el mensaje
`connection` y de ahí al badge había JS sin ejercitar. Cuatro casos: LIVE con datos vivos,
canal vital muerto → RECONNECTING → vuelta sola, desenchufado → NO DEVICE → reenganche, y la
regresión del device fantasma (pestaña nueva con el cable afuera).

`bun test` ahora corre `bun test src` para no pisarse con los `.spec.ts` de Playwright;
el e2e va por `bun run test:e2e`.

## Límite conocido

El TTL sólo corre **después** de la primera línea del canal: levantar el túnel tarda decenas
de segundos y no se puede declarar caído lo que todavía no arrancó. Un handshake colgado
para siempre queda colgado (igual que antes) salvo que el hijo muera, que sí se detecta.
