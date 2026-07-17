# Evermore Android Profiler

Herramienta cross-platform (Windows/macOS/Linux) para **profilear apps Android en vivo vía
ADB**. Pensada para `com.evermore.oda.qa` pero sirve para cualquier app: seleccionás device
y app, ves las métricas en tiempo real en un dashboard web, inspeccionás el tráfico de red,
y (próximamente) grabás sesiones y exportás reportes de comparación.

**Métricas en vivo:** CPU % · RAM (PSS + composición) · FPS (Unity, vía SurfaceFlinger) ·
temperatura · GPU % · batería (nivel/temp/mA) · red (KB/s) · inspector de requests HTTP.

**Stack:** TypeScript + [Bun](https://bun.sh) · UI web local (WebSocket) · Apache ECharts.

---

## Requisitos

- **Bun** ≥ 1.3 — instalar: `curl -fsSL https://bun.sh/install | bash`
- **adb** (Android platform-tools). Si no lo tenés, la tool lo detecta y puede bajarlo:
  `bun run src/cli.ts --install-platform-tools`. O instalá Android Studio / platform-tools.
- Un **device Android** con **depuración USB activada** (Ajustes → Opciones de desarrollador
  → Depuración USB) y autorizado (aceptar el diálogo "¿Permitir depuración USB?" al conectar).

## Instalación

```bash
git clone git@github.com:Odaclick/evermore-android-profiler.git
cd evermore-android-profiler
bun install
```

## Uso

Conectá el teléfono por USB, abrí la app que querés medir, y:

```bash
# Chequeo de entorno (adb + device + app):
bun run src/cli.ts

# Monitor en vivo (dashboard web):
bun run src/cli.ts live --package com.evermore.oda.qa
#   → abrí la URL que imprime (http://localhost:4517)

# Monitor + inspector de red (setea un proxy en el device; se limpia al cortar con Ctrl-C):
bun run src/cli.ts live --package com.evermore.oda.qa --inspect
```

Flags: `--package <pkg>` · `--port <n>` (default 4517) · `--inspect` (inspector HTTP) ·
`--adb <ruta>` · `--install-platform-tools`.

> El inspector muestra los **hosts** de cada request HTTPS y la **URL completa** del tráfico
> HTTP en claro. Ver URLs/headers/payloads de HTTPS requiere instalar una CA en el device
> (MITM) — es la próxima iteración (ver `docs/wayfinder/tickets/018-*`).

## Desarrollo

```bash
bun test            # 123 tests (parsers contra fixtures reales + lógica core)
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
- `src/server/` — server HTTP+WebSocket que sirve el UI y streamea muestras + flows de red.
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
