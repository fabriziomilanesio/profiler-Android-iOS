# Mobile Profiler

Herramienta cross-platform (Windows/macOS/Linux) para **profilear apps móviles en vivo:
Android vía ADB e iOS vía pymobiledevice3**. Pensada para las apps de Sample pero sirve para
cualquiera: levantás el dashboard (con o sin teléfono conectado — se engancha solo cuando
aparece), elegís **device** y **app** desde selectores en el dashboard (las apps filtradas por
"sample" por default), ves las métricas en tiempo real, inspeccionás el tráfico de red,
grabás sesiones y exportás reportes HTML de comparación.

Un solo dashboard para las dos plataformas: **no hay que decirle qué enchufaste**. Los
teléfonos aparecen en una lista única con su plataforma, y el profiler adapta lo que mide y
lo que muestra a lo que ese device puede dar.

**Métricas en vivo:** CPU % de la app (share-of-device, con conversión "≈ X% de un core") ·
CPU % total del device · RAM de la app (PSS + composición; suma procesos hijos `pkg:*` si los
hay) · RAM usada total del device · FPS (Unity, vía SurfaceFlinger) · temperatura · GPU % ·
batería (nivel/temp/mA) · red (KB/s) · inspector de requests HTTP.

### Qué mide cada plataforma

El dashboard es **uno solo**: enchufás lo que sea y él detecta qué es. Lo que cambia es qué
puede medirse, y eso **no se disimula** — lo que la plataforma no da, el dashboard lo esconde
(un tile que nunca se va a llenar sólo genera la pregunta "¿está roto?"), mientras que lo que
existe pero falló en este tick se muestra en N/A.

| Métrica                       | Android                            | iOS                                                                             |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| FPS                           | ✅ SurfaceFlinger (capa de la app) | ✅ CoreAnimation (**del compositor**)                                           |
| Frame-times p50/p90/p99, jank | ✅ histograma present2present      | ❌ no existe el histograma                                                      |
| CPU de la app                 | ✅ `/proc/<pid>/stat`              | ✅ sysmontap                                                                    |
| CPU del device                | ✅ `/proc/stat`                    | ❌ fuera del v1 (sería un comando por tick)                                     |
| Memoria de la app             | ✅ **PSS** + java/native/graphics  | ✅ **footprint** + comprimida + RSS                                             |
| RAM usada del device          | ✅                                 | ❌ (sí la RAM **total**, para las barras)                                       |
| GPU                           | ✅ % de uso                        | ✅ % + desglose renderer/tiler                                                  |
| Temperatura                   | ✅ SoC **y** batería               | ✅ sólo batería (el SoC necesita entitlements privados)                         |
| Batería (nivel/mA/carga)      | ✅                                 | ✅                                                                              |
| Red                           | ✅ device-wide                     | ❌ fuera del v1                                                                 |
| Logs de la app + crashes      | ✅ logcat                          | ✅ syslog (⚠️ iOS suspende las apps en background: sólo emiten en primer plano) |
| Inspector HTTP                | ✅ proxy cableado por la tool      | ❌ no se puede automatizar el proxy en iOS                                      |

> **Cuidado al comparar plataformas.** El FPS de Android sale de la capa de **la app** y el de
> iOS del compositor del **sistema**; la memoria es PSS (prorratea lo compartido) contra
> footprint (lo que cuenta jetsam). Son números que responden preguntas parecidas pero no son
> intercambiables — el reporte deja comparar sesiones de distinta plataforma, con la
> advertencia a la vista.

> **Convenciones de medición.** El CPU de la app es _share-of-device_ (0–100% del teléfono
> entero, ya normalizado por cores): un thread saturando 1 de 8 cores marca 12.5%, no 100% —
> por eso el tile de CPU muestra también la conversión a "% de un core". La RAM de la app es **PSS**
> (`dumpsys meminfo`, memoria compartida prorrateada — la métrica que usa Android para decidir
> kills). Apps multi-proceso (p.ej. Chrome y sus pestañas `:sandboxed_process`) se agregan
> sumando main + hijos; el uso total del device sale de `/proc/stat` y `/proc/meminfo`
> (MemTotal − MemAvailable). Si la app muere, el profiler sigue en vivo pero **pausa la
> persistencia** (deja eventos `app-died`/`app-restarted` en el historial en vez de horas de
> ticks vacíos) y re-engancha solo cuando el proceso reaparece.
>
> **Sampling en dos carriles (bajo overhead).** El profiler mide sin exigir al device: por
> tick solo corren lecturas baratas de `/proc`/`/sys` + el dump de FPS (incluye el **RSS**
> vivo de la app, VmRSS — se ve junto a la torta de memoria), mientras que los `dumpsys`
> pesados van por un carril lento (meminfo/PSS cada ~15 s; térmica y batería cada ~10 s)
> repitiendo el último valor entre corridas. `dumpsys meminfo` cada 1 s le robaba CPU al
> juego en gama baja (contiende con el proceso vía mmap_lock) — observer effect que este
> esquema elimina. El intervalo del carril rápido es **Auto** por default: 2 s en devices
> con < 4 GB de RAM, 1 s en el resto; se puede fijar a mano en Configuración (☰).

**El dashboard** (rediseño 2026-07 — tickets 031/032) se organiza por temas, legible de un
vistazo y **dark por default** (light a un toggle, ☀️ en el header o en ☰ Configuración;
persiste): **Performance** protagonista — FPS como número grande coloreado por el semáforo
del target (pill en palabras + chip `target N` + jank%/p90/p99 de frame-time) junto a una
timeline de dos carriles con unidades reales (FPS arriba con markline del target, bandas
rojas en los tramos bajo target y marcas CRASH; GPU%/CPU% abajo, crosshair compartido) —,
**Memory & System** (donut de PSS + KPIs PSS/RSS + barras app/device, trend de PSS con
puntos ámbar de GC; tiles de CPU/Temp/Battery con barras por umbral), **Network**
(RX/TX + sparkline + inspector) y **App logs**. En el header vive un **mini-veredicto en
vivo** (`PERF GOOD / WATCH / POOR`, mismo semáforo que el reporte, sobre el FPS promedio de
los últimos 60 s + % de ticks en verde; los crashes de la sesión suman un chip rojo;
`WARMING UP` mientras junta datos).

**Stack:** TypeScript + [Bun](https://bun.sh) · UI web local (WebSocket) · Apache ECharts.

---

## Windows 11 — instalación en 3 pasos (sin conocimientos técnicos)

1. **Descargá el proyecto**: en GitHub, botón verde **Code → Download ZIP**, y descomprimilo
   (o `git clone` si sabés usarlo).
2. **Doble click en `INSTALAR.bat`** — instala solo todo lo necesario y deja el proyecto
   listo. Se corre **una sola vez**; lo que ya esté instalado lo saltea. Para Android: Bun y
   adb. Para iPhone/iPad, además: Python, `pymobiledevice3` (en un entorno propio, sin tocar
   el Python del sistema) y la app **Apple Devices** de la Microsoft Store, que trae el
   servicio con el que Windows habla con los iPhone. **Todo el bloque de iOS es opcional**:
   si algo de eso falla, Android sigue funcionando igual.
3. **Doble click en `INICIAR.bat`** — el dashboard se abre solo en el navegador. Conectá el
   teléfono por USB y listo (no importa el orden ni la marca: el dashboard detecta solo lo
   que enchufes, Android o iPhone).

**En un Android**, una sola vez: activá **Depuración USB** (Ajustes → Acerca del teléfono →
tocá 7 veces "Número de compilación" → volvé → Opciones de desarrollador → Depuración USB)
y al conectarlo aceptá el diálogo "¿Permitir depuración USB?" marcando "Permitir siempre".

**En un iPhone/iPad**, una sola vez: conectalo por USB, desbloqueá la pantalla y tocá
**"Confiar"** en el diálogo que aparece en el teléfono. Si no aparece, abrí una vez la app
_Apple Devices_ en la PC y volvé a enchufarlo. **No hace falta Mac, ni jailbreak, ni permisos
de administrador**: el túnel con el iPhone se levanta en modo usuario.

## macOS / Linux — instalación normal

```bash
# 1. Bun (runtime; si ya lo tenés, salteá):
curl -fsSL https://bun.sh/install | bash        # macOS: también `brew install oven-sh/bun/bun`

# 2. Clonar e instalar deps:
git clone git@github.com:Generic/sample-mobile-profiler.git
cd sample-mobile-profiler
bun install

# 3. Arrancar — abre el dashboard solo en el browser:
bun start
```

adb no suele hacer falta instalarlo: si tenés Android Studio lo encuentra solo, y si no,
`bun start --install-platform-tools` lo descarga (oficial de Google). El mismo paso del
teléfono de arriba (Depuración USB) aplica igual.

Las secciones que siguen detallan requisitos, flags y desarrollo.

## Requisitos

Para **ejecutarlo** hace falta exactamente esto (en Windows 11, `INSTALAR.bat` hace los
pasos 1 y 2 solo):

1. **Bun ≥ 1.3** (runtime — corre el CLI, los tests y el server del dashboard):
   - macOS/Linux: `curl -fsSL https://bun.sh/install | bash`
   - macOS con Homebrew: `brew install oven-sh/bun/bun`
   - Windows: `winget install Oven-sh.Bun` (o `powershell -c "irm bun.sh/install.ps1 | iex"`)
   - Verificar: `bun --version` (≥ 1.3).
2. **adb** (Android platform-tools). Cualquiera de estas opciones sirve — el CLI lo descubre
   solo en este orden: flag `--adb <ruta>` → env `MOBILE_PROFILER_ADB` → `PATH` → SDK de
   Android Studio → instalación managed propia:
   - No hacer nada y dejar que la tool lo baje (oficiales de Google):
     `bun run src/cli.ts --install-platform-tools`
   - macOS: `brew install --cask android-platform-tools`
   - Windows: `winget install Google.PlatformTools`
   - Ya tenés Android Studio: no hace falta nada más (lo encuentra en el SDK).
   - Verificar: `adb devices` lista tu teléfono como `device` (no `unauthorized`).
3. Un **device Android** con **depuración USB activada** (Ajustes → Opciones de desarrollador
   → Depuración USB) y autorizado (aceptar el diálogo "¿Permitir depuración USB?" al conectar).
   No hace falta tenerlo enchufado para arrancar: el dashboard queda esperando y se engancha
   solo al conectarlo.
4. Un **browser** — el dashboard es una página local (`http://localhost:4517`).

No hace falta Node, npm, ni instalar nada en el device.

### Requisitos extra para iPhone / iPad (opcional)

Sólo si vas a perfilar iOS. Nada de esto afecta al camino Android: si falta, los iPhone
simplemente no se detectan y el resto anda igual.

1. **Python 3.9+** y **`pymobiledevice3`**. En Windows lo resuelve `INSTALAR.bat` (crea un
   entorno propio en `~/.sample-profiler/pmd3-venv` para no ensuciar el Python del
   sistema). A mano: `python -m venv <ruta> && <ruta>/bin/python -m pip install pymobiledevice3`.
   El CLI lo descubre solo: `MOBILE_PROFILER_PYTHON` → venv gestionado → `python`/`python3`
   del PATH.
2. **El servicio usbmux de Apple** — el equivalente de adb para iOS, y la única pieza que no
   se puede empaquetar (viene firmada por Apple):
   - **Windows**: app **Apple Devices** de la Microsoft Store
     (`winget install --id 9NP83LWLPZ9K --source msstore`) o iTunes. Hay que **abrirla una
     vez**: instalar el paquete no alcanza, el servicio arranca recién cuando se abre la app.
   - **macOS**: ya viene con el sistema.
   - **Linux**: `usbmuxd`.
3. Un **iPhone/iPad con iOS 17.4+** desbloqueado y con **"Confiar en este equipo"** aceptado.
   Verificado contra un iPhone 15,3 con iOS 26.5.2 en Windows 11.

> **Sin admin y sin Mac.** Los servicios de desarrollo de iOS 17+ exigen un túnel; desde
> 17.4 se levanta en modo usuario dentro del propio proceso, así que no hace falta ni
> `sudo`/UAC ni el daemon `tunneld`.

> **Ejecutable standalone**: si usás un binario compilado (`dist/profiler` /
> `dist/profiler.exe`, ver [Builds](#builds-ejecutables-standalone)), **tampoco hace falta
> Bun** — el runtime y el dashboard van embebidos. Solo queda adb como dependencia.

## Instalación

```bash
git clone git@github.com:Generic/sample-mobile-profiler.git
cd sample-mobile-profiler
bun install
```

## Uso

```bash
# Dashboard en vivo (default — abre el browser solo en http://localhost:4517):
bun start

# Con inspector de red ya prendido desde el arranque (opcional — también se puede
# prender/apagar en caliente desde el dashboard, botón "🔎 Inspector" en la card de red):
bun start --inspect

# Solo el chequeo de entorno (adb + device + app), sin levantar la UI:
bun start preflight
```

**La UI arranca siempre**: el comando default es `live` — el ejecutable compilado
(doble-click en `profiler.exe`) también abre directo el dashboard. Solo aborta si no
encuentra adb.

**No hace falta el teléfono para arrancar**: `live` solo aborta si no hay adb. Sin device, el
dashboard levanta en **modo espera** y se engancha solo al primer device autorizado que
aparezca (badge `esperando device…`); enchufá el teléfono y empieza a streamear.

**Selector de device**: la ficha del device en el header es clickeable — lista **en una sola
lista los Android y los iPhone** conectados en el momento, cada uno con su plataforma, y un
botón **⟳ Refrescar**. La plataforma no se adivina: viene como dato de cada device y define
qué backend se usa. Los `unauthorized`/`offline` (y los iPhone sin "Confiar" aceptado) se ven
pero no son elegibles. Al cambiar de device, la ficha, el sampler, los logs y el inspector se
recablean en caliente y la app actual se re-engancha en el device nuevo.

**Comparación dual**: el botón **⇄ Dual comparison** abre dos paneles verticales dentro de la
misma ventana. El panel A conserva el device actual; elegí un segundo device desde el selector
del panel B para iniciar un sampler independiente. Se pueden combinar Android y iOS. Cada panel
recibe sólo sus propias métricas en tiempo real, por lo que un device lento no frena al otro. Al
salir con **Exit dual mode**, se elimina el panel B y se liberan sus streams, mientras el panel A
queda exactamente como estaba.

**Selector de apps**: no hace falta pasar `--package`. Sin flag, arranca con la **última app
usada** (primera vez: `com.sample.oda.qa`) y desde el dashboard cambiás en caliente con el
dropdown del header: lista las apps instaladas del device — `pm list packages -3` en Android,
las apps de usuario por lockdown en iOS —, con toggle para ver las de sistema, **filtradas por
el chip "Sample"** por default y ordenadas por las más usadas; el buscador apaga el chip y
busca sobre todas. La selección se persiste en `~/.config/sample-profiler/config.json`
(última app, contadores de uso y el término del chip, editable a mano).

> **Diferencia en iOS**: si la app elegida está cerrada, en Android el profiler la **lanza
> solo** (badge `🚀 launched`); en iOS **no la lanza** — hacerlo exige levantar el túnel de
> desarrollo, decenas de segundos, para algo que se resuelve con un toque en la pantalla. El
> device se engancha igual, las métricas del sistema siguen midiéndose y el proceso de la app
> se toma solo en cuanto la abrís.

Flags: `--package <pkg>` (fuerza una app, pisa el auto-resume) · `--port <n>` (default 4517) ·
`--inspect` (inspector HTTP) · `--no-open` (no abrir el browser) · `--adb <ruta>` ·
`--install-platform-tools`.

**Menú ☰ (export · registros · configuración)**: el botón ☰ del header abre un panel con:

- **Exportar reporte** — presets de un click (sesión completa, últimos 5/15/30 min, 1 h) que
  generan un **HTML standalone** (~2.5 MB, ECharts + fuentes + logos + datos embebidos: se
  abre en cualquier browser sin el profiler): cards con avg/peak/min/p90 por métrica, batería
  con % drenado, composición de memoria y timeline de la ventana. Descarga en el browser y
  guarda copia en la carpeta de reportes. Si en la ventana hubo cambios de app/device, el
  reporte se **recorta al tramo continuo de la app actual** (stats de UNA sola app) y lo
  aclara.
- **Registros de sesiones** — cada corrida del server escribe su sesión en
  `~/.config/sample-profiler/sessions/<fecha>.jsonl`; el panel las lista (fecha, apps,
  duración) y permite exportar el reporte de **cualquier sesión pasada**.
- **Configuración** — aplica en caliente y persiste: término del chip de filtro, intervalo de
  sampling (**Auto** según el device — 2 s en gama baja, 1 s en el resto — o fijo 0.5–5 s;
  reinicia el loop al vuelo), carpeta de reportes y **tema claro/oscuro**
  (el toggle del header también persiste). Todo vive en
  `~/.config/sample-profiler/config.json` (absorbe al viejo `apps.json` con migración
  automática).

**Demo sin adb**: `bun scripts/smoke-selector.ts` levanta el dashboard con un device fake
(apps, devices, pids, logs y **métricas sintéticas guionadas** en memoria) en
`http://localhost:4599` — sirve para ver el UI completo sin teléfono ni adb: FPS ~32 sobre
target 30 con una caída a ~11 FPS cada ciclo (semáforo rojo + bandas rojas + `PERF POOR`),
crash sintético en logcat (marca CRASH + chip del veredicto), GC, memoria, batería y red.

## Builds (ejecutables standalone)

```bash
bun run build       # dist/profiler — ejecutable del OS actual (macOS/Linux/Windows)
bun run build:win   # dist/profiler.exe — cross-compile a Windows x64 desde cualquier OS
```

El ejecutable embebe el runtime de Bun **y todos los assets del dashboard**
(`src/server/embeddedUi.ts` — si agregás un archivo a `src/ui/`, sumalo a ese manifest o el
binario lo servirá 404). Se corre igual que el CLI: `profiler.exe live`. La máquina destino
solo necesita **adb** (en Windows: `winget install Google.PlatformTools`, o el installer
`scripts\install-windows.ps1`). El `.exe` cross-compilado desde macOS/Linux compila y tiene
formato PE válido; falta validarlo corriendo en un Windows real.

> El inspector muestra los **hosts** de cada request HTTPS y la **URL completa** del tráfico
> HTTP en claro. Ver URLs/headers/payloads de HTTPS requiere instalar una CA en el device
> (MITM) — es la próxima iteración (ver `docs/wayfinder/tickets/018-*`).
>
> **Toggle en caliente**: el botón "🔎 Inspector" (card de red del dashboard) prende y apaga
> el proxy del device sin reiniciar nada — prendido, el tráfico del teléfono pasa por el
> profiler; apagado, el device navega normal. Al apagar (o al cortar con Ctrl-C) el proxy se
> restaura con `http_proxy :0` **y** se borran `global_http_proxy_host/port` — en API 36 un
> `delete http_proxy` solo NO alcanza y deja el teléfono sin internet (verificado en el A15).

## Desarrollo

```bash
bun test            # 481 tests (parsers contra fixtures reales + lógica core + API del server)
bun run typecheck   # tsc estricto
bun run fmt         # prettier
bun run build       # ejecutable self-contained (dist/profiler) para este OS
bun run build:win   # dist/profiler.exe (cross-compile bun-windows-x64)
bun run hooks:install   # gate de PII en pre-commit (correlo una vez al clonar)
```

Capturar fixtures de un device nuevo (para soportar otro modelo/SoC):

```bash
bun run scripts/capture-fixtures.ts   # guía la captura mientras jugás ~30 s
```

### Gate de PII (obligatorio antes de commitear capturas)

Las capturas crudas traen PII: en Android serial, `subscriberId`, SSID; en iOS además
UDID, ECID, IMEI, ICCID, teléfono y el nombre del device. **El checklist manual ya falló
una vez** y obligó a squashear la historia del repo, así que ahora es un gate:

```bash
bun run hooks:install                       # una vez: instala el pre-commit
bun run scrub <path>                        # redacta in-place (recursivo)
bun run scripts/scrub-fixtures.ts --check <path>   # sólo reporta; sale 1 si hay PII
```

El hook corre sobre lo staged y frena el commit. Los placeholders son estables dentro de
una corrida (`<REDACTED:UDID#1>`), así que una captura repartida en varios archivos sigue
cruzando bien.

### Harnesses con device real

El camino iOS está integrado en el dashboard; estos scripts sirven para validarlo end-to-end
en una máquina nueva (y para diagnosticar cuando un teléfono no aparece):

```bash
bash scripts/spike-ios.sh                   # macOS/Linux, con el iPhone enchufado
bash scripts/spike-ios.sh --install         # crea el venv gestionado con pymobiledevice3
powershell -ExecutionPolicy Bypass -File scripts\spike-ios.ps1      # el mismo, en Windows
powershell -ExecutionPolicy Bypass -File scripts\smoke-windows.ps1  # camino Android en Windows
```

La salida cruda va a `.tmp/` (gitignoreado) porque tiene PII. Detalle del stack iOS en
[`docs/research/ios-instruments-stack.md`](docs/research/ios-instruments-stack.md).

## Arquitectura (resumen)

- `src/core/adb/` — **costura `AdbTransport`**: todo acceso a adb pasa por acá (producción =
  adb real, tests = stub). Nada del resto conoce el binario adb.
- `src/core/ios/` — la costura gemela para iOS: **`IosTransport`** es la única puerta a
  `pymobiledevice3` (nada afuera sabe que hay un Python), y `IosMetricSource` produce los
  **mismos `Sample`** que el sampler de Android, así que sesiones, veredicto, reporte, server
  y UI se reusan sin tocarse. Los streams se abren una vez y viven toda la sesión: levantar el
  túnel cuesta decenas de segundos, así que un comando por tick sería impagable.
- `src/core/platform.ts` — **capacidades por plataforma**: qué puede medirse en cada una y
  qué series son comparables entre sí. Es lo que el dashboard usa para esconder lo que no
  existe (distinto de N/A, que es "existe pero falló este tick").
- `src/core/collectors/` — un parser puro por métrica (string crudo → dato), testeado contra
  fixtures reales en `fixtures/`.
- `src/core/sampler/` — loop de sampling en dos carriles: rápido por tick (cats de
  `/proc`/`/sys` + FPS + RSS) y lento amortizado (`dumpsys` pesados cada 10–15 s con
  carry-forward). Best-effort: lo que falla queda N/A, no rompe.
- `src/core/appStore.ts` — configuración persistente (selector de apps, tema, intervalo,
  carpeta de reportes) en `~/.config/sample-profiler/config.json`.
- `src/core/session/` — buffer de sesión en memoria (cap ~8 h), historial JSONL en disco y
  estadísticas puras del reporte (avg/peak/min/p90, drain de batería, recorte por app).
- `src/report/` — generador del reporte HTML standalone (template + ECharts + assets inline).
- `src/server/` — server HTTP+WebSocket que sirve el UI, streamea muestras + flows de red, y
  expone la API: selectores (`/api/packages`, `/api/app`, `/api/devices`, `/api/device`),
  export (`/api/report`, `/api/sessions`) y configuración (`/api/config`).
- `src/ui/` — dashboard web (ECharts) que consume el WebSocket.
- `docs/wayfinder/` — el **plan vivo**: `map.md` (mapa) + `tickets/` (qué está hecho y qué falta).

## Estado y qué falta

Ver el mapa en [`docs/wayfinder/map.md`](docs/wayfinder/map.md). El monitor en vivo y el
inspector de red **funcionan**, y el camino iOS está integrado end-to-end: lista unificada de
devices, selector de apps, métricas, logs y capacidades por plataforma, verificado en Windows
11 contra un iPhone 15,3 con iOS 26.5.2.

Pendiente: MITM para payloads HTTPS, CI en 3 OS, frame-times en iOS (requiere
`coreprofilesessiontap` — ticket 043, sin compromiso), y las métricas de device en iOS (CPU
total y RAM usada: existen, pero hoy costarían un comando por tick).

## Notas

- Los `fixtures/` son outputs crudos de adb de un device de prueba, con identificadores
  sensibles **redactados** (serial, subscriberId, SSID del wifi, `ro.boot.em.did`,
  `ro.boot.kg.ap` — checklist completo en `fixtures/sm-a155m-api36/README.md`). No
  commitear fixtures sin redactar.
- La red del inspector es **device-wide** (per-app realtime necesita root); para un juego en
  foreground ≈ el tráfico de la app.
- El proxy del inspector se **restaura** al cortar con Ctrl-C. Si la tool muere de golpe con
  el proxy puesto, limpialo con: `adb shell settings delete global http_proxy`.
- **Logs en iOS**: iOS suspende las apps en segundo plano — no ejecutan código, así que no
  logean. Si el panel de logs está vacío con la app minimizada, no está roto: traé la app al
  frente. (El canal en sí entrega ~20.000 líneas por minuto sin filtrar; por eso el filtro por
  proceso se aplica **en el device**, no en la PC.)
- **Si no aparece un iPhone**: revisá en orden que el teléfono esté desbloqueado y con
  "Confiar" aceptado, que la app _Apple Devices_ haya sido abierta al menos una vez (es lo que
  levanta el servicio) y que `INSTALAR.bat` haya reportado `ok pymobiledevice3` y
  `ok usbmux de Apple`. El harness `scripts\spike-ios.ps1` diagnostica los tres pasos.
