---
label: wayfinder:ticket
title: UI y reporte cross-plataforma — N/A por plataforma y comparación honesta
status: closed
assignee: claude
blocked-by: [038]
---

# 040 — UI y reporte cross-plataforma

## Question

¿Cómo se ven el dashboard y el reporte cuando la sesión es iOS, y qué pasa cuando el
reporte compara una sesión Android con una iOS?

## Contexto (grilling 2026-08-10)

El profiler existe para **benchmarking**. Con iOS adentro, algunas comparaciones son
mentiras que se ven perfectamente creíbles en un gráfico de barras:

- **Memoria**: `PSS` (prorratea memoria compartida) vs `physFootprint` (no prorratea,
  incluye páginas comprimidas). Mismo eje ⇒ una diferencia que no existe.
- **CPU%**: Android normalizado share-of-device 0–100; `sysmontap` reporta por proceso y
  puede pasar de 100. Sin normalizar, iOS se ve el doble de caro.
- **GPU%**: `/sys/kernel/gpu/gpu_busy` de Mali y el desglose device/renderer/tiler de
  Metal no miden lo mismo ni de lejos.
- **FPS**: el único razonablemente comparable — los dos los mide el compositor, no la app.

Pero la pregunta que un QA hace de verdad — _"¿el build aguanta 30 fps en Android y en
iPhone?"_ — es legítima y hoy no se puede contestar. Prohibir la comparación entera tira
eso a la basura.

## Decisión ya tomada en el grilling

Se permite comparar, pero **el reporte sabe qué se puede comparar y qué no, y lo dice**.
Las series entran al mismo eje sólo si comparten clave de comparabilidad (contrato del
037). FPS de Android y de iOS se comparan con nota de fuente; memoria va en paneles
separados **con la explicación de por qué**, no como un hueco misterioso.

## A resolver

- Dashboard con métricas ausentes por plataforma: hoy la UI dibuja N/A a nivel de tick.
  Falta el caso "esta métrica no existe en esta plataforma" — y no debería verse como un
  error, sino como información. El tile de frame-times/jank en iOS es el caso testigo.
- El veredicto de perf del 026 (semáforo general, % en target, peores 3 tramos,
  throttling térmico): **el throttling térmico usa temperatura, que iOS no tiene**. Hay
  que decidir si en iOS ese chequeo desaparece, o se aproxima con la temperatura de
  batería (que no es lo mismo y puede engañar).
- Indicador de plataforma en la ficha del device y en el reporte.
- Evidencia visual con el subagente `eyes` antes de commitear (regla 6 del dev-workflow),
  como se hizo en el 032.
