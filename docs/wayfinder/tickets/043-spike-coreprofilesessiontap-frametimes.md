---
label: wayfinder:ticket
title: Spike — ¿coreprofilesessiontap permite frame-times y jank en iOS?
status: open
assignee:
blocked-by: [038]
---

# 043 — Spike de frame-times iOS (sin compromiso)

## Question

¿Se pueden derivar frame-times individuales y jank en iOS desde
`com.apple.instruments.server.services.coreprofilesessiontap`, a un costo que valga la
pena?

## Contexto (grilling 2026-08-10)

- Es **el único agujero grande** del corte de métricas iOS. Los p50/p90/p99 y el
  `jankPct` del ticket 024 son, por decisión de ustedes, la métrica de primera clase del
  profiler — y `graphics.opengl` da FPS pero **no da histograma de frame-times**.
- `coreprofilesessiontap` son traces **kdebug crudos**: el canal más duro del stack, sin
  documentación pública. Es por donde llegan ahí las herramientas comerciales del rubro.
- **Este ticket se sacó deliberadamente del v1** y no bloquea nada. La razón: es el único
  item del plan que puede fallar del todo, y adentro del v1 bloquearía todo lo demás
  detrás del riesgo más alto. Afuera, iOS entrega valor real en semanas.
- **Puede cerrarse con un "no".** Un spike que concluye que no vale la pena es un
  resultado válido y suficiente.

## El camino alternativo, que no pasa por acá

El **SDK Unity** da frame-times reales (`FrameTimingManager`) en Android **y** iOS con un
solo código C#, más thermal state (`NSProcessInfo.thermalState`, el reemplazo honesto de
la temperatura de SoC que iOS no da) y composición de memoria desde la óptica de Unity.
El schema del 037 ya deja `source: device | app` preparado para recibirlo sin migración.

Si este spike sale "no", los frame-times de iOS quedan colgados del SDK — no del
protocolo. **R3.**
