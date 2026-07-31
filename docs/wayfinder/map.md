---
label: wayfinder:map
title: Evermore Android Profiler
status: open
---

# Mapa: Evermore Android Profiler

> Tracker local-markdown. Los tickets son archivos en [`tickets/`](tickets/) con frontmatter:
> `status: open|closed`, `assignee` (vacío = sin reclamar), `blocked-by: [ids]`.
> **Frontier** = tickets `open`, sin assignee, cuyos `blocked-by` están todos `closed`.
> Query: `grep -l 'status: open' tickets/*.md` y filtrar por `blocked-by`/`assignee`.

## Destination

`evermore/profiler/` contiene el Evermore Android Profiler v1 funcionando: profilea
`com.evermore.oda.qa` (o cualquier app) en un device real vía ADB con dashboard realtime
(gauges CPU/GPU/FPS/temp/RAM + torta de memoria + timeline + ficha del device), graba
sesiones con historial, exporta reporte HTML autocontenido de comparación/benchmarking
entre sesiones, y el harness e2e de 3 capas está verde en CI en Win/macOS/Linux.
Incluye un **inspector HTTP secundario** (URLs/status/tiempos/tamaños/headers/payloads del
tráfico de la app) — es nuestra app propia y controlamos el build QA + el device, así que
es viable; va como panel aparte, no compite con las métricas de recursos que son el core.

## Notes

- **Stack decidido (grilling 2026-07-16):** TypeScript + Bun (código agnóstico, migrable a
  Node), `bun build --compile` → un ejecutable por OS. UI web local: server + WebSocket +
  browser. Charts: Apache ECharts (única lib, vivo y reporte).
- **Métricas:** CPU%, RAM (PSS + composición java/native/graphics), FPS/jank/frame-times
  **primera clase** (vía `dumpsys SurfaceFlinger --timestats` — gfxinfo NO ve frames de
  Unity; ver research), temperatura y GPU% best-effort según device, **batería**
  (`dumpsys battery`: nivel %, drenaje por sesión, temp de batería, mA — sin root),
  network solo resumen rx/tx.
- **Reporte de sesión:** cada sesión guardada tiene un resumen de cuánto usó por métrica
  (avg / pico / mín, y para batería el drenaje % durante la sesión). El reporte HTML
  muestra ese resumen tanto para 1 sesión sola como comparando varias (benchmarking).
- **Costura clave:** interfaz `AdbTransport` — producción usa adb real, tests usan fake-adb.
  La tool jamás llama adb directo.
- **Sesiones:** JSONL (una muestra por línea) en `~/.evermore-profiler/sessions/` +
  metadata del device (modelo, Android/API, RAM, GPU, SoC). Sampling default 1 Hz.
- **Branding:** logo evermore grande/protagonista, Odaclick presente.
- **Testing:** 3 capas — parsers vs fixtures reales · e2e fake-adb + Playwright en CI (3 OS)
  · smoke `doctor` con device real. Skills a consultar por sesión: `tdd`,
  `systematic-debugging`; si el rol `dev` está activo, seguir `dev-workflow`.
- Rol `dev` activado en el workspace (2026-07-16): aplican las hard rules del dev-workflow
  (context7 antes de libs externas, logs ocultos antes de cerrar, etc.).
- **Iteración 2 (grilling 2026-07-31): perf → logger → rediseño.** Tickets 024–032.
  Prioridad: frame-time/jank + veredicto de perf en el reporte (target FPS configurable,
  default 30), después panel de logs (logcat de la app + crashes, filtro por
  nivel/texto/fecha, export .txt/.jsonl aparte), rediseño visual al final con todas las
  piezas existiendo (evolución de la identidad actual, no desde cero). **Restricción
  dura transversal: cero overhead nuevo en el device** — perf se deriva de dumps que ya
  se hacen; logcat se verifica en gama baja como en el 023. Ejecución dentro del mapa
  (como en la iteración 1): los tickets entregan código, no solo decisiones.

## Decisions so far

<!-- una línea por ticket cerrado: gist + link -->

- [Scaffold del proyecto Bun con costura AdbTransport](tickets/004-scaffold-proyecto-bun.md) —
  esqueleto TS estricto instalado y verde (test/typecheck/CLI); `AdbTransport` como única
  puerta a adb, `runtime/spawn.ts` como único adapter de runtime; context7 wireado en
  `.mcp.json` del repo.
- [Spike bun build --compile cross-OS](tickets/005-spike-bun-compile-cross-os.md) — VIABLE
  desde una sola Mac, sin plan B: 3 targets compilan (58–110 MB), darwin verificado en
  runtime; para release real falta codesign/notarización (macOS) y firma (Windows AV);
  CI matrix valida los binarios no ejecutables localmente.
- [Conseguir logos de evermore y Odaclick](tickets/006-conseguir-logos-branding.md) —
  en `assets/brand/`: evermore color (protagonista, de LFS de evermorearcade) + wordmark
  blanco + app icon, odaclick blanco (del branded-doc-builder); paleta Odaclick
  (`#EB008B`/`#00E6DA`/bg `#0B0B10`) y fuentes (Baloo 2 + Inter) en su README. Sin SVG
  vectorial en el workspace (nice-to-have: pedir los AI/SVG originales).
- [Research formatos de dumpsys por versión Android y OEM](tickets/002-research-formatos-dumpsys.md) —
  tabla completa en [docs/research/dumpsys-formats.md](../research/dumpsys-formats.md).
  HALLAZGO CLAVE: gfxinfo no reporta frames de Unity ⇒ FPS/jank vía
  `SurfaceFlinger --timestats` (fallback `--latency`, layer descubierto en runtime).
  CPU por deltas de `/proc`; meminfo por bloque App Summary; temp por thermalservice
  (fallback sysfs); GPU% probing kgsl→Mali/Xclipse (PowerVR N/A); net por
  `dumpsys netstats detail` (solo total de sesión, no realtime por segundo).
- [Preflight gate — detección/instalación de adb](tickets/013-preflight-gate-adb.md) —
  `src/core/preflight/`: discovery pura (config→PATH→SDK→managed), instalación de
  platform-tools con deps inyectadas (descarga opt-in `--install-platform-tools`),
  máquina de estados Start→…→Ready con remedios en texto; CLI la renderiza con ✓/✗/–.
  Para la UI queda: panel visual + re-check automático vía `trackDevices()`.
- [Prototipo del dashboard realtime](tickets/007-prototipo-dashboard-ui.md) —
  `prototypes/dashboard/index.html` (abrir directo, offline): gauges (GPU·FPS en un
  donut), torta de memoria con leyenda, timeline 120s, sim 1 Hz. Feedback humano aplicado
  (2 rondas): UI en inglés, light default + toggle, responsive 1 línea, logo Odaclick =
  perro solo. Quedan 3 preguntas abiertas (eje timeline, series default, chips GC/JANK).
- [Decidir el mecanismo del proxy MITM (TS/Bun)](tickets/017-http-mecanismo-proxy.md) —
  DECISIÓN: proxy MITM propio en TS (`http-mitm-proxy` + `node-forge`), shell-out a
  mitmproxy descartado. Diseño completo en
  [docs/research/http-inspector-mechanism.md](../research/http-inspector-mechanism.md).
  Riesgos: R1 Bun TLS callbacks, R2 Unity ignora proxy (→016), CA manual en Android 11+.
- [Inspector HTTP — core device-independent + spike Bun TLS](tickets/019-http-core-modules-spike.md) —
  **Spike R1: `SNICallback` NO dispara en Bun 1.3.11** ⇒ `CertAuthority` emite certs
  **eager** (no dentro del callback). Entregados con 28 tests: `CertAuthority`,
  `DeviceProxyController` (set/get/restore por adb, restauración exacta + recuperación de
  crash), `FlowStore` (+ tipos HAR 1.2, export HAR). 81 tests verdes. Para 018 queda el
  proxy real (cargar SecureContext por-host sin callback), `DeviceCaInstaller`, panel y
  orquestador.
- [Capturar fixtures crudos del device real](tickets/001-capturar-fixtures-device-real.md) —
  captura real del Galaxy A15 (SM-A155M, MT6789/Mali-G57, API 36) en
  `fixtures/sm-a155m-api36/`: oneshot + sesión 30 ticks + final, PII redactada (checklist
  en el README de fixtures). Fuente GPU% confirmada: `/sys/kernel/gpu/gpu_busy`.
- [Prototipo del reporte HTML](tickets/020-prototipo-reporte-html.md) —
  `prototypes/report/report.html`: resumen de recursos+batería por sesión y comparación
  cross-sesión (fixtures determinísticos). Sirve de spec visual para el ticket 012.
- [Live real connection](tickets/021-live-real-connection.md) — monitor en vivo funcionando
  contra el device real: `Sampler` 1 Hz best-effort sobre `AdbTransport`, `LiveServer`
  HTTP+WS sirviendo `src/ui/`, red device-wide por delta de `/proc/net/dev`, inspector
  HTTP pass-through opcional (`--inspect`) con proxy + `adb reverse`.
- [Frame-time y jank primera clase](tickets/024-frametime-jank-primera-clase.md) — p50/p90/p99
  y jank% por tick derivados del histograma `present2present` del dump de timestats que ya se
  hacía (cero comandos nuevos); umbral de jank = perder ≥1 vsync del panel real
  (`refreshHz` leído una vez de `--latency`, fallback 60) sobre la cadencia propia de la app.
- [Target FPS configurable + semáforos verde/amarillo/rojo](tickets/025-target-fps-semaforos.md) —
  `fpsTarget` persistido en config (default 30, editable en ☰, aplica en caliente);
  `fpsStatus(fps, target)` pura en `src/core/perf/threshold.ts` (verde ≥ target ·
  amarillo ≥ 80% · rojo abajo, null-safe) reutilizable por el reporte del 026; el FPS
  del donut y el jank% del subtítulo toman el color del estado.
- [Logger — captura logcat de la app + crashes/ANR vía AdbTransport](tickets/027-logcat-captura-crashes.md) —
  `AdbTransport.streamShell()` (long-running) + `src/core/logs/`: esquema LogEntry genérico
  (`source: 'logcat' | 'game'` — SDK futuro sin migración), parser threadtime+year, ring 50k,
  NDJSON hermano `<id>.logs.jsonl` junto a la sesión; app stream `--pid` re-armado al cambiar
  pid/app/device + crash stream (`-b crash,events`) adjudicado por pid/package con backoff;
  WS `{type:'logs'}` en batch + GET /api/logs. Pendiente: overhead en gama baja con device real.
- [Reporte — correlación FPS↔GPU/CPU/temp + veredicto de perf](tickets/026-reporte-correlacion-veredicto.md) —
  apertura del reporte con semáforo general (`fpsStatus` sobre el avg), % del tiempo en
  target ponderado por ticks, peores 3 tramos (ventana 30 s, score 70 % déficit FPS +
  30 % jank, piso 1) y throttling térmico conservador (≥ 42 °C sostenida 60 s + caída
  ≥ 15 % de FPS/GPU vs base fría, sin base no acusa); chart de correlación en dos grids
  con dataZoom compartido y tramos rojos sombreados; target declarado, todo puro en
  `src/core/perf/verdict.ts`; hook `session.marks` listo para el 030.
- [Sampling en dos carriles](tickets/023-sampling-dos-carriles-overhead.md) — el profiler
  exigía al device en gama baja (observer effect de `dumpsys meminfo` cada 1 s). Carril
  rápido (cats + FPS + RSS vivo por VmRSS) cada tick; carril lento (meminfo 15 s,
  thermal/battery/ps 10 s) con carry-forward; intervalo default auto por RAM (< 4 GB → 2 s,
  opción "Auto" en el panel).

## Not yet specified

- Umbrales de semáforo para métricas **no-FPS** (CPU/GPU/temp) — el esquema de FPS quedó
  decidido en el ticket 025 (target configurable, verde/amarillo/rojo); el resto se
  calibra con datos de sesiones reales de evermore, no a priori.
- **SDK de logging dentro del juego Unity** (canal estructurado `source: 'game'` con
  categorías y contexto de gameplay, montado sobre el esquema de log-entry del ticket 027) — decidido en el grilling 2026-07-31 que va _después_ de esta iteración; requiere
  tocar evermorearcade y build nuevo.
- Escenario de juego estandarizado como "benchmark run" de evermore (misma escena/duración)
  para que las comparaciones entre builds sean justas.
- Soporte de GPU% para SoCs no-Qualcomm (Mali/Xclipse/PowerVR) — depende de lo que arroje
  el research de formatos.
- Marcadores/anotaciones manuales durante una sesión ("acá empezó el nivel 2").
- Distribución y versionado de la tool al equipo (releases, canal de updates) — después del
  spike de empaquetado.

## Out of scope

- **Comparación dual-live** (dos apps corriendo simultáneo lado a lado) — v1 compara
  sesiones grabadas; dos apps vivas en un device contaminan el benchmark.
- **Métricas root-only** — la tool asume device stock sin root.
