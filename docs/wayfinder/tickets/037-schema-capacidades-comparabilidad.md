---
label: wayfinder:ticket
title: Schema — capacidades, source por métrica y clave de comparabilidad
status: closed
assignee: claude
blocked-by: [035, 036]
---

# 037 — Capacidades, `source` y comparabilidad en el schema

## Question

¿Cómo cambia `Sample` (y lo que cuelga de él) para sostener dos plataformas sin mentir?

## Contexto (grilling 2026-08-10)

El `Sample` de hoy es Android por dentro: `pss` con breakdown java/native/graphics,
batería en deci-°C, `jankPct` derivado del histograma `present2present` de SurfaceFlinger.
La convención de `null` explícito ("no disponible en este device") ya existe y funciona —
falta subirla de "este tick falló" a "esta plataforma no lo tiene".

## Decisiones ya tomadas en el grilling (no se re-abren acá)

1. **`physFootprint` NO va en el campo `pss`.** Campo nuevo. `PSS` de Android prorratea
   la memoria compartida entre procesos; `physFootprint` de iOS es "lo que Apple le cobra
   a tu app", incluye páginas comprimidas y no prorratea nada. Son números distintos
   midiendo cosas distintas. Un `null` en `pss` es honesto; **un número con la etiqueta
   equivocada es un bug silencioso que sobrevive años** — alguien lee el JSONL de una
   sesión iOS, ve `pss`, asume semántica de Android y decide mal.
2. **Cada métrica lleva `source: device | app`.** Hoy todo es `device`. Cuando aterrice
   el SDK Unity, los frame-times de iOS pasan de `null` a valor real **sin migración de
   schema y sin tocar el reporte**, y el reporte puede distinguir "este FPS lo midió el
   compositor" de "lo midió el juego", que no son el mismo número. Ya empezaron a hacer
   esto sin darse cuenta: el `LogEntry` del ticket 027 anticipó `source: 'game'`.
3. **Clave de comparabilidad por métrica.** Dos series entran al mismo eje sólo si la
   clave coincide.

## A resolver

- Forma exacta del descriptor de capacidades por sesión: qué métricas son reales en
  este device/plataforma, y **por qué** una está ausente (no existe en la plataforma vs
  falló el collector) — el reporte necesita esa diferencia para explicarla.
- Campos nuevos de memoria iOS (`footprint`, `resident`) y qué pasa con `MemBreakdown`
  (todo null en iOS, sin torta).
- Normalización de CPU: si `sysmontap` reporta por-core (puede pasar de 100) hay que
  normalizarlo a share-of-device 0–100 como Android, o darle clave de comparabilidad
  distinta. **El dato sale del 033.**
- Batería: iOS da nivel, **temperatura de batería** y amperaje vía `AppleSmartBattery`.
  Ojo — es temperatura _de la batería_, no del SoC; el `tempC` térmico de Android no
  tiene equivalente y queda `null` permanente en iOS.
- Compatibilidad hacia atrás: las sesiones JSONL ya grabadas no tienen ninguno de estos
  campos y tienen que seguir abriendo (como se hizo en el 024 con `refreshHz`).
