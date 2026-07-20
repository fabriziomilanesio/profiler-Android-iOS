# Evermore Android Profiler

Herramienta cross-platform (Windows/macOS/Linux) para **profilear apps Android en vivo vía
ADB**. Pensada para las apps de Evermore pero sirve para cualquiera: elegís la app desde un
**selector en el dashboard** (lista las instaladas del device, filtradas por "evermore" por
default), ves las métricas en tiempo real, inspeccionás el tráfico de red, y (próximamente)
grabás sesiones y exportás reportes de comparación.

**Métricas en vivo:** CPU % · RAM (PSS + composición) · FPS (Unity, vía SurfaceFlinger) ·
temperatura · GPU % · batería (nivel/temp/mA) · red (KB/s) · inspector de requests HTTP.

**Stack:** TypeScript + [Bun](https://bun.sh) · UI web local (WebSocket) · Apache ECharts.

---

## Requisitos

Para **ejecutarlo** hace falta exactamente esto:

> **Windows 11 — instalador automático**: cloná el repo y corré
> `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1` — instala Bun y
> adb vía winget (paquetes oficiales `Oven-sh.Bun` y `Google.PlatformTools`), verifica ambos
> y corre `bun install`. Idempotente: lo ya instalado se saltea. Después salteá al paso 3.

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
4. Un **browser** — el dashboard es una página local (`http://localhost:4517`).

No hace falta Node, npm, ni instalar nada en el device.

## Instalación

```bash
git clone git@github.com:Odaclick/evermore-android-profiler.git
cd evermore-android-profiler
bun install
```

## Uso

Conectá el teléfono por USB y:

```bash
# Chequeo de entorno (adb + device + app):
bun run src/cli.ts

# Monitor en vivo (dashboard web):
bun run src/cli.ts live
#   → abrí la URL que imprime (http://localhost:4517)

# Monitor + inspector de red (setea un proxy en el device; se limpia al cortar con Ctrl-C):
bun run src/cli.ts live --inspect
```

**Selector de apps**: no hace falta pasar `--package`. Sin flag, arranca con la **última app
usada** (primera vez: `com.evermore.oda.qa`) y desde el dashboard cambiás en caliente con el
dropdown del header: lista las apps instaladas del device (`pm list packages -3`, con toggle
para ver las de sistema), **filtradas por el chip "Evermore"** por default, ordenadas por las
más usadas; el buscador apaga el chip y busca sobre todas. Si la app elegida está cerrada, el
profiler la **lanza solo** (badge `🚀 launched`). La selección se persiste en
`~/.config/evermore-profiler/apps.json` (última app, contadores de uso y el término del chip,
editable a mano).

Flags: `--package <pkg>` (fuerza una app, pisa el auto-resume) · `--port <n>` (default 4517) ·
`--inspect` (inspector HTTP) · `--adb <ruta>` · `--install-platform-tools`.

**Demo sin device**: `bun scripts/smoke-selector.ts` levanta el dashboard con un device fake
(apps y pids en memoria) en `http://localhost:4599` — sirve para ver el UI y el selector sin
un teléfono conectado.

> El inspector muestra los **hosts** de cada request HTTPS y la **URL completa** del tráfico
> HTTP en claro. Ver URLs/headers/payloads de HTTPS requiere instalar una CA en el device
> (MITM) — es la próxima iteración (ver `docs/wayfinder/tickets/018-*`).

## Desarrollo

```bash
bun test            # 142 tests (parsers contra fixtures reales + lógica core + API del server)
bun run typecheck   # tsc estricto
bun run fmt         # prettier
bun run build       # ejecutable self-contained (dist/profiler) para este OS
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
- `src/core/appStore.ts` — persistencia del selector de apps (última usada, ranking de uso,
  término del filtro) en `~/.config/evermore-profiler/apps.json`.
- `src/server/` — server HTTP+WebSocket que sirve el UI, streamea muestras + flows de red, y
  expone la API del selector (`GET /api/packages`, `POST /api/app` — switch en caliente).
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
