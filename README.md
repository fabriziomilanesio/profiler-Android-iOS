# Evermore Android Profiler

Herramienta cross-platform (Windows/macOS/Linux) para **profilear apps Android en vivo vía
ADB**. Pensada para las apps de Evermore pero sirve para cualquiera: levantás el dashboard
(con o sin teléfono conectado — se engancha solo cuando aparece), elegís **device** y **app**
desde selectores en el dashboard (las apps filtradas por "evermore" por default), ves las
métricas en tiempo real, inspeccionás el tráfico de red, y (próximamente) grabás sesiones y
exportás reportes de comparación.

**Métricas en vivo:** CPU % · RAM (PSS + composición) · FPS (Unity, vía SurfaceFlinger) ·
temperatura · GPU % · batería (nivel/temp/mA) · red (KB/s) · inspector de requests HTTP.

**Stack:** TypeScript + [Bun](https://bun.sh) · UI web local (WebSocket) · Apache ECharts.

---

## Windows 11 — instalación en 3 pasos (sin conocimientos técnicos)

1. **Descargá el proyecto**: en GitHub, botón verde **Code → Download ZIP**, y descomprimilo
   (o `git clone` si sabés usarlo).
2. **Doble click en `INSTALAR.bat`** — instala solo todo lo necesario (Bun y adb, paquetes
   oficiales vía winget) y deja el proyecto listo. Se corre **una sola vez**; si algo ya
   estaba instalado, lo saltea.
3. **Doble click en `INICIAR.bat`** — el dashboard se abre solo en el navegador. Conectá el
   teléfono por USB y listo (no importa el orden: el dashboard lo detecta solo cuando
   aparece).

En el teléfono, una sola vez: activá **Depuración USB** (Ajustes → Acerca del teléfono →
tocá 7 veces "Número de compilación" → volvé → Opciones de desarrollador → Depuración USB)
y al conectarlo aceptá el diálogo "¿Permitir depuración USB?" marcando "Permitir siempre".

## macOS / Linux — instalación normal

```bash
# 1. Bun (runtime; si ya lo tenés, salteá):
curl -fsSL https://bun.sh/install | bash        # macOS: también `brew install oven-sh/bun/bun`

# 2. Clonar e instalar deps:
git clone git@github.com:Odaclick/evermore-android-profiler.git
cd evermore-android-profiler
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
   solo en este orden: flag `--adb <ruta>` → env `EVERMORE_PROFILER_ADB` → `PATH` → SDK de
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

> **Ejecutable standalone**: si usás un binario compilado (`dist/profiler` /
> `dist/profiler.exe`, ver [Builds](#builds-ejecutables-standalone)), **tampoco hace falta
> Bun** — el runtime y el dashboard van embebidos. Solo queda adb como dependencia.

## Instalación

```bash
git clone git@github.com:Odaclick/evermore-android-profiler.git
cd evermore-android-profiler
bun install
```

## Uso

```bash
# Dashboard en vivo (default — abre el browser solo en http://localhost:4517):
bun start

# Con inspector de red (setea un proxy en el device; se limpia al cortar con Ctrl-C):
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

**Selector de device**: la ficha del device en el header es clickeable — lista los devices de
`adb devices` en el momento, con botón **⟳ Refrescar** (enchufaste otro teléfono con el
dashboard abierto → Refrescar y aparece). Los `unauthorized`/`offline` se ven pero no son
elegibles. Al cambiar de device, la ficha, el sampler y el inspector se recablean en caliente
y la app actual se re-engancha en el nuevo device.

**Selector de apps**: no hace falta pasar `--package`. Sin flag, arranca con la **última app
usada** (primera vez: `com.evermore.oda.qa`) y desde el dashboard cambiás en caliente con el
dropdown del header: lista las apps instaladas del device (`pm list packages -3`, con toggle
para ver las de sistema), **filtradas por el chip "Evermore"** por default, ordenadas por las
más usadas; el buscador apaga el chip y busca sobre todas. Si la app elegida está cerrada, el
profiler la **lanza solo** (badge `🚀 launched`). La selección se persiste en
`~/.config/evermore-profiler/apps.json` (última app, contadores de uso y el término del chip,
editable a mano).

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
  `~/.config/evermore-profiler/sessions/<fecha>.jsonl`; el panel las lista (fecha, apps,
  duración) y permite exportar el reporte de **cualquier sesión pasada**.
- **Configuración** — aplica en caliente y persiste: término del chip de filtro, intervalo de
  sampling (0.5–5 s, reinicia el loop al vuelo), carpeta de reportes y **tema claro/oscuro**
  (el toggle del header también persiste). Todo vive en
  `~/.config/evermore-profiler/config.json` (absorbe al viejo `apps.json` con migración
  automática).

**Demo sin adb**: `bun scripts/smoke-selector.ts` levanta el dashboard con un device fake
(apps, devices y pids en memoria) en `http://localhost:4599` — sirve para ver el UI, los
selectores y el export sin teléfono ni adb.

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

## Desarrollo

```bash
bun test            # 147 tests (parsers contra fixtures reales + lógica core + API del server)
bun run typecheck   # tsc estricto
bun run fmt         # prettier
bun run build       # ejecutable self-contained (dist/profiler) para este OS
bun run build:win   # dist/profiler.exe (cross-compile bun-windows-x64)
```

Capturar fixtures de un device nuevo (para soportar otro modelo/SoC):

```bash
bun run scripts/capture-fixtures.ts   # guía la captura mientras jugás ~30 s
```

## Arquitectura (resumen)

- `src/core/adb/` — **costura `AdbTransport`**: todo acceso a adb pasa por acá (producción =
  adb real, tests = stub). Nada del resto conoce el binario adb.
- `src/core/collectors/` — un parser puro por métrica (string crudo → dato), testeado contra
  fixtures reales en `fixtures/`.
- `src/core/sampler/` — loop 1 Hz que corre los collectors y arma cada muestra (best-effort:
  lo que falla queda N/A, no rompe).
- `src/core/appStore.ts` — configuración persistente (selector de apps, tema, intervalo,
  carpeta de reportes) en `~/.config/evermore-profiler/config.json`.
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
inspector de red **funcionan**. Pendiente: grabación de sesiones + historial, export de
reportes HTML de comparación, MITM para payloads HTTPS, y CI en 3 OS.

## Notas

- Los `fixtures/` son outputs crudos de adb de un device de prueba, con identificadores
  sensibles **redactados** (serial, subscriberId, SSID del wifi, `ro.boot.em.did`,
  `ro.boot.kg.ap` — checklist completo en `fixtures/sm-a155m-api36/README.md`). No
  commitear fixtures sin redactar.
- La red del inspector es **device-wide** (per-app realtime necesita root); para un juego en
  foreground ≈ el tráfico de la app.
- El proxy del inspector se **restaura** al cortar con Ctrl-C. Si la tool muere de golpe con
  el proxy puesto, limpialo con: `adb shell settings delete global http_proxy`.
