---
label: wayfinder:ticket
title: Frame-time y jank primera clase (p50/p90/p99, sin overhead nuevo)
status: closed
assignee: claude
blocked-by: []
---

# 024 — Frame-time y jank primera clase

## Question

Derivar frame-times individuales y jank del dump de SurfaceFlinger que **ya se hace por
tick** — el promedio de FPS esconde los tirones. ¿Qué estructura exacta (percentiles,
ventanas, conteos) exponemos en `Sample` y en el dashboard?

## Contexto (grilling 2026-07-31)

- **Restricción dura**: cero comandos nuevos al device. El colector de FPS ya lee el dump
  de latencia de SurfaceFlinger con timestamps por frame; los frame-times salen de ahí.
  Si un dato exige otra lectura por tick, queda afuera o va al carril lento.
- Umbral de jank **relativo al refresh rate real del panel** (60/90/120 Hz), leído una vez
  al conectar el device — no 16.6 ms hardcodeado.
- Métricas esperadas: frame-time p50/p90/p99, % de frames janky, frames > 1 vsync
  perdido. Persisten en la sesión JSONL como el resto (alimentan al reporte del 026).
- UI: los datos entran al dashboard (card/serie de FPS existente); el rediseño fino de
  presentación es del 031/032 — acá alcanza con que se vean y sean correctos.
- Tests contra fixtures reales (hay dumps del Galaxy A15 en `fixtures/sm-a155m-api36/`).

## Entregado

- **Fuente (cero comandos nuevos por tick)**: el dump de `SurfaceFlinger --timestats`
  que ya trae el FPS incluye, por layer, el histograma `present2present` (intervalo
  entre presents en ms, resolución 1–2 ms) — la distribución de frame-times del tick
  gratis. No hizo falta el carril lento ni `--latency` por tick.
- `fps.ts`: `parseFrameStats(dump, pkg, refreshHz)` → `FrameSample` (p50/p90/p99 ms,
  jank% y conteo, totalFrames), mismo filtrado de layer por package que `parseFps`
  (fallback al histograma global `presentToPresent` en dumps legacy);
  `parseRefreshRate(latency)` → Hz del panel.
- **Refresh rate real, leído UNA vez al conectar**: primera línea de
  `dumpsys SurfaceFlinger --latency` = período de vsync en ns (fixture del A15:
  `11111111` → 90 Hz). Elegida sobre `dumpsys display` porque esa línea es estable
  desde hace años y se imprime aun sin layer/matcheo. Va en `DeviceInfo.refreshHz`
  (null ⇒ el jank cae a 60 Hz); se muestra como chip en la ficha del device.
- **Umbral de jank relativo (decisión)**: cadencia esperada de la app = p50 del tick
  redondeado a vsyncs ENTEROS del panel real; janky = frame que perdió ≥1 vsync sobre
  esa cadencia (> cadencia + ½ vsync de tolerancia). Así un juego a 30 FPS clavados en
  un panel de 90 Hz da 0% jank (33 ms = 3 vsyncs es su ritmo), y un frame de 44 ms sí
  cuenta. Nada de 16.6 ms fijo: a 90 Hz el vsync es 11.1 ms.
- `schema.ts`: `Sample.frame: FrameSample` (todo nullable, best-effort) +
  `DeviceInfo.refreshHz` — persisten solos en la sesión JSONL como el resto.
- `stats.ts`: `ReportSummary.frame` (`FrameSummary`: ScalarStats de p50/p90/p99 por
  tick, jank% de sesión **ponderado por frames del tick** y jankFrames totales) +
  `frameP90Ms`/`jankPct` en cada punto de la serie y `refreshHz` en el device del
  reporte — todo listo para el veredicto del 026. Sesiones viejas sin el campo ⇒ null.
- UI: subtítulo bajo el donut GPU·FPS — `p90 X ms · p99 Y ms · jank Z%`
  (`frame-time N/A` si no hay datos); presentación fina queda para 031/032.
- Tests (208 verdes): parser contra el dump real del A15 (1178 frames, p50/p90/p99 =
  33 ms, 11 janky = 0.93%), 0% jank a 30 FPS/90 Hz, umbral que cambia con el refresh
  (22 ms es jank a 90 Hz y no bajo 60), multi-layer, idle ⇒ null, refresh rate del
  fixture y sintéticos, sampler con `refreshHz` inyectado y timestats caído,
  agregación ponderada de sesión y sesiones legacy.

## Pendiente / ideas futuras

- El histograma agrupa >150 ms en buckets de 50 ms: hitches muy largos se subestiman
  (quedan en el bucket piso). Aceptable para p50/p90/p99 y conteo de jank.
- `refreshHz` se lee una vez: paneles con refresh dinámico (LTPO) que cambian mid-sesión
  no se re-detectan; el dump de timestats trae `displayRefreshRate` por tick si algún
  día hace falta seguirlo en vivo.
