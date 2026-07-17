# Fixtures: SM-A155M (API 36)

Outputs **crudos** de adb, sin procesar — capturados con `bun scripts/capture-fixtures.ts`
(ticket 001). Son la fuente de verdad de los parsers (tests capa 1) y el material de
replay de fake-adb. No editar a mano.

**PII redactada** (checklist de scrub para toda captura nueva antes de commitear):
serial (`ro.serialno`, `ro.boot.serialno`, `ro.boot.ap_serial`), `subscriberId` (netstats),
SSID del wifi (`wifiNetworkKey` en netstats), `ro.boot.em.did` y `ro.boot.kg.ap` (getprop).

## Device

| Campo | Valor |
|---|---|
| Modelo | SM-A155M |
| Marca / fabricante | samsung / samsung |
| Android | 16 (API 36) |
| SoC | Mediatek MT6789 |
| GPU | ARM, Mali-G57 MC2, OpenGL ES 3.2 |
| Serial | REDACTED-SERIAL |
| Fecha de captura | 2026-07-17T12:03:42.552Z |
| Package medido | com.evermore.oda.qa |

## Estructura

- `oneshot/` — una pasada de cada comando (getprop, meminfo, cpuinfo, top, proc, thermal, GPU probing, netstats, SurfaceFlinger, gfxinfo).
- `session/tick-NNN/` — sesión de 30 s a 1 Hz mientras se jugaba (30 ticks: meminfo, proc-stat, thermal, gpubusy, netstats).
- `session/final/` — `SurfaceFlinger --timestats -dump` + `--latency` del layer del SurfaceView al cierre.
- Fuente GPU% elegida: /sys/kernel/gpu/gpu_busy.
- Layer SurfaceFlinger de la app: `RequestedLayerState{ca6669f SurfaceView[com.evermore.oda.qa/com.google.firebase.MessagingUnityPlayerActivity]@0(BLAST)#1523 parentId=1522}`.

## Comandos que fallaron (los N/A de este device)

Los `.err.txt` guardan exit code + stderr: también son fixtures — los parsers deben
tratar estos casos como "métrica no disponible", no como error fatal.

- `oneshot/thermal-zone-types.err.txt` — `grep . /sys/class/thermal/thermal_zone*/type` → exit 2: grep: /sys/class/thermal/thermal_zone*/type: No such file or directory
- `oneshot/thermal-zone-temps.err.txt` — `grep . /sys/class/thermal/thermal_zone*/temp` → exit 2: grep: /sys/class/thermal/thermal_zone*/temp: No such file or directory
- `oneshot/gpu-kgsl-ls.err.txt` — `ls /sys/class/kgsl/kgsl-3d0/` → exit 1: ls: /sys/class/kgsl/kgsl-3d0/: No such file or directory
- `oneshot/gpu-kgsl-gpubusy.err.txt` — `cat /sys/class/kgsl/kgsl-3d0/gpubusy` → exit 1: cat: /sys/class/kgsl/kgsl-3d0/gpubusy: No such file or directory
- `oneshot/gpu-kgsl-gpu-busy-percentage.err.txt` — `cat /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage` → exit 1: cat: /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage: No such file or directory
- `oneshot/gpu-mali-utilization.err.txt` — `cat /sys/class/misc/mali0/device/utilization` → exit 1: cat: /sys/class/misc/mali0/device/utilization: No such file or directory
