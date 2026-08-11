---
label: wayfinder:ticket
title: Validar el ejecutable en una Windows real (camino Android)
status: open
assignee:
blocked-by: []
---

# 034 — Validar el ejecutable en Windows real, con Android

## Question

¿El `.exe` cross-compilado desde macOS realmente corre en Windows y profilea un device
Android de punta a punta? ¿Qué se rompe?

## Contexto (grilling 2026-08-10)

- Esto es **deuda abierta que ya existe, sin relación con iOS**. `README.md:204` dice
  textual: el `.exe` "tiene formato PE válido; falta validarlo corriendo en un Windows
  real". Windows era hasta ahora un target teórico.
- Con la iteración 3, Windows deja de ser teórico: pasa a ser el host donde tiene que
  funcionar el camino iOS, que es el más frágil de todos. **Si el `.exe` tiene un
  problema básico en Windows, no querés descubrirlo mientras debuggeás un túnel
  elevado y un servicio.**
- Corre en paralelo con el 033 — no dependen entre sí, y juntos son prerequisito del
  installer (041).
- La máquina disponible es la de un dev, no la del QA. Vale para construir y depurar,
  pero **no cierra el riesgo R2** (permisos de admin del QA).

### Alcance

- `INSTALAR.bat` de punta a punta en una Windows limpia-ish (Bun + platform-tools por
  winget, con el fallback de descarga directa del commit `b82a1db`).
- `INICIAR.bat` → dashboard abriéndose solo en el browser.
- Sesión real contra un Android conectado: métricas vivas, grabar sesión, generar
  reporte HTML, exportar logs.
- Verificar que el binario compilado sirve la UI embebida (`src/server/embeddedUi.ts`);
  la memoria del proyecto tenía anotado que `bun build --compile` no embebía `src/ui`.
- Rutas con espacios, `%USERPROFILE%`, y dónde caen `~/.evermore-profiler/sessions/`.

## Pendiente que este ticket NO cierra

- Firma del `.exe` (Windows AV) — sigue abierto desde el ticket 005.
- Que el QA real tenga permisos de administrador (**R2**): hay que preguntárselo a la
  persona antes de escribir el installer del 041.
