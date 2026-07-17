---
id: 2
title: Research formatos de dumpsys por versión Android y OEM
label: wayfinder:research
status: closed
assignee: agent-research
blocked-by: []
---

## Question

¿Cómo varían entre versiones de Android (API 26→35) y OEMs (Samsung, Xiaomi, Pixel, etc.)
los formatos de salida que vamos a parsear, y qué fuentes existen por familia de SoC para
las métricas best-effort?

Cubrir:

1. `dumpsys meminfo <pkg>`: cambios de categorías/columnas por API level (Java Heap /
   Native / Graphics / Code / Stack / Private Other).
2. `dumpsys gfxinfo <pkg>` y `framestats`: qué campos son estables, cómo calcular FPS,
   jank% y percentiles p50/p90/p99 correctamente, diferencias HWUI vs apps Unity
   (¿reporta frames de Unity? verificar alternativa `dumpsys SurfaceFlinger --latency`).
3. CPU por proceso: `top -b` vs `/proc/<pid>/stat` + `/proc/stat` — cuál normaliza mejor
   por cores y qué formato tiene cada Android.
4. Temperatura: `dumpsys thermalservice` (API 29+) vs `/sys/class/thermal/*` — mapeo de
   thermal zones típicas (cpu, gpu, battery, skin) por OEM.
5. GPU%: fuentes por SoC — Qualcomm `/sys/class/kgsl/kgsl-3d0/gpubusy`, Mali
   `/sys/class/misc/mali0/`, Samsung Xclipse, PowerVR — cuáles son legibles sin root.
6. Network por-uid: `/proc/net/xt_qtaguid/stats` (deprecado ¿desde qué API?) vs
   `dumpsys netstats detail` vs `cat /proc/uid_stat/<uid>/` — qué usar por API level.

Entregable: markdown `evermore/profiler/docs/research/dumpsys-formats.md` con tabla
fuente-por-métrica-por-API y decisión de qué fuente primaria/fallback usa cada collector.

## Resolution (2026-07-16)

Doc completo: [`docs/research/dumpsys-formats.md`](../../research/dumpsys-formats.md)
(tabla fuente-por-métrica-por-API, decisión primaria/fallback por collector, snippets y fuentes).

Conclusiones clave:

1. **Veredicto Unity/gfxinfo (hallazgo #1): `dumpsys gfxinfo` NO ve los frames de evermore.**
   gfxinfo/framestats instrumenta HWUI; Unity renderiza GL/Vulkan sobre SurfaceView y no emite
   `---PROFILEDATA---` (confirmado en Unity Discussions y testerhome). El collector de FPS usa
   **`dumpsys SurfaceFlinger --timestats -clear -enable` / `-dump`** (método oficial de Google
   para juegos: da `averageFPS`, `totalFrames` e histograma `presentToPresent` por layer →
   FPS + p50/p90/p99 + jank%), con fallback `SurfaceFlinger --latency '<layer>'` (layer
   descubierto en runtime vía `--list`; nombres cambian a `SurfaceView[...](BLAST)#id` en
   API 31+). Perfetto FrameTimeline (12+) hoy no soporta SurfaceView → tampoco sirve para v1.
2. **meminfo:** parsear el bloque `App Summary` (Java Heap/Native Heap/Code/Stack/Graphics/
   Private Other/System/TOTAL) — estable desde API 24, cubre todo el rango 26→35; tolerar la
   columna `Rss(KB)` extra que aparece ~API 29+. `Graphics`=0 ⇒ memtrack HAL ausente (marcar
   N/A, no 0).
3. **CPU:** primaria `/proc/<pid>/stat` (utime+stime, campos 14/15) vs `/proc/stat` en deltas —
   formato kernel idéntico en todas las versiones/OEMs y ya normalizado por cores
   (share-of-device 0–100%). `top -b` (toybox desde API 26) queda solo como sanity check:
   su %CPU es por-core y su layout cambió entre releases.
4. **Temperatura:** primaria `dumpsys thermalservice` (API 29+, Thermal HAL 2.0) parseando
   `Temperature{mValue=.., mType=..}` y mapeando **por mType** (0=CPU,1=GPU,2=BAT,3=SKIN) —
   mName es del OEM (Samsung `AP/BAT/PA`, etc.). Fallback API 26–28: `/sys/class/thermal/*`
   (nombres de zona 100% OEM, normalizar m°C/deci-°C) y `dumpsys battery` como piso garantizado.
5. **GPU%:** solo sysfs del vendor, sin API pública. Orden de probing: Qualcomm
   `/sys/class/kgsl/kgsl-3d0/gpubusy` (dos ints busy/total; documentado por Qualcomm, legible
   sin root) → `gpu_busy_percentage` → Samsung `/sys/kernel/gpu/gpu_busy` (Mali/Xclipse) →
   `mali0/device/utilization`; PowerVR es debugfs/root ⇒ N/A en v1.
6. **Network per-uid:** `/proc/net/xt_qtaguid/stats` solo sirve API 26–27 (eBPF lo reemplaza
   desde API 28 y se remueve después; los mapas eBPF son root-only). Primaria para todo el
   rango: `dumpsys netstats detail` sumando buckets del uid — pero son buckets históricos
   (~2 h, actualizados por polling), o sea sirve para el **total de sesión**, no para gráfico
   realtime por segundo.
7. **Patrón general:** los formatos "estables" son los de kernel (`/proc`) y los bloques con
   labels (`App Summary`, `Temperature{...}`); las tablas posicionales y `top` cambian entre
   versiones. Cada collector queda con primaria+fallback y el `doctor` debe probar la fuente
   real en el device y registrar la elegida en la metadata de sesión.
