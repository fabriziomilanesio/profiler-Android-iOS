---
id: 21
title: Conexión real en vivo — parsers + sampler + server WS + dashboard con datos reales
label: wayfinder:task
status: closed
assignee: agent-live
blocked-by: [1, 8, 10]
---

## Question

Slice vertical end-to-end: el dashboard mostrando **datos reales** del device conectado
(Galaxy A15 / mt6789 / Mali, API 36) vía adb, no el simulador. Reusa el layout del
prototipo (prototypes/dashboard) pero alimentado por un backend real.

Cubre (implementa lo mínimo real de los tickets 8 y 10, con fuentes YA confirmadas por los
fixtures de sm-a155m-api36):

- **Parsers puros** (src/core/collectors/, test-first contra fixtures reales): meminfo (App
  Summary → pss + breakdown), CPU (deltas `/proc/<pid>/stat` vs `/proc/stat`), FPS
  (`SurfaceFlinger --timestats` → averageFPS), temp (`thermalservice` → AP/SKIN/BAT por
  mType), GPU (`/sys/kernel/gpu/gpu_busy` → "99 %"), batería (`dumpsys battery` → level %,
  temp ÷10, current now mA), DeviceInfo (getprop; arreglar el bug de GPU en el nombre).
- **Sampler** (src/core/sampler/): loop 1 Hz sobre AdbTransport → Sample; best-effort marca
  N/A lo que falle; graba a JSONL de sesión.
- **Server local** (src/server/): sirve el UI y streamea Samples por WebSocket (adapter de
  runtime, Bun.serve detrás de thin wrapper).
- **UI real** (src/ui/ o reusar prototypes/dashboard): consume el WS en vez de sim.js.
- **Comando** `profiler live [--package]`: preflight → elegir device/app → abrir browser →
  stream en vivo.

Verificación: parsers verdes contra fixtures; y **smoke en vivo** con el device conectado —
levantar el server, confirmar que llegan Samples con números reales coherentes.

## Resolution (2026-07-17)

Slice vertical end-to-end **funcionando contra el device real** (Galaxy A15 / SM-A155M /
mt6789 / Mali-G57 MC2 / Android 16 API 36, serial REDACTED-SERIAL). `bun test` (113 pass) y
`bun run typecheck` verdes.

### Qué quedó

- **Parsers puros** (`src/core/collectors/`, uno por métrica, tests contra los fixtures
  reales de `fixtures/sm-a155m-api36/` en `parsers.test.ts`):
  - `meminfo.ts` — App Summary → `pss` + breakdown (java/native/graphics/code/stack/other).
    Graphics=0 ⇒ N/A (memtrack HAL ausente), no "0 MB".
  - `cpu.ts` — deltas `/proc/<pid>/stat` (utime+stime, parseado desde el último `)`) vs
    `/proc/stat` → % share-of-device 0–100.
  - `fps.ts` — `SurfaceFlinger --timestats -dump` → `averageFPS`. **Bug real corregido:** el
    dump lista varios layers (NotificationShade, StatusBar, el SurfaceView de la app), cada
    uno con su `averageFPS`; el parser filtra por el layer del package, no toma el primero.
  - `temp.ts` — `thermalservice` "Current temperatures from HAL", mType 0 = CPU/AP (por
    mType, no mName).
  - `gpu.ts` — `/sys/kernel/gpu/gpu_busy` → entero de "NN %".
  - `battery.ts` — `level` / `temperature ÷10` / `current now` / `*powered:true` ⇒ charging.
  - `deviceInfo.ts` — getprop + MemTotal + **GPU name arreglado**: sale limpio de la línea
    `GLES:` de `dumpsys SurfaceFlinger` ("Mali-G57 MC2"), ya no "GLES (Ganesh)".
- **Schema** (`src/core/schema.ts`): `Sample` (cpu/gpu/fps/tempC/mem{pss,java,native,
  graphics,code,stack,other}/battery{levelPct,tempC,mA,charging}/netRxKb/netTxKb) y
  `DeviceInfo`. "no disponible" = `null` explícito en todos lados.
- **Sampler** (`src/core/sampler/`): loop 1 Hz sobre `AdbTransport.shell()`, best-effort
  (un collector que falla o excepción ⇒ su métrica `null`, sin reintento). `init()` habilita
  timestats de SurfaceFlinger (necesario para FPS); `dispose()` lo apaga. CPU es `null` en la
  primera muestra (necesita snapshot previo). `refreshPid()` reengancha si la app reinicia.
- **Server** (`src/server/`): HTTP + WebSocket detrás de `src/runtime/httpServer.ts` (thin
  adapter, `Bun.serve`/WS aislado ahí — costura de runtime respetada). Sirve el UI, streamea
  `{type:"sample",sample}` por WS y manda `{type:"device",device}` al conectar. Opcional JSONL.
- **UI real** (`src/ui/`, copiado de `prototypes/dashboard/`): `render.js` (misma lógica de
  ECharts, ahora null-aware → N/A) + `live.js` (cliente WS con reconexión) en vez de `sim.js`.
  **Gauge de batería agregado** (5º gauge, con chip CHARGING). Light default, branding,
  responsive intactos.
- **CLI** (`src/cli.ts`): subcomando `profiler live [--package] [--port]` → preflight → primer
  device → captura DeviceInfo → levanta el server → imprime la URL.

### Cómo se corre

```bash
# app en foreground (relanzar si hace falta):
adb shell monkey -p com.sample.oda.qa -c android.intent.category.LAUNCHER 1
# server + dashboard en vivo:
bun run src/cli.ts live            # → http://localhost:4517  (abrir en el browser)
bun run src/cli.ts live --package com.sample.oda.qa --port 4517
# smoke de collectors contra el device real (sin server):
bun run scripts/smoke-live.ts 6
```

Verificado: `curl http://localhost:4517/` sirve el HTML (200) + render.js/live.js/echarts/
assets; un mini cliente WS recibió el `device` y varios `sample`.

### Ticks reales del device (SM-A155M, app renderizando)

```
DeviceInfo: {serial:REDACTED-SERIAL, model:SM-A155M, manufacturer:samsung, androidRelease:16,
             apiLevel:36, soc:mt6789, gpu:"Mali-G57 MC2", ramTotalMb:3666}
tick 0: cpu=null gpu=60  fps=null   temp=36.3 pss=887MB  bat={100%,31.1C,228mA,charging}
tick 1: cpu=3.1  gpu=7   fps=null   temp=36.3 pss=887MB  bat={100%,31.1C,228mA,charging}
tick 2: cpu=5.0  gpu=0   fps=null   temp=36.3 pss=911MB  bat={100%,31.1C,228mA,charging}
tick 3: cpu=8.4  gpu=100 fps=39.56  temp=36.3 pss=900MB  bat={100%,31.1C,228mA,charging}
tick 4: cpu=6.5  gpu=99  fps=39.98  temp=36.3 pss=900MB  bat={100%,31.1C,228mA,charging}
tick 5: cpu=7.6  gpu=99  fps=39.98  temp=36.3 pss=900MB  bat={100%,31.1C,248mA,charging}
```

Todos coherentes: cpu 0–100, gpu 0–100 (0 cuando la app está idle en el menú, 99–100
renderizando), fps ~40 mientras presenta frames, mem en MB, temp ~36°C, battery 100%.

### Qué métrica anduvo / N/A contra el device real

- ✅ **cpu, gpu, temp, mem (pss+breakdown, graphics incluido), battery (level/temp/mA/charging),
  DeviceInfo** — reales y estables tick a tick.
- ⚠️ **fps** — real (~40) **solo mientras la app presenta frames**; si está idle/background el
  layer no aparece en timestats ⇒ `null` (N/A honesto, no un cero falso). Requiere timestats
  habilitado (lo hace `Sampler.init()`).
- ⚠️ **battery.charging = true** todo el tiempo: el device está enchufado por USB (AC powered),
  así que `mA` es corriente de carga, no drenaje. Se reporta tal cual (no rompe).
- ⭕ **netRxKb/netTxKb = null** — deliberado (ver abajo).

### Qué de los tickets 8 y 10 queda para después (NO cerrados)

Esto es el **MVP real** de 8 (métricas) y 10 (server/UI); quedó afuera a propósito:

- **Percentiles/frame-time**: p50/p90/p99 y jank% desde el histograma `presentToPresent`
  (el parser hoy solo toma `averageFPS`). El histograma ya viene en el dump.
- **Network per-uid real**: `netRxKb/netTxKb` están en `null`. `dumpsys netstats detail` es por
  buckets (2 h, no realtime) y el fixture lo confirma; no hay fuente realtime sin root en este
  device. Queda como total-de-sesión a baja frecuencia (research §6), no como sparkline por seg.
- **Thermal fallback**: si `thermalservice` no expusiera mType 0, falta el fallback
  `/sys/class/thermal/*` → `dumpsys battery` (en el A15 no hizo falta: HAL da AP directo).
- **Reconexión completa por `track-devices`**: el cliente WS reconecta, y `refreshPid` reengancha
  el pid; falta el flujo de desconexión/reconexión del _device_ (unplug → replug) end-to-end
  por `trackDevices`.
- **GPU fallbacks por SoC**: hoy hardcodea `/sys/kernel/gpu/gpu_busy` (la que anda en Samsung/
  Mali). Falta el probing en orden (kgsl → gpu_busy_percentage → mali utilization) del research §5
  para otros devices.
