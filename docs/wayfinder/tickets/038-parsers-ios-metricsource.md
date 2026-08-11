---
label: wayfinder:ticket
title: Parsers iOS + IosMetricSource (CPU, memoria, FPS, GPU%, batería, ficha)
status: closed
assignee: claude
blocked-by: [037]
---

# 038 — `IosMetricSource` y sus parsers

## Question

Implementar el camino iOS vivo: del `tunneld` a un `Sample` emitido por tick, con el
corte de métricas acordado.

## Contexto (grilling 2026-08-10)

### Qué entra (escalones 1 y 2 del corte)

**Escalón 1 — dos suscripciones DTX, casi gratis:**

- `sysmontap` → CPU de la app y del device, `physFootprint`, `memResidentSize`.
- `graphics.opengl` → FPS (`CoreAnimationFramesPerSecond`) y **GPU% con desglose
  device/renderer/tiler**. Acá iOS le gana a Android, que necesita probing por SoC y
  todavía tiene el hueco de Mali/Xclipse abierto.

### Claves reales de `graphics.opengl` (capturadas en el spike 033)

iPhone15,3 · iOS 26.5.2 · ~1 Hz. `pymobiledevice3` las reenvía crudas, así que esto es lo
que manda el device:

| Clave                                | Uso propuesto                                                      |
| ------------------------------------ | ------------------------------------------------------------------ |
| `CoreAnimationFramesPerSecond`       | **FPS** → `Sample.fps`                                             |
| `Device Utilization %`               | **GPU%** → `Sample.gpu` (el equivalente del `gpu_busy` de Android) |
| `Renderer Utilization %`             | desglose GPU (no tiene equivalente Android)                        |
| `Tiler Utilization %`                | desglose GPU (no tiene equivalente Android)                        |
| `Alloc system memory`                | memoria de GPU asignada                                            |
| `In use system memory`               | memoria de GPU en uso                                              |
| `In use system memory (driver)`      | idem, del driver                                                   |
| `Allocated PB Size`                  | parameter buffer                                                   |
| `TiledSceneBytes`                    | bytes de escena tileada                                            |
| `SplitSceneCount`                    | escenas partidas (señal de presión de memoria de GPU)              |
| `recoveryCount` / `lastRecoveryTime` | recuperaciones del driver — candidato a marca en el timeline       |
| `XRVideoCardRunTimeStamp`            | timestamp del device; sirve para cadencia y para detectar huecos   |
| `IOGLBundleName`                     | string (`"Built-In"`) — ficha, no métrica                          |

⚠️ Ojo: **no hay histograma de frame-times acá**, lo que confirma el corte (jank y
p50/p90/p99 quedan N/A en iOS v1). Y ojo con `CoreAnimationFramesPerSecond` cuando no hay
app renderizando: da `0`, que es un cero legítimo, no un N/A — hay que distinguirlo.

**Escalón 2 — servicios lockdown sueltos, independientes:**

- Ficha del device por lockdown.
- Batería vía `diagnostics ioregistry` → `AppleSmartBattery` (nivel, temperatura **de
  batería**, amperaje instantáneo).

Logs y crashes son el ticket 039 aparte.

### Qué queda afuera, en `null` honesto

- **Frame-times p50/p90/p99 y `jankPct`.** `graphics.opengl` da FPS pero **no da
  histograma de frame-times**. En Android salían gratis del `present2present` que ya
  venía en el dump de timestats; en iOS habría que ir a `coreprofilesessiontap` (ticket
  043, sin compromiso). Es la métrica que ustedes definieron como de primera clase en el
  024 y en iOS v1 no está — el dashboard la muestra N/A.
- **Temperatura de SoC**: imposible sin entitlements privados. No es un pendiente, es
  un no.
- **Red per-app**: fuera del v1.

### Metodología

Misma de siempre, 3 capas: parsers contra los fixtures del 036 · e2e con un fake del
transporte iOS (el equivalente de fake-adb) · smoke contra el device real. El
`IosMetricSource` tiene su propio loop — no reusa el `Sampler` de dos carriles, que es
Android puro por diseño (ver 035).

Descubrimiento de devices: GET a la API HTTP local del `tunneld`, que devuelve la lista
con su dirección RSD — mismo shape que `adb devices`, así que `devices()` y
`trackDevices()` mantienen su contrato.

`pymobiledevice3` va **pineado** a la versión que validó el 033 (**R4**).

## Entregado (2026-08-10)

Camino iOS vivo, verificado contra el device real (iPhone15,3 · iOS 26.5.2) con
Evermore Arcade corriendo: **CPU 42,3 % · footprint 1023 MB · compressed 240 MB · FPS ·
GPU**, todo entrando al dashboard por el mismo `pushSample()` que Android.

- `parseGraphics.ts` — FPS + GPU device/renderer/tiler + memoria de GPU. **`0` de FPS se
  conserva como 0**, no como null: es "no se compuso ningún frame", y confundirlo con N/A
  arruina el promedio (en una captura real, 107 de 149 muestras eran ceros de background
  y el promedio crudo daba 16 FPS contra 57 reales).
- `parseSysmon.ts` — `SysmonAssembler`, que ensambla **JSON pretty multi-línea** contando
  llaves fuera de strings. El research daba por sentado JSON-lines; el spike lo desmintió.
- `IosMetricSource` — dos streams largos abiertos una vez (levantar el túnel cuesta
  decenas de segundos, abrirlo por tick sería impagable) y un tick que combina el último
  valor de cada canal.
- `deviceInfo.ts` — `resolveIosProcess` busca el proceso contra la lista REAL del device
  ignorando mayúsculas: `com.evermoregames.evermorearcade` corre como `EvermoreArcade`, y
  derivarlo del bundle daría `Evermorearcade`, que no matchea nunca.
- El canal de gráficos arranca **con la app cerrada o abierta** (FPS y GPU son del
  compositor, no del proceso), y un watch cada 5 s engancha el canal de proceso cuando la
  app aparece — el equivalente de `refreshPid()`.

### Dos bugs que costaron caro y quedaron con test

1. **Python bufferea stdout al escribir a un pipe.** El canal de sysmon estuvo mudo dos
   minutos enteros hasta encontrarlo; se arregla con `PYTHONUNBUFFERED=1` en el env.
   Para un consumidor en streaming, el buffer de bloque es siempre el enemigo.
2. El `stop()` del server no cortaba la fuente iOS ⇒ quedaban procesos de
   `pymobiledevice3` huérfanos con el túnel abierto contra el iPhone.
