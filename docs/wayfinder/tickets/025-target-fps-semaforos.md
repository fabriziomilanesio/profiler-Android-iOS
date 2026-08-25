---
label: wayfinder:ticket
title: Target FPS configurable + semáforos verde/amarillo/rojo
status: closed
assignee: claude
blocked-by: []
---

# 025 — Target FPS configurable + semáforos

## Question

Agregar el target de FPS como configuración persistida y aplicar el esquema de semáforos
a las métricas de FPS/frame-time del dashboard. ¿Dónde exactamente se pinta el estado
(gauge, card, badge) sin esperar al rediseño?

## Contexto (grilling 2026-07-31)

- Target editable en ☰ Configuración, **default 30 FPS** (gama baja donde testea Sample),
  persistido en `config.json` como el resto (`appStore`).
- Esquema decidido: **verde ≥ target · amarillo ≥ 80% del target · rojo abajo**.
- El reporte (026) declara el target usado en la ventana exportada.
- Umbrales de semáforo para métricas no-FPS (CPU/GPU/temp) siguen en el fog del mapa —
  se calibran con datos reales, no acá.

## Entregado

- **Lógica pura del semáforo**: `src/core/perf/threshold.ts` — `fpsStatus(fps, target)`
  → `'green' | 'yellow' | 'red' | null` (verde ≥ target · amarillo ≥ 80% · rojo abajo;
  `FPS_YELLOW_RATIO = 0.8` exportado). Null-safe por diseño: sin FPS, FPS basura
  (negativo/NaN) o target inválido ⇒ `null`, nunca rojo — "no sé" no es "mal". Es la
  función que el reporte del 026 importa para el veredicto de la ventana exportada.
- **Config persistida**: `AppStoreData.fpsTarget` (default **30**, rango válido 1–240,
  se redondea) en `~/.config/sample-profiler/config.json`. Migración por el patrón de
  siempre de `parseAppStore` (campo a campo): config pre-025 sin el campo ⇒ 30 sin
  romper nada; basura en el JSON editado a mano ⇒ default. `AppStore.set()` lo valida
  igual que `intervalMs`.
- **Server**: el target viaja solo por el `config` completo que GET/PUT `/api/config`
  ya devolvían — cero endpoints nuevos. PUT lo aplica en caliente y persiste (test de
  ida y vuelta agregado).
- **Panel ☰ Configuración**: campo "Target FPS" (input numérico 1–240) entre Sampling
  y Modo oscuro. Guardar lo persiste y `fillConfig` empuja el valor al dashboard
  (`ProfilerDashboard.setFpsTarget`), que re-pinta el último sample sin recargar ni
  esperar el próximo tick.
- **Dónde se pinta (sin esperar al rediseño)**: el número de FPS dentro del donut
  GPU·FPS toma el color del semáforo (rich-text de ECharts `fpsgreen/fpsyellow/fpsred`
  con los `ok/warn/bad` de la paleta de cada tema; sin estado queda muted como hoy).
  En el subtítulo de frame-time del 024, el `jank Z%` hereda el mismo estado del tick
  (clases `sem-*` en `index.html`). `render.js` espeja la función pura (la UI es JS
  plano servido estático, sin bundler) — la fuente de verdad testeada es `threshold.ts`.
- **No se tocó**: umbrales de CPU/GPU/temp (siguen con sus bandas fijas de siempre,
  en el fog del mapa) ni la presentación gruesa (031/032).
- Tests (215 verdes, +7): bordes del semáforo (fps = target ⇒ verde, = 80% ⇒ amarillo,
  0 FPS ⇒ rojo real, null/NaN/target inválido ⇒ null), default + migración + validación
  de `fpsTarget` en `parseAppStore`/`set()` con recarga de disco, y GET/PUT de
  `/api/config` aplicando el target en caliente. `bun run typecheck` limpio.
