---
label: wayfinder:ticket
title: Sampling en dos carriles — bajar el overhead del profiler en el device
status: closed
assignee: claude
blocked-by: [021]
---

# 023 — Sampling en dos carriles (overhead en gama baja)

## Problema

Con el profiler activo, el juego se sentía exigido en el Galaxy A15 (gama baja). Causa:
cada tick (1 s) disparaba ~9 `adb shell` en paralelo en el device, y `dumpsys meminfo`
domina el costo — el kernel camina `/proc/<pid>/smaps` completo (address space enorme en
un juego Unity IL2CPP) tomando el `mmap_lock` **del proceso del juego**, y el dump binder
hace trabajar al propio proceso. Resultado: carga sostenida + hitch sincronizado cada
segundo + calor → throttling. Observer effect puro.

Se evaluó escalar el intervalo global por gama (5 s baja / 2 s media / 1 s alta) y se
descartó como mecanismo principal: pierde resolución de FPS/CPU justo en la gama baja
(donde más se profilea) y el hitch de meminfo solo se espacia, no desaparece.

## Diseño (híbrido elegido)

1. **Carril rápido** (cada tick, `intervalMs`): solo cats de `/proc`/`/sys` + dump de
   FPS. El cat combinado suma `/proc/<pid>/status` → **RSS de la app (VmRSS) en vivo,
   gratis** (`Sample.mem.rss`).
2. **Carril lento** (independiente del intervalo, carry-forward entre corridas):
   `dumpsys meminfo` cada 15 s, `thermalservice` + `battery` cada 10 s, `ps -A` cada
   10 s. Corrida programada que falla ⇒ el valor vuelve a null (N/A honesto).
   La muerte del proceso se detecta gratis en el carril rápido (el pid desaparece del
   cat combinado) y fuerza el `ps` en el próximo `refreshPid`.
3. **Default por gama** (`intervalAuto`, default true): device con < 4 GB de RAM →
   carril rápido a 2 s; resto 1 s. Elegir un intervalo concreto en el panel pasa a
   manual; la opción "Auto" del select lo devuelve. Config pre-023 migra: intervalMs
   ≠ 1000 se asume manual.

## Entregado

- `sampler.ts`: `LaneIntervals` (`DEFAULT_LANES` 15/10/10 s), clock inyectable,
  carry-forward de mem/temp/batería, gating de `ps -A`, `mainPidSeen` en el snapshot.
- `meminfo.ts`: `parseVmRssMb` (suma VmRSS de main + hijos); `MemSample.rss`.
- `appStore.ts`: `intervalAuto` + `autoIntervalMs` (umbral `LOW_RAM_MB` 4096).
- `liveServer.ts`: `resolveIntervalMs` (flag CLI > manual > auto por RAM del device),
  re-resuelto al capturar/cambiar device y en PUT `/api/config`;
  `effectiveIntervalMs` en las respuestas de config.
- UI: opción "Auto (X s)" en el select de sampling; subtítulo de la torta de memoria
  muestra el RSS vivo.
- Tests: cadencia y carry-forward, N/A honesto en corrida fallida, gating y muerte por
  carril rápido, migración/flip de `intervalAuto`, resolución auto end-to-end (194 verdes).

Overhead resultante por segundo en gama baja: 1 cat combinado + gpu_busy + net + dump de
FPS (cada 2 s), con los dumpsys pesados amortizados a 10–15 s — ~5-10× menos carga y sin
el hitch periódico de meminfo.

## Pendiente / ideas futuras

- Auto-calibración por duty-cycle medido (período de cada comando lento en función de su
  duración real en el device) — reemplazaría el umbral fijo de RAM.
- Fusionar `gpu_busy` + `/proc/net/dev` en el cat combinado (2 spawns menos por tick).
- Medir en el A15 real el antes/después (top de `dumpsys`/`sh`/`adbd` + frametimes del
  juego con y sin profiler).
