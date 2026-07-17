# Research: formatos de dumpsys y fuentes de métricas por API level (26→35) y OEM

> Ticket: [002-research-formatos-dumpsys](../wayfinder/tickets/002-research-formatos-dumpsys.md) ·
> Fecha: 2026-07-16 · Contexto: el profiler mide `com.evermore.oda.qa` (juego **Unity**) vía
> `adb shell` **sin root**, sampling ~1 Hz, en devices API 26→35 de OEMs variados.

## TL;DR — hallazgo crítico (Unity vs gfxinfo)

**`dumpsys gfxinfo <pkg>` NO sirve para medir FPS de evermore.** gfxinfo/framestats lee las
estadísticas de **HWUI** (el render thread del UI toolkit de Android). Unity renderiza con su
propio contexto GL/Vulkan sobre un `SurfaceView` y **no pasa por HWUI**: el comando devuelve
0 frames / sin sección `---PROFILEDATA---` en apps Unity (confirmado en foros de Unity y en
reportes con emulador). La fuente correcta para juegos es **SurfaceFlinger**, que sí ve todos
los buffers presentados:

- **Primaria: `dumpsys SurfaceFlinger --timestats`** — método documentado oficialmente por
  Google para medir frame rate de juegos ([Frame Rate — Android game development](https://developer.android.com/games/optimize/framerate)).
  Da `averageFPS`, `totalFrames` y el histograma `presentToPresent` por layer → de ahí salen
  FPS promedio, p50/p90/p99 y jank%.
- **Fallback (API 26–28 o si timestats no está): `dumpsys SurfaceFlinger --latency '<layer>'`**
  — ventana de 127/128 frames con 3 timestamps ns por línea; frágil (nombre de layer cambia
  por versión, BLAST en 12+), pero universal desde hace años.
- **Offline/deep-dive: Perfetto FrameTimeline** (Android 12+) — hoy **no cubre SurfaceView**
  según la doc de Perfetto, así que tampoco es la vía para Unity en v1.

---

## 1. `dumpsys meminfo <pkg>`

### Estructura por API level

Dos bloques nos interesan: la **tabla detallada** (filas `Native Heap`, `Dalvik Heap`, `.so mmap`,
`EGL mtrack`, `GL mtrack`, …) y el **App Summary** (agregado por categoría). El App Summary
existe desde Android 7.0 (API 24), o sea **está presente en todo nuestro rango 26→35** y es el
bloque más estable para parsear:

```
 App Summary
                       Pss(KB)
                        ------
           Java Heap:    12500
         Native Heap:    23456
                Code:     8912
               Stack:      460
            Graphics:    91234
       Private Other:     3456
              System:     4500

               TOTAL:   144518       TOTAL SWAP PSS:     1256
```

Cambios relevantes en el rango:

| API           | Cambio                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 24 (7.0)      | Aparece `App Summary` (Java Heap/Native Heap/Code/Stack/Graphics/Private Other/System). Estable desde entonces.                                                                                                                                           |
| 26 (8.0)      | Columna `Swapped Dirty` pasa a `SwapPss Dirty` en devices con swap PSS habilitado.                                                                                                                                                                        |
| 29–30 (10/11) | La tabla detallada suma columna **`Rss Total`** (ej. Perfetto muestra header `Pss Total / Private Dirty / Private Clean / SwapPss Dirty / Rss Total`); el App Summary agrega columna `Rss(KB)` y línea `TOTAL RSS:`.                                      |
| 31+ (12–15)   | Filas nuevas en la tabla detallada según allocators del device (Scudo, GWP-ASan, DMA-BUF, JIT cache) — el proyecto [Gracker/Android-App-Memory-Analysis](https://github.com/Gracker/Android-App-Memory-Analysis) las cataloga. No afectan al App Summary. |

Notas OEM/HW:

- `Graphics` (= `EGL mtrack` + `GL mtrack` + `Gfx dev`) **depende de que el driver del OEM
  implemente memtrack HAL**: en algunos devices (y en emuladores) reporta 0. Tratar 0 como
  "no disponible", no como "0 MB".
- Unity: la mayor parte del juego cae en `Native Heap` (heap C++ de Unity/il2cpp) +
  `Graphics`; `Java Heap` queda chico. Perfecto para la torta de memoria del dashboard.

### Decisión collector RAM

- **Primaria:** parsear el bloque `App Summary` con regex `^\s*([\w ]+):\s+(\d+)` — nombres de
  categoría estables API 24→35; tolerar columna `Rss(KB)` extra (tomar la primera columna =
  Pss). PSS total desde `TOTAL:`.
- **Fallback:** si falta App Summary (custom ROM rara), usar la tabla detallada
  (`TOTAL` row, `Pss Total` col) — mismo dump, distinto bloque.
- **No** depender de posiciones de columnas de la tabla detallada (varían por versión); si se
  usa, mapear por header.

Fuentes: [developer.android.com/tools/dumpsys](https://developer.android.com/tools/dumpsys) ·
[Perfetto — Debugging memory usage on Android](https://perfetto.dev/docs/case-studies/memory) ·
[Gracker/Android-App-Memory-Analysis](https://github.com/Gracker/Android-App-Memory-Analysis)

---

## 2. `dumpsys gfxinfo` / `framestats` — y por qué NO aplica a Unity

### Qué da gfxinfo (para apps HWUI)

Agregado (estable API 23→35):

```
Stats since: 752958278148ns
Total frames rendered: 82189
Janky frames: 35335 (42.99%)
90th percentile: 34ms
95th percentile: 42ms
99th percentile: 69ms
Number Missed Vsync: 4706
Number Slow UI thread: 17270
Number Slow bitmap uploads: 1542
Number Slow draw: 23342
```

`framestats` agrega un CSV `---PROFILEDATA---` de ~120 frames con 14 columnas (ns), en este
orden: `FLAGS, INTENDED_VSYNC, VSYNC, OLDEST_INPUT_EVENT, NEWEST_INPUT_EVENT,
HANDLE_INPUT_START, ANIMATION_START, PERFORM_TRAVERSALS_START, DRAW_START, SYNC_QUEUED,
SYNC_START, ISSUE_DRAW_COMMANDS_START, SWAP_BUFFERS, FRAME_COMPLETED`.
Frame time = `FRAME_COMPLETED − INTENDED_VSYNC` (solo filas con `FLAGS=0`); jank = frame time

> presupuesto de vsync. `dumpsys gfxinfo <pkg> reset` reinicia la ventana.
> (Fuente: [Testing Display Performance](https://iut-fbleau.fr/docs/android/training/testing/performance.html),
> doc oficial archivada de developer.android.com.)

### Veredicto Unity

- gfxinfo instrumenta `FrameInfo` de **HWUI** (introducido en 6.0). Unity usa
  `UnityPlayerActivity` + `SurfaceView` con swapchain GL/Vulkan propio → HWUI solo dibuja la
  jerarquía de Views (prácticamente estática) → **`Total frames rendered` no refleja los
  frames del juego y `framestats` no emite `---PROFILEDATA---`**.
  Evidencia: [Unity Discussions — "No PROFILEDATA is being generated"](https://discussions.unity.com/t/no-profiledata-is-being-generated-by-the-adb-shell-dumpsys-gfxinfo-package-name-framestats-command/345753)
  (Macrobenchmark falla contra apps Unity por esto) y [reporte en testerhome](https://testerhome.com/topics/40129)
  (frames=0 con gfxinfo en app Unity).
- Perfetto **FrameTimeline** (Android 12+, data source
  `android.surfaceflinger.frametimeline`, tablas `expected/actual_frame_timeline_slice`)
  clasifica jank por causa, pero la doc dice explícitamente **"SurfaceViews are currently not
  supported"** → no sirve para Unity hoy.
  ([perfetto.dev/docs/data-sources/frametimeline](https://perfetto.dev/docs/data-sources/frametimeline))

### Alternativa primaria: `dumpsys SurfaceFlinger --timestats`

Documentada por Google justamente para juegos
([Frame Rate | Android game development](https://developer.android.com/games/optimize/framerate)):

```bash
adb shell dumpsys SurfaceFlinger --timestats -clear -enable   # al iniciar sesión
adb shell dumpsys SurfaceFlinger --timestats -dump            # cada muestra (o al cierre)
adb shell dumpsys SurfaceFlinger --timestats -disable         # al terminar
```

Output por layer (ejemplo de la doc oficial):

```
layerName = SurfaceView[com.google.test/com.devrel.MainActivity]@0(BLAST)#132833
totalFrames = 1000
averageFPS = 30.179
presentToPresent histogram is as below:
0ms=0 ... 16ms=850 17ms=0 ... 33ms=100 ... 50ms=35 ... 66ms=10 ... 102ms=5 ...
```

- Filtrar el layer cuyo nombre matchea `SurfaceView[com.evermore.oda.qa/...]`.
- **FPS** = `averageFPS`; **percentiles p50/p90/p99** = acumular el histograma
  `presentToPresent` hasta 0.5/0.9/0.99 × `totalFrames` (la doc muestra el procedimiento);
  **jank%** = frames con presentToPresent > 1.5–2× el período de refresh ÷ totalFrames
  (definir umbral fijo en el parser y documentarlo).
- El módulo TimeStats existe en SurfaceFlinger desde ~Android 9/10
  ([AOSP frameworks/native/services/surfaceflinger/TimeStats](https://android.googlesource.com/platform/frameworks/native/+/master/services/surfaceflinger/TimeStats/TimeStats.cpp));
  el `doctor` debe probarlo en el device y degradar a `--latency` si no responde.

### Fallback: `dumpsys SurfaceFlinger --latency '<layer>'`

Formato ([AOSP frameworks/native](https://android.googlesource.com/platform/frameworks/native/+/82d7ab6%5E!/),
usado por [alibaba/mobileperf](https://github.com/alibaba/mobileperf/blob/master/mobileperf/android/fps.py)):

```
16666666                                  ← refresh period (ns)
9223372036854775807  9223372036854775807  9223372036854775807
1467832456789123     1467832473455789     1467832456999999
...(hasta 128 líneas: A=app draw start, B=vsync/present time, C=frameReady/set)
```

- FPS: contar deltas de la **columna B** (present) dentro de la ventana; descartar líneas con
  `9223372036854775807` (= `(1<<63)-1`, pending fence).
- `--latency-clear` reinicia la ventana entre muestras.
- **Nombre de layer por versión:** API 26–30: `SurfaceView - com.pkg/Activity#0` (variantes
  con/sin sufijo `#0` o `@0`); API 31+ (BLAST): `SurfaceView[com.pkg/Activity]@0(BLAST)#<id>`
  con `<id>` cambiante por sesión. **Siempre descubrirlo en runtime** con
  `dumpsys SurfaceFlinger --list | grep -F 'SurfaceView[com.evermore'` (o grep del pkg).
- Hay reportes de que en Android 12 el comando devuelve solo la primera línea si el nombre
  no es exacto (BLAST) ([issuetracker 247465689](https://issuetracker.google.com/issues/247465689))
  → por eso `--timestats` (que no requiere nombre exacto) es la primaria.

---

## 3. CPU por proceso

### Opciones

1. **`/proc/<pid>/stat` + `/proc/stat`** (primaria): formato de kernel Linux, **idéntico en
   API 26→35 y todos los OEMs** ([man proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html)).
   - `/proc/<pid>/stat`: campos 14 `utime` y 15 `stime` en clock ticks (USER_HZ=100 en
     Android). Ojo al parseo: el campo 2 `comm` va entre paréntesis y puede contener espacios
     → parsear desde el último `)`.
   - `/proc/stat` línea `cpu  user nice system idle iowait irq softirq steal ...`: total de
     ticks de todos los cores.
   - **CPU% del proceso (share del device)** = `Δ(utime+stime) / Δ(total_ticks) × 100` →
     0–100% siempre, ya normalizado por cores. Para "core-equivalentes" multiplicar por
     `ncores` (leer `/sys/devices/system/cpu/present` o contar líneas `cpu\d` de /proc/stat).
   - Una sola llamada por muestra: `adb shell "cat /proc/stat /proc/<pid>/stat"`.
   - Legible por el dominio `shell` sin root (las restricciones de Android 8+/11+ a
     `/proc/stat` y `/proc/<pid>` de otros procesos aplican a apps `untrusted_app`, no a adb).
2. **`top -b -n 1`** (solo humano/debug): desde API 26 `top` es de **toybox** (reemplazó al
   viejo formato toolbox de Android ≤7). Columnas `PID USER PR NI VIRT RES SHR S %CPU %MEM
TIME+ ARGS`; `%CPU` es relativo a **un core** (puede superar 100%, el header muestra p.ej.
   `800%cpu`). Formato con headers/orden que cambió entre releases de toybox → **no parsear
   como fuente primaria**. ([toybox help](https://landley.net/toybox/help.html),
   [AOSP external/toybox](https://android.googlesource.com/platform/external/toybox/+/75ebbd1571c85a06c0f4767beb7c20a19068f0b6/toys/posix/ps.c))

### Decisión collector CPU

- **Primaria:** deltas de `/proc/<pid>/stat` + `/proc/stat` entre muestras (1 Hz encaja
  perfecto). Reportar share-of-device (0–100%) y guardar ncores en metadata para poder
  mostrar "×N cores".
- **Fallback:** ninguno necesario (procfs es universal); `top -b -n 1 -p <pid>` solo en
  `doctor` como sanity check.

---

## 4. Temperatura

### `dumpsys thermalservice` (primaria, API 29+)

Thermal HAL 2.0 + Thermal API llegaron con Android 10
([source.android.com — Thermal mitigation](https://source.android.com/docs/core/power/thermal-mitigation)).
Output (formato `Temperature.toString()` de
[android.os.Temperature](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/os/Temperature.java)):

```
IsStatusOverride: false
ThermalEventListeners: ...
Thermal Status: 0
Cached temperatures:
	Temperature{mValue=30.8, mType=3, mName=..., mStatus=0}
Current temperatures:
	Temperature{mValue=38.2, mType=0, mName=CPU, mStatus=0}
	Temperature{mValue=37.0, mType=1, mName=GPU, mStatus=0}
	Temperature{mValue=33.4, mType=2, mName=BAT, mStatus=0}
	Temperature{mValue=36.1, mType=3, mName=SKIN, mStatus=0}
```

- `mType`: 0=CPU, 1=GPU, 2=BATTERY, 3=SKIN, 4=USB_PORT, 5=POWER_AMPLIFIER, 9=NPU, …
  (constantes `TYPE_*` de Temperature.java; **mapear por mType, no por mName**, porque mName
  es del OEM: Samsung usa `AP/BAT/PA/SUBBAT/USB`, Pixel `VIRTUAL-SKIN/cpu/battery`, etc. —
  ejemplo Samsung A52 en [XDA NOROOT Temperatures](https://xdaforums.com/t/noroot-temperatures.4763662/)).
- `mStatus`: throttling 0=NONE … 6=SHUTDOWN → métrica extra gratis ("está throttleando").
- Advertencia OEM: la cantidad y tipo de sensores expuestos depende del HAL del vendor;
  algunos devices solo reportan SKIN o lista vacía en `Current temperatures` → tratar como
  best-effort.

### Fallbacks

- **API 26–28 (o lista vacía):** `/sys/class/thermal/thermal_zone*/type` + `temp`
  (miligrados en general; algunos OEM usan décimas — normalizar: si valor > 1000 ⇒ /1000,
  si > 200 ⇒ /10). Nombres de zona 100% OEM-specific (`cpu-0-0`, `mtktscpu`, `AP`, `skin`,
  `battery`, `xo-therm`…): matchear por substring case-insensitive `cpu|gpu|batt|skin|ap\b`.
  Legible sin root en la mayoría de devices desde shell, pero hay OEMs que lo restringen
  (SELinux) → probar en `doctor`.
- **Siempre disponible:** `dumpsys battery` → línea `temperature: 250` (deci-°C) — batería
  como mínimo garantizado en todo el rango 26→35.

---

## 5. GPU% (best-effort por SoC, sin root)

No existe API pública de Android para GPU utilization; todo es sysfs del driver del vendor.
El collector debe **probar rutas en orden** en `doctor` y elegir la primera legible.

| SoC / driver                              | Ruta                                                                                                       | Formato                                                                                  | Sin root                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Qualcomm Adreno (kgsl)                    | `/sys/class/kgsl/kgsl-3d0/gpubusy`                                                                         | dos enteros `busy total` (ticks del período desde última lectura) → `% = busy/total×100` | ✅ world-readable en la gran mayoría; documentado por [Qualcomm](https://docs.qualcomm.com/bundle/publicresource/topics/80-88500-3/12_Check_GPU_usage.html)                                                  |
| Qualcomm Adreno (nuevo)                   | `/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage`                                                             | `NN %` directo                                                                           | ✅ donde existe (kernels recientes)                                                                                                                                                                          |
| Arm Mali (Exynos viejos, MediaTek, Kirin) | `/sys/class/misc/mali0/device/utilization` · variantes `/sys/devices/platform/*.mali/utilization`          | entero 0–100                                                                             | ⚠️ depende del kernel/OEM; a menudo ausente o restringido ([Arm Community](https://community.arm.com/support-forums/f/mobile-graphics-and-gaming-forum/3642/how-do-we-check-the-gpu-usage-load-for-android)) |
| Samsung (Mali y Xclipse)                  | `/sys/kernel/gpu/gpu_busy` (interfaz sysfs unificada de Samsung: `gpu_busy`, `gpu_clock`, `gpu_governor`…) | `NN %` o entero                                                                          | ⚠️ presente en kernels Samsung; legibilidad varía por modelo                                                                                                                                                 |
| PowerVR (Imagination)                     | solo debugfs (`/sys/kernel/debug/pvr/...`) o PVRScope/PVRTune                                              | —                                                                                        | ❌ debugfs requiere root → **no soportado en v1** ([foro Imagination](https://forums.imgtec.com/t/gpu-utilization/3506))                                                                                     |

Decisión: probar en orden `kgsl gpubusy` → `gpu_busy_percentage` → `/sys/kernel/gpu/gpu_busy`
→ `mali0/device/utilization`; si ninguna es legible, el gauge GPU muestra "N/A (SoC no
soportado)". Registrar la ruta elegida en la metadata de sesión. Coincide con lo previsto en
el mapa ("GPU% best-effort según device").

---

## 6. Network por-uid (resumen rx/tx)

Historia ([source.android.com — eBPF traffic monitoring](https://source.android.com/docs/core/data/ebpf-traffic-monitor)):

- **API 26–27 (8.x):** `/proc/net/xt_qtaguid/stats` funciona. Columnas:
  `idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes rx_packets tx_bytes tx_packets …`
  → sumar filas del uid de la app (uid vía `dumpsys package <pkg> | grep userId`).
- **API 28 (9):** transición a eBPF; devices lanzados con P + kernel 4.9+ ya usan eBPF. Apps
  SDK 28+ bloqueadas de leer los proc files de qtaguid por sepolicy (shell aún suele poder si
  el módulo existe).
- **API 29+ (10→15):** xt_qtaguid removido progresivamente de los kernels; los contadores
  viven en mapas eBPF (`/sys/fs/bpf/traffic_uid_stats_map` — **solo root/system**). Sin root
  quedan dos vías adb:
  1. `dumpsys netstats detail` → sección `UID stats` con buckets
     `st=<epoch> rb=<rxBytes> rp= tb=<txBytes> tp= op=` (o `bucketStart=... rxBytes=...` según
     versión) por `uid=` ([developer.android.com/tools/dumpsys](https://developer.android.com/tools/dumpsys)).
     **Ojo:** son buckets históricos (2h por default) que se actualizan por polling del
     sistema, no en tiempo real → sirve para el **total de la sesión**, no para un gráfico
     por segundo.
  2. `dumpsys netd trafficcontroller` → dump de los mapas eBPF (per-uid, tiempo real), pero
     el formato no está documentado como estable y en Android 13+ netstats se movió al módulo
     mainline Connectivity → tratar como experimental.

Decisión (v1 = "network solo resumen rx/tx" según el mapa):

- **Primaria (todo el rango):** `dumpsys netstats detail`, sumar buckets del uid → rx/tx
  acumulado al inicio y fin de sesión; delta = total de la sesión. Refrescar el valor visible
  a baja frecuencia (cada 30–60 s), documentando que no es realtime.
- **Bonus API 26–27:** si `/proc/net/xt_qtaguid/stats` es legible, usarlo para rx/tx por
  muestra (realtime).
- **No usar:** `/proc/uid_stat/<uid>/` (removido desde Android 6-7 aprox.; ya no existe en
  el rango 26→35).

---

## Tabla resumen: fuente por métrica por API level (adb shell, sin root)

| Métrica                      | API 26–28                                                 | API 29–30                           | API 31–35                                   | Estabilidad de formato                                  |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| RAM (PSS + composición)      | `dumpsys meminfo` → App Summary                           | ídem (+ col. Rss)                   | ídem                                        | Alta (App Summary estable desde API 24)                 |
| FPS/jank/percentiles (Unity) | `SurfaceFlinger --latency <layer>` (probar `--timestats`) | `SurfaceFlinger --timestats`        | `SurfaceFlinger --timestats` (layers BLAST) | Media (probar en doctor; layer discovery en runtime)    |
| FPS apps HWUI (no evermore)  | `gfxinfo` + `framestats`                                  | ídem                                | ídem                                        | Alta — pero **no ve frames Unity**                      |
| CPU% proceso                 | `/proc/<pid>/stat` + `/proc/stat`                         | ídem                                | ídem                                        | Alta (formato kernel, idéntico en OEMs)                 |
| Temperatura                  | `/sys/class/thermal/*` + `dumpsys battery`                | `dumpsys thermalservice`            | `dumpsys thermalservice`                    | Media (sensores dependen del HAL del OEM)               |
| GPU%                         | sysfs por SoC (kgsl / mali / samsung)                     | ídem                                | ídem                                        | Baja (best-effort, probar rutas)                        |
| Network per-uid              | `/proc/net/xt_qtaguid/stats` (realtime) o netstats        | `dumpsys netstats detail` (buckets) | `dumpsys netstats detail` (buckets)         | Media (campos rb/tb estables; granularidad por buckets) |

## Decisión primaria/fallback por collector

| Collector | Primaria                                                                | Fallback                                                                              | Nota doctor                                                        |
| --------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `mem`     | App Summary de `dumpsys meminfo <pkg>`                                  | tabla detallada (fila TOTAL)                                                          | Graphics=0 ⇒ memtrack HAL ausente, marcar N/A                      |
| `fps`     | `SurfaceFlinger --timestats` (enable al start, dump por muestra/cierre) | `--latency '<layer>'` con layer de `--list`; **nunca gfxinfo** para evermore          | verificar que aparece layer `SurfaceView[com.evermore.oda.qa/...]` |
| `cpu`     | delta `/proc/<pid>/stat` vs `/proc/stat`                                | — (`top -b` solo sanity)                                                              | validar USER_HZ=100 y ncores                                       |
| `temp`    | `dumpsys thermalservice` (mType 0/1/2/3)                                | `/sys/class/thermal/*` → `dumpsys battery`                                            | normalizar unidades sysfs (m°C vs deci-°C)                         |
| `gpu`     | kgsl `gpubusy`                                                          | `gpu_busy_percentage` → `/sys/kernel/gpu/gpu_busy` → `mali0/device/utilization` → N/A | guardar ruta elegida en metadata                                   |
| `net`     | `dumpsys netstats detail` (delta de sesión por uid)                     | `xt_qtaguid/stats` si legible (26–27)                                                 | granularidad bucket ⇒ no realtime                                  |

## Fuentes consultadas

- [developer.android.com — dumpsys (meminfo/gfxinfo/netstats)](https://developer.android.com/tools/dumpsys)
- [developer.android.com — Frame Rate for games (`SurfaceFlinger --timestats`)](https://developer.android.com/games/optimize/framerate)
- [Testing Display Performance (doc oficial archivada — columnas framestats)](https://iut-fbleau.fr/docs/android/training/testing/performance.html)
- [perfetto.dev — Android Jank detection with FrameTimeline](https://perfetto.dev/docs/data-sources/frametimeline)
- [perfetto.dev — Debugging memory usage on Android](https://perfetto.dev/docs/case-studies/memory)
- [source.android.com — eBPF network traffic monitoring](https://source.android.com/docs/core/data/ebpf-traffic-monitor)
- [source.android.com — Thermal mitigation (Thermal HAL 2.0, Android 10)](https://source.android.com/docs/core/power/thermal-mitigation)
- [AOSP — android.os.Temperature (TYPE__/THROTTLING__)](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/os/Temperature.java)
- [AOSP — SurfaceFlinger TimeStats](https://android.googlesource.com/platform/frameworks/native/+/master/services/surfaceflinger/TimeStats/TimeStats.cpp)
- [AOSP — formato `--latency` (frameworks/native)](https://android.googlesource.com/platform/frameworks/native/+/82d7ab6%5E!/)
- [Unity Discussions — no PROFILEDATA en apps Unity](https://discussions.unity.com/t/no-profiledata-is-being-generated-by-the-adb-shell-dumpsys-gfxinfo-package-name-framestats-command/345753)
- [testerhome — gfxinfo/latency sin datos en Unity](https://testerhome.com/topics/40129)
- [issuetracker.google.com/247465689 — `--latency` en Android 12](https://issuetracker.google.com/issues/247465689)
- [alibaba/mobileperf fps.py — parsing --latency + pending fence + fallback framestats](https://github.com/alibaba/mobileperf/blob/master/mobileperf/android/fps.py)
- [Qualcomm — Verify GPU usage (kgsl)](https://docs.qualcomm.com/bundle/publicresource/topics/80-88500-3/12_Check_GPU_usage.html)
- [Arm Community — GPU usage/load en Android (Mali)](https://community.arm.com/support-forums/f/mobile-graphics-and-gaming-forum/3642/how-do-we-check-the-gpu-usage-load-for-android)
- [Imagination forums — GPU utilization PowerVR (debugfs/PVRScope)](https://forums.imgtec.com/t/gpu-utilization/3506)
- [XDA — NOROOT Temperatures (mName por OEM, ej. Samsung A52)](https://xdaforums.com/t/noroot-temperatures.4763662/)
- [Gracker/Android-App-Memory-Analysis (categorías meminfo 4.0→17)](https://github.com/Gracker/Android-App-Memory-Analysis)
- [man7 — proc(5) (/proc/stat, /proc/pid/stat)](https://man7.org/linux/man-pages/man5/proc.5.html)
- [landley.net — toybox help (top/ps)](https://landley.net/toybox/help.html)
