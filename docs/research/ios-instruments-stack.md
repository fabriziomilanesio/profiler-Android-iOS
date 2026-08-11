# Stack de profiling iOS — RemoteXPC, DTX y `pymobiledevice3`

Research del ticket 044, hecho la noche del **2026-08-10** para desriesgar el spike del
ticket 033. Sale de leer el código fuente de `pymobiledevice3` en el commit `e371828`
(2026-08-10) y su documentación oficial.

> **Verificado contra device real esa misma noche** (iPhone15,3 · iOS 26.5.2 ·
> `pymobiledevice3` 10.7.2 · host macOS). El spike 033 confirmó los tres hallazgos de la
> sección 1 y corrigió cuatro cosas que este research daba por buenas — están marcadas
> ⚠️ **CORREGIDO** donde corresponde, y el detalle completo está en el ticket 033.

Equivalente iOS de [`dumpsys-formats.md`](dumpsys-formats.md), que hizo lo mismo para Android.

---

## 1. Tres hallazgos que cambian decisiones del grilling

### 1.1 El túnel NO necesita root en iOS 17.4+ — el modelo de servicio elevado puede sobrar

En el grilling del 2026-08-10 dimos por sentado que el túnel RemoteXPC exige privilegios
elevados siempre, y sobre eso se decidió instalar `remote tunneld` como servicio (ticket
041, pregunta 3 del grilling). **Es falso para iOS 17.4+.**

`pymobiledevice3` trae un **túnel userspace sin root**: reemplaza la interfaz `utun` del
kernel por un stack TCP/IP puro-Python (PyTCP). De su propio docstring
(`pymobiledevice3/remote/userspace_tunnel.py`):

> The standard tunnel writes raw IPv6 packets to a kernel `utun`, which needs admin/root.
> This backend replaces the kernel interface with a pure-Python TCP/IP stack (PyTCP) so the
> tunnel and all host-initiated RSD developer services run as a normal user.

Y `cli_common` lo levanta **solo**, sin que el usuario pida nada: cualquier
`pymobiledevice3 developer dvt …` abre su túnel in-process y lo cierra al terminar.

**La limitación que parecía descalificarlo, en nuestro caso no aplica.** La doc advierte
que la dirección del túnel "vive únicamente dentro del proceso de `pymobiledevice3` y no
es alcanzable desde ningún otro proceso". Eso mata a `lldb` y a herramientas externas —
pero **nuestro modelo es exactamente ese**: el profiler spawnea un `pymobiledevice3` de
larga duración y lee su stdout línea por línea, igual que hoy `AdbTransport.streamShell()`
spawnea `adb logcat`. El túnel vive dentro del hijo, que es quien lo usa.

**Consecuencia para el 041**: el escalón de "instalar un servicio elevado" pasa de
requisito a **fallback**. El spike (033) tiene que probar **primero** el camino userspace.
Si funciona, desaparecen el servicio residente, el `DESINSTALAR.bat`, el adaptador TUN y
toda la discusión de permisos de admin.

### 1.2 `wintun` viene adentro del pip install

El installer no tiene que bajar `wintun.dll` por separado: `pymobiledevice3` depende de
`pytun-pmd3>=3.0.3`, que **empaqueta el wintun** (`site-packages/pytun_pmd3/wintun/bin`,
visible en el `generate-executable.py` del repo). Un paso menos en `INSTALAR.bat` — y si
el camino userspace del 1.1 funciona, ni siquiera se usa.

### 1.3 No hay binario prebuilt oficial

El release `v10.7.2` (2026-08-10) **no publica assets**. El repo tiene receta de
PyInstaller (`misc/pyinstaller.md`, `.github/workflows/generate-executable.py`) pero no
distribuye el ejecutable. Confirma la decisión (b) del grilling: el installer instala
Python + pip. Congelarlo nosotros seguiría siendo posible, pero es infra propia a mantener.

---

## 2. Capas del stack

```
usbmux (AppleMobileDeviceService en Windows / usbmuxd en macOS)
  └── lockdownd            ── servicios "clásicos": syslog, crash reports, diagnostics
        └── RSD / RemoteXPC  ── iOS 17+: el túnel
              └── DTX        ── com.apple.instruments.server.services.*
                    ├── sysmontap          CPU + memoria por proceso y del sistema
                    ├── graphics.opengl    FPS + GPU
                    ├── device_info        ficha, y la lista de atributos soportados
                    ├── core_profile_session_tap   kdebug crudo (ticket 043)
                    ├── network_monitor    conexiones
                    └── process_control    lanzar/matar la app
```

Lo importante de la separación: **batería, syslog y crash reports son lockdown, no DTX**.
No dependen del túnel ni del DDI, así que pueden funcionar aunque el camino DTX falle.
Es el "escalón 2" del corte de métricas, y es independiente por construcción.

## 3. Modos de túnel

| Modo                    | Comando                                      | Root   | Persistente | Sirve a otros procesos |
| ----------------------- | -------------------------------------------- | ------ | ----------- | ---------------------- |
| **Userspace (default)** | ninguno — implícito                          | **No** | por comando | No                     |
| lockdown start-tunnel   | `sudo pymobiledevice3 lockdown start-tunnel` | Sí     | manual      | Sí                     |
| remote start-tunnel     | `sudo pymobiledevice3 remote start-tunnel`   | Sí     | manual      | Sí                     |
| tunneld daemon          | `sudo pymobiledevice3 remote tunneld`        | Sí     | Sí          | Sí                     |

- `--userspace` fuerza el userspace y saltea el fallback a tunneld.
- `PYMOBILEDEVICE3_PREFER_TUNNELD=1` hace lo contrario.
- `tunneld` expone HTTP en **`127.0.0.1:49151`** (`TUNNELD_DEFAULT_ADDRESS`), con
  `GET /` (mapa UDID → túneles), `GET /start-tunnel?udid=`, `GET /cancel?udid=`,
  `GET /clear_tunnels`, `GET /shutdown`. Ese `GET /` es el análogo de `adb devices` que
  el ticket 035 quiere para `devices()`/`trackDevices()` — **sólo si vamos por tunneld**.
  En el camino userspace, el descubrimiento es `pymobiledevice3 usbmux list`.
- Pareo sin diálogo de Trust en pantalla, sobre USB ya confiado:
  `pymobiledevice3 lockdown remotepairing --pair`.
- En macOS, `tunneld` suspende el daemon `remoted` del sistema para no competir en el
  handshake RSD. Detalle a tener en cuenta si algo más en la Mac habla con el device.

## 4. Comandos por métrica

⚠️ **CORREGIDO por el spike**: no todos imprimen JSON por línea. `graphics`,
`diagnostics battery monitor` y `syslog live` sí (y los consume el `streamLines` actual sin
cambios), pero **`sysmon process monitor process` imprime JSON pretty multi-línea** — hay
que parsearlo por bloques o usar la API Python. Verificado contra el device.

⚠️ **CORREGIDO**: con **más de un device conectado** (o el mismo por USB y wifi) _todos_
los comandos abortan con "interactive selection requires a terminal". Hay que fijar
`--udid` o `PYMOBILEDEVICE3_UDID` siempre — no es opcional en la práctica.

| Métrica                      | Comando                                                                                                                                     | Capa     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| CPU + memoria por proceso    | `pymobiledevice3 developer dvt sysmon process monitor process --filter name=<app> --key cpuUsage --key physFootprint --key memResidentSize` | DTX      |
| CPU + memoria del sistema    | `pymobiledevice3 developer dvt sysmon system`                                                                                               | DTX      |
| Lista de procesos (una foto) | `pymobiledevice3 developer dvt sysmon process single`                                                                                       | DTX      |
| **FPS + GPU**                | `pymobiledevice3 developer dvt graphics`                                                                                                    | DTX      |
| Ficha del device             | `pymobiledevice3 developer dvt device-information`                                                                                          | DTX      |
| Batería                      | `pymobiledevice3 diagnostics battery monitor`                                                                                               | lockdown |
| Logs de la app               | `pymobiledevice3 syslog live --process-name <app>` (además `--match`, `--match-insensitive`)                                                | lockdown |
| **Crashes en vivo**          | `pymobiledevice3 crash watch`                                                                                                               | lockdown |
| Crashes (bajar)              | `pymobiledevice3 crash pull <dir>`, `crash ls`, `crash parse-latest`                                                                        | lockdown |
| Energía por pid              | `pymobiledevice3 developer dvt energy <pid>`                                                                                                | DTX      |
| Red                          | `pymobiledevice3 developer dvt netstat`                                                                                                     | DTX      |
| Frame-times (ticket 043)     | `pymobiledevice3 developer dvt core-profile-session parse-live` / `save <file>`                                                             | DTX      |
| Montar DDI                   | `pymobiledevice3 mounter auto-mount`                                                                                                        | lockdown |
| Devices conectados           | `pymobiledevice3 usbmux list`                                                                                                               | usbmux   |

**`crash watch` resuelve el problema de timing que anoté en el ticket 039**: creía que en
iOS el crash sólo aparecía como archivo después del hecho, lo que rompía la marca en vivo
sobre el timeline. Hay un stream. El modelo del 027 (crash stream separado, adjudicado por
pid/package) se traslada casi tal cual.

## 5. Campos

### `sysmontap` — el device declara sus propias capacidades

`Sysmontap.create()` **no hardcodea la lista de atributos**: le pregunta al device vía
`DeviceInfo.sysmon_process_attributes()` y `sysmon_system_attributes()` y arma el sample
con lo que ese device soporte.

Esto es un regalo para el ticket 037: **el descriptor de capacidades no hay que inventarlo,
el protocolo ya lo tiene**. En Android las capacidades se descubren probando y fallando
(el probing de GPU% por SoC); en iOS se pregunta.

Campos de proceso confirmados en el fuente (`_BYTE_FIELDS` / `_NANOSECOND_FIELDS` de
`cli/developer/dvt/sysmon/process.py`), útiles para el mapeo del 037:

- **Bytes**: `physFootprint`, `memResidentSize`, `memVirtualSize`, `memAnon`,
  `memAnonPeak`, `memCompressed`, `memPurgeable`, `memRPrvt`, `memRShrd`, `wiredMemory`,
  `wiredSize`, `anonMemoryUsage`, `purgeableMemory`, `diskBytesRead`, `diskBytesWritten`.
- **Nanosegundos**: `cpuTotalUser`, `cpuTotalSystem`, `threadsUser`, `threadsSystem`, `procAge`.
- **Identidad**: `pid`, `ppid`, `name`, `uniqueID`, `parentUniqueID`.
  ⚠️ **CORREGIDO por el spike**: **iOS 26 NO expone `bundleIdentifier`** entre los
  atributos de sysmontap (aparece en los filtros de los tests de `pymobiledevice3`, pero no
  en este device). Hay que matchear por `name` de proceso, que en una app Unity es el
  nombre del ejecutable, no el bundle id. Y `monitor process` exige que el filtro resuelva
  a **un solo** proceso: sin `--choose first` aborta listando todos los matches.
- **Energía** (no tiene equivalente en Android): `powerScore`, `avgPowerScore`,
  `totalEnergyScore`.
- **Sistema**: bloque `System` + `SystemCPUUsage` con `CPUCount` y `EnabledCPUs`.

⚠️ El CLI **descarta la primera muestra de `SystemCPUUsage`** a propósito: comenta que la
primera siempre da un valor incorrecto (100 o 0). Nuestro sampler tiene que hacer lo mismo
o el primer tick de cada sesión va a mentir.

⚠️ `memResidentSize` y `physFootprint` vienen en **bytes**; el `MemSample` de Android está
en MB. La conversión va del lado del parser, no del schema.

### `graphics.opengl` — FPS y GPU

`GraphicsService` (IDENTIFIER `com.apple.instruments.server.services.graphics.opengl`)
arranca con `startSamplingAtTimeInterval:(0.0)` y empuja eventos.
`pymobiledevice3 developer dvt graphics` los imprime crudos como JSON.

El único campo que aparece en el repo (en un test) es **`CoreAnimationFramesPerSecond`**.
`pymobiledevice3` no normaliza ni documenta el resto: reenvía lo que manda el device.
**El set completo de claves sólo se conoce corriendo contra el iPhone** — es el entregable
más importante del spike 033 y el insumo directo de los fixtures del 036.

### Batería (lockdown, `IOPMPowerSource`)

`pymobiledevice3 diagnostics battery monitor` emite 1 Hz con exactamente:
`InstantAmperage`, `Temperature`, `Voltage`, `IsCharging`, `CurrentCapacity`.

Mapea casi 1:1 contra el `BatterySample` de Android (`mA`, `tempC`, `charging`,
`levelPct`). Dos cosas a verificar en el device: la unidad de `Temperature` (Android usa
deci-°C; acá probablemente centi-°C) y si `CurrentCapacity` viene en % o en mAh —
si es mAh hace falta `MaxCapacity` para sacar el porcentaje.

## 6. Windows

- **Requisito no vendorizable**: el servicio usbmux de Apple (`AppleMobileDeviceService`),
  que llega con iTunes o con la app "Apple Devices" de la Store.
- `wintun` viene dentro de `pytun-pmd3` (ver 1.2) — y sólo hace falta para el túnel
  **kernel**, no para el userspace.
- Issues abiertos que conviene tener a mano si el spike se traba:
  [#832](https://github.com/doronz88/pymobiledevice3/issues/832) (túnel wintun que se
  cierra solo en Windows 10), [#1046](https://github.com/doronz88/pymobiledevice3/issues/1046)
  ("Device Not Connected" en Windows), [#1217](https://github.com/doronz88/pymobiledevice3/issues/1217)
  (`OSError: [WinError 1231]` en comandos developer).
- Los tres son del camino **kernel/tunneld**. Otra razón para probar userspace primero.

## 7. Versión

- Última: **10.7.2**, publicada el **2026-08-10** (el mismo día de este research).
- Requiere **Python ≥3.9** (soporta hasta 3.14). El `INSTALAR.bat` puede instalar
  cualquier Python 3 moderno de winget sin pelear con el rango.
- **Pinear** a la versión que valide el spike (R4). El proyecto se mueve rápido: el commit
  de referencia de este research es del mismo día del release.

## 8. Lo que este research NO contesta — trabajo del spike 033

1. **El set completo de claves de `graphics.opengl`.** Es lo único que bloquea el diseño
   del `FrameSample`/GPU de iOS. Sin el device no hay forma de saberlo.
2. **Si el túnel userspace alcanza para una sesión larga** (30+ min) sin degradarse. Un
   stack TCP/IP en Python compitiendo con un profiler es un riesgo de performance real y
   no documentado.
3. **Si `graphics` y `sysmon` pueden correr simultáneos** — dos procesos
   `pymobiledevice3`, cada uno con su propio túnel userspace, contra el mismo device.
   Si no se puede, hay que ir a la API Python en un solo proceso, o a tunneld.
4. **Overhead en el device.** La restricción transversal de la iteración 2 ("cero overhead
   nuevo") se mide acá igual que en el 023.
5. **Unidades de batería** (`Temperature`, `CurrentCapacity`) y normalización de
   `cpuUsage` (¿por core, puede pasar de 100?) — decide la comparabilidad del 037.
6. **Si el DDI se auto-monta** en iOS 18+ o hay que llamar `mounter auto-mount` explícito.

## Fuentes

- [pymobiledevice3 — repo](https://github.com/doronz88/pymobiledevice3) (commit `e371828`, 2026-08-10)
- [Guía oficial de túneles iOS 17+](https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/ios17-tunnels.md)
- [CLI recipes](https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/cli-recipes.md)
- [Remote Access and Tunneling (DeepWiki)](<https://deepwiki.com/doronz88/pymobiledevice3/3-remote-access-and-tunneling-(ios-17+)>)
- [pymobiledevice3 en PyPI](https://pypi.org/project/pymobiledevice3/) — v10.7.2
- Fuente leído directo: `remote/userspace_tunnel.py`, `tunneld/api.py`,
  `services/dvt/instruments/{graphics,sysmontap}.py`, `cli/developer/dvt/__init__.py`,
  `cli/developer/dvt/sysmon/process.py`, `cli/diagnostics/battery.py`, `cli/crash.py`,
  `cli/syslog.py`, `pyproject.toml`.
