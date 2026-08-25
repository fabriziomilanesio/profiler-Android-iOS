---
id: 1
title: Capturar fixtures crudos de adb del device real
label: wayfinder:task
status: closed
assignee:
blocked-by: []
---

## Question

Con un device Android enchufado (idealmente el de QA con `com.sample.oda.qa` instalada),
capturar y commitear como fixtures los outputs crudos que los parsers van a consumir:

- `adb shell dumpsys meminfo <pkg>` (con la app corriendo)
- `adb shell dumpsys cpuinfo` y `adb shell top -b -n 1` (y `/proc/<pid>/stat`)
- FPS (Unity no aparece en gfxinfo — ver docs/research/dumpsys-formats.md):
  `dumpsys SurfaceFlinger --list` (descubrir el layer del SurfaceView),
  `dumpsys SurfaceFlinger --timestats -clear -enable` … jugar … `--timestats -dump`,
  y `dumpsys SurfaceFlinger --latency '<layer>'`; capturar también
  `dumpsys gfxinfo <pkg> framestats` igual (para documentar que viene vacío)
- `adb shell dumpsys thermalservice` y `ls/cat /sys/class/thermal/thermal_zone*/{type,temp}`
- Batería: `adb shell dumpsys battery` (level, temperature, current_now, status) — para
  drenaje %, temp de batería y mA por sesión
- Fuentes GPU: `ls /sys/class/kgsl/kgsl-3d0/` (Qualcomm) o equivalente del SoC
- `adb shell cat /proc/net/xt_qtaguid/stats` o `dumpsys netstats detail`
- `adb shell getprop` completo, `/proc/meminfo`, `dumpsys SurfaceFlinger | grep -i gles`

Guardarlos en `sample/profiler/fixtures/<device-model>-api<NN>/` con un README que anote
modelo, Android, SoC. También grabar una "sesión" temporal: los mismos comandos muestreados
~30s a 1 Hz mientras se juega, para que fake-adb tenga material de replay realista.

Es task manual-asistida: el agente automatiza el script de captura; el humano enchufa el
device y juega la app durante la captura.

## Estado (2026-07-17) — CERRADO

**Captura real hecha** sobre el Galaxy A15 (SM-A155M, MT6789/Mali-G57, API 36):
`fixtures/sm-a155m-api36/` con oneshot + sesión de 30 ticks + final, PII redactada
(ver checklist en el README de fixtures). Los parsers se testean contra estos fixtures.

## Estado previo (2026-07-16)

**La mitad automatizable está lista** — falta solo el device real, por eso el ticket
sigue `open`.

- `scripts/capture-fixtures.ts` implementado sobre la costura existente
  (`RealAdbTransport` + `discoverAdb` + preflight del ticket 013). Cubre todo lo de
  arriba: one-shot completo (getprop, meminfo, cpuinfo, top, /proc, thermal + sysfs,
  probing GPU kgsl/Samsung/Mali, netstats, SurfaceFlinger --list, gfxinfo framestats,
  GLES), sesión 1 Hz con `--timestats -clear -enable` al inicio y `-dump` + `--latency`
  del layer del SurfaceView (descubierto vía `--list`) al cierre, y README.md del dir
  de fixtures con ficha del device + comandos que fallaron (los N/A). Los fallos se
  guardan como `.err.txt` — también son fixtures.
- Lógica pura en `scripts/capture-plan.ts` testeada con `bun:test`
  (`scripts/capture-plan.test.ts`); typecheck limpio; verificado que sin device el
  script falla limpio en el preflight (exit 1 + remedio).

**Comando a correr mañana con el device QA enchufado (depuración USB activa y
`com.sample.oda.qa` instalada):**

```bash
cd sample/profiler
bun scripts/capture-fixtures.ts
# opcionales: --package <pkg> --serial <X> --session-seconds 30 --adb <ruta>
```

El script pide abrir la app (espera hasta 60 s el pid) y avisa cuándo jugar durante la
sesión de 30 s. Al terminar: revisar `fixtures/<modelo>-api<NN>/README.md` y commitear
el directorio de fixtures.

**El ticket queda abierto esperando el device real.**
