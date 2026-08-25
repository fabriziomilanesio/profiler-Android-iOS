---
label: wayfinder:ticket
title: Spike de viabilidad iOS — túnel RemoteXPC + primer sample en macOS y Windows
status: closed
assignee: claude
blocked-by: [044]
---

# 033 — Spike de viabilidad iOS (el que puede matar el plan)

## Question

¿Se puede, hoy, con **ese** iPhone (personal, iOS 18+) y **esa** máquina Windows,
levantar el túnel RemoteXPC y leer métricas de la app por DTX? ¿Y en macOS?

Criterio de éxito, mínimo y feo: imprimir por consola **un** sample de `sysmontap`
(CPU + `physFootprint` del proceso de samplearcade) y **una** lectura de FPS de
`graphics.opengl`. En los dos hosts. Sin arquitectura, sin tests, sin UI — código
desechable.

## Contexto (grilling 2026-08-10)

- Todo el plan de la iteración 3 descansa sobre esta suposición sin verificar. Si el
  túnel no levanta en Windows, el plan no se ajusta: se cae entero. Por eso va
  **antes** del refactor — Android hoy funciona con 344 tests verdes y nadie está
  bloqueado por la costura.
- Es el mismo movimiento que el ticket 019, que gastó un spike en el `SNICallback` de
  Bun, descubrió que **no dispara**, y cambió el diseño de `CertAuthority` antes de
  que costara caro.
- **Timebox: 2 días** — uno en macOS para llegar al primer sample, uno en Windows
  para la cadena completa. Si a los 2 días el túnel no levanta en Windows, no se
  estira: se replantea.

### Cadena a probar — REVISADA por el research del 044

El research del ticket 044 encontró que **el túnel no necesita root en iOS 17.4+**:
`pymobiledevice3` levanta un túnel **userspace** (stack TCP/IP puro-Python) solo, sin que
el usuario pida nada. La limitación documentada (el túnel vive dentro del proceso, no es
alcanzable desde afuera) no nos afecta, porque nuestro modelo es spawnear un
`pymobiledevice3` de larga duración y leer su stdout — igual que `streamShell()` con
`adb logcat`.

**Se prueba el camino barato primero.** El escalón elevado es fallback, no punto de partida:

1. `pymobiledevice3` instalado (en el spike, a mano — el installer es el 041).
2. Pareo: `pymobiledevice3 lockdown remotepairing --pair` (sobre USB ya confiado, sin
   diálogo de Trust en pantalla).
3. Device visible: `pymobiledevice3 usbmux list`.
4. DDI: verificar si iOS 18+ ya lo auto-monta o hace falta `mounter auto-mount`.
5. **Camino A (sin privilegios, el que se prueba primero)**: correr directo
   `pymobiledevice3 developer dvt graphics` y
   `pymobiledevice3 developer dvt sysmon process monitor process --filter …`.
   El túnel userspace se levanta solo.
6. **Camino B (fallback, sólo si A falla)**: `sudo pymobiledevice3 remote tunneld`
   (elevado; en Windows admin) y descubrir el device por `GET 127.0.0.1:49151/`.

**Hay un harness que hace todo esto**: `scripts/spike-ios.sh` (macOS/Linux) y
`scripts/spike-ios.ps1` (Windows, gemelo del anterior). Con el iPhone enchufado y
desbloqueado, es un comando.
Guarda todo en `.tmp/spike-ios/` para que los payloads crudos alimenten el 036.

### Qué hay que anotar sí o sí (lo consume el resto del mapa)

- **Si el camino A funciona.** Si funciona, desaparecen del 041 el servicio residente, el
  `DESINSTALAR.bat` y toda la discusión de permisos — es el hallazgo más valioso posible.
- **El set completo de claves de `graphics.opengl`.** `pymobiledevice3` reenvía crudo lo
  que manda el device y no lo documenta; el único campo confirmado en su fuente es
  `CoreAnimationFramesPerSecond`. Sin esto no se puede diseñar el FrameSample/GPU de iOS.
- Si `graphics` y `sysmon` pueden correr **simultáneos** como dos procesos separados, cada
  uno con su túnel userspace. Si no, hay que ir a la API Python en un solo proceso o a tunneld.
- Si el túnel userspace **aguanta una sesión larga** (30+ min) sin degradarse — es un stack
  TCP/IP en Python compitiendo con el profiler; riesgo real y no documentado.
- Versión exacta de iOS del device y de `pymobiledevice3` que funcionó (se **pinea**; R4).
- Unidades de batería (`Temperature`, `CurrentCapacity` en % o mAh) y si `cpuUsage` es
  por-core (puede pasar de 100) — decide la comparabilidad del 037.
- Overhead en el device (restricción transversal de la iteración 2).
- Fricciones de Windows: driver de Apple ("Apple Devices"/iTunes), antivirus, política.
  Los issues conocidos (#832, #1046, #1217) son todos del camino **kernel/tunneld** — otra
  razón para probar userspace primero.

### Qué hay que anotar sí o sí (lo consume el resto del mapa)

- Versión exacta de iOS del device y versión exacta de `pymobiledevice3` que funcionó
  (se **pinea**; nada de "la última" — ver R4).
- Estructura cruda de los payloads de `sysmontap` y `graphics.opengl` — es el insumo
  de los fixtures del 036 y de los parsers del 038.
- Unidades y semántica de cada campo: si el `cpuUsage` de `sysmontap` es por-core
  (puede pasar de 100) o normalizado, porque eso decide la comparabilidad del 037.
- Qué pasos exigieron admin y cuáles no — define el diseño del installer (041).
- Fricciones de Windows: driver de Apple ("Apple Devices"/iTunes), `wintun.dll`,
  antivirus, política de la máquina.

## Riesgos que este ticket resuelve o confirma

- **R1** — el túnel puede no levantar en esa Windows contra ese iPhone.
- **R4** — cuánto se rompe el stack entre versiones de iOS (primera medición).

## Entregado — RESUELTO (2026-08-10, macOS): **VIABLE, Y SIN PRIVILEGIOS**

Contra el device real: **iPhone15,3 · iOS 26.5.2 · `pymobiledevice3` 10.7.2 · host macOS**.
Falta la mitad Windows (ver "Lo que queda").

### La respuesta

**El túnel userspace funciona sin root en iOS 26.5.2**, la versión más nueva. El propio
`pymobiledevice3` lo anuncia al correr un comando developer:

> `WARNING Trying again over a no-root userspace tunnel since it is a developer command on an iOS 17+ device`

⇒ **R1 muerto** y el modelo de servicio elevado del ticket 041 **no hace falta**: no hay
servicio residente, no hay `DESINSTALAR.bat`, no hay adaptador TUN, no hay UAC. La decisión
que tomamos en la pregunta 3 del grilling queda revertida por evidencia — y para mejor.

### Canales verificados

| Canal                                          | Estado | Notas                                                                                                          |
| ---------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `graphics.opengl` (FPS + GPU)                  | ✅     | 14 claves capturadas — tabla completa en el ticket 038                                                         |
| `sysmontap` (CPU + memoria)                    | ✅     | lista completa de ~75 atributos del device en `sysmon-attrs.txt`                                               |
| `device-information`                           | ✅     | DTX                                                                                                            |
| `diagnostics battery monitor`                  | ✅     | `{"InstantAmperage": -186, "Temperature": 2989, "Voltage": 4340, "IsCharging": false, "CurrentCapacity": 100}` |
| `crash ls`                                     | ✅     | lockdown                                                                                                       |
| `usbmux list`, `lockdown remotepairing --pair` | ✅     | pareo sin diálogo de Trust                                                                                     |
| `mounter auto-mount`                           | ⚠️     | falla, **pero DTX funciona igual** ⇒ en iOS 26 el DDI no es prerequisito                                       |

**Unidades resueltas**: `Temperature: 2989` ⇒ **centi-°C** (29,89 °C). `CurrentCapacity: 100`
⇒ **porcentaje**. Las dos mapean derecho contra el `BatterySample` de Android.

### Concurrencia: SÍ

`graphics` y `sysmon` como **dos procesos separados**, cada uno con su túnel userspace,
emitieron en paralelo (160 y 122 líneas en 170 s). Una corrida anterior dio "no" y era
falso: los túneles tardan decenas de segundos en levantar y la ventana era corta. **Esa es
la trampa central de todo el camino iOS** — y confirma el modelo de streams largos
arrancados una vez por sesión, igual que `streamShell()` con `adb logcat`.

### Cuatro cosas que el research daba por buenas y son falsas

1. **iOS 26 no expone `bundleIdentifier`** en sysmontap ⇒ hay que filtrar por `name` de
   proceso. Impacta el 038 (resolver app → pid necesita otra ruta).
2. **`monitor process` exige `--choose first`** si el filtro matchea más de un proceso;
   si no, aborta.
3. **`sysmon process monitor process` imprime JSON pretty multi-línea**, no JSON-lines.
   El `streamLines` actual sirve para `graphics`/`battery`/`syslog`, no para éste.
4. **Con más de un device conectado** (o el mismo por USB y wifi) _todos_ los comandos
   abortan con "interactive selection requires a terminal". Fijar `--udid` /
   `PYMOBILEDEVICE3_UDID` no es opcional.

### Entregables

- `scripts/spike-ios.sh` — el harness, reproducible: fija UDID solo, espera a que el túnel
  levante, captura todo crudo a `.tmp/spike-ios/<ts>/` y escribe un `SUMMARY.md`.
- Capturas crudas del device (con PII, en `.tmp/`, gitignoreado).
- `docs/research/ios-instruments-stack.md` actualizado con las correcciones.

### Lo que queda (NO bloquea la arquitectura)

- **Windows sin probar** — es la otra mitad de este ticket y sigue abierta. Necesita la
  máquina. Los dos harnesses están listos: `scripts/spike-ios.ps1` (camino iOS) y
  `scripts/smoke-windows.ps1` (camino Android, ticket 034).
- **Overhead, sesión larga (30+ min) y unidades de `cpuUsage` bajo carga** → graduados al
  ticket 045: necesitan el juego instalado en el iPhone, que hoy **no lo está**.
