---
id: 13
title: Preflight gate — detección/instalación de adb y estado de conexión
label: wayfinder:task
status: closed
assignee: agent-preflight
blocked-by: [4]
---

## Question

Implementar el gate que impide fallar feo cuando falta algo:

1. **Detección de adb** en orden: config del usuario → `PATH` → rutas típicas del SDK por
   OS (`~/Library/Android/sdk/platform-tools`, `%LOCALAPPDATA%\Android\Sdk\platform-tools`,
   `~/Android/Sdk/platform-tools`).
2. Si falta: panel de setup que ofrece **descargar platform-tools oficiales de Google**
   (`https://dl.google.com/android/repository/platform-tools-latest-{windows,darwin,linux}.zip`)
   a `~/.evermore-profiler/platform-tools/` con progreso, y usa ese binario.
3. Cadena de checks en UI: adb OK → device conectado (y autorizado — detectar
   `unauthorized` y explicar el diálogo del teléfono) → app instalada. Cada eslabón dice
   qué falta y cómo resolverlo, y se re-chequea solo (poll/track-devices).

Testeable con fake-adb (escenario "no hay adb", "device unauthorized") y con un mock del
download.

## Resolution (2026-07-16)

Lógica core implementada test-first en `src/core/preflight/` (27 tests nuevos; `bun test`
30/30 y `bun run typecheck` verdes; CLI verificado contra el adb real de la Mac — reporta
NoDevice limpio con exit 1):

- **`discoverAdb.ts`** — resolución PURA de la ruta de adb, parametrizada por
  `(platform, env, isExecutable)` inyectados (testeada por OS sin tocar el FS). Orden de
  búsqueda como contrato: (a) config explícita → (b) `PATH` (con `Path`/`;`/`adb.exe` en
  Windows) → (c) SDK típico por OS → (d) `~/.evermore-profiler/platform-tools/` (managed).
  Devuelve `{ path, source }` o `null`.
- **`installPlatformTools.ts`** — descarga el zip oficial de Google
  (`platform-tools-latest-{darwin,windows,linux}.zip`) a `~/.evermore-profiler/`,
  descomprime ahí (el zip trae `platform-tools/` adentro) y devuelve la ruta del adb.
  Orquestación con `Downloader`/`Unzipper`/fs inyectados (tests con mocks, cero red).
  Implementaciones reales: `fetchDownloader` (fetch estándar, streaming con progreso) y
  `systemUnzipper` — **dependencia de sistema documentada:** `unzip -o` en macOS/Linux
  (preserva el bit x de adb) y `tar -xf` (bsdtar, Win10+) en Windows, ambos vía
  `runtime/spawn` (la costura de runtime del ticket 004).
- **`preflight.ts`** — máquina de estados pura: `advance(state, observation)` con
  Start → AdbMissing | AdbOk → NoDevice | DeviceUnauthorized | DeviceOk → AppMissing |
  Ready. `Preflight(transport: AdbTransport, packageName).check()` maneja la máquina y
  devuelve `PreflightReport` (estado terminal + eslabones adb/device/app con
  ok/fail/skipped, detalle y remedio en texto — el unauthorized explica el diálogo
  "¿Permitir depuración USB?" del teléfono). App instalada vía
  `pm list packages <pkg>` por `transport.shell`, con match EXACTO de línea
  `package:<pkg>` (pm filtra por substring). Tests con un stub in-line de `AdbTransport`
  (no el fake-adb del ticket 009).
- **CLI** (`src/cli.ts`) — reemplaza el chequeo básico: descubre adb, corre el preflight
  completo y muestra la cadena con ✓/✗/– + remedios. Flags `--package`, `--adb`,
  `--install-platform-tools`; env `EVERMORE_PROFILER_ADB` como config explícita. Exit 0
  solo en Ready.

Decisiones:

- Elección de device: el primero con state `device`; `offline` cuenta como NoDevice,
  `unauthorized` solo manda si no hay ningún usable. Multi-device real (selector) queda
  para la UI.
- La "config del usuario" hoy es flag/env (no hay sistema de config todavía); cuando
  exista config persistente, entra por el mismo parámetro `configPath`.
- La instalación de platform-tools es opt-in en CLI (`--install-platform-tools`), no
  automática: descargar 10+ MB sin preguntar sería feo; la UI lo hará con botón+progreso
  (el `onProgress` ya está plumbeado).

Queda para cuando exista la UI (tickets 007/010): el panel visual de setup con botón de
descarga y barra de progreso, y el **re-check automático** — `AdbTransport.trackDevices()`
ya existe para dispararlo (re-correr `check()` en cada cambio de devices); el core no
necesita cambios para eso.
