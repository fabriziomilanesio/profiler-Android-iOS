---
label: wayfinder:ticket
title: Rename — de "Evermore Android Profiler" a "Evermore Profiler"
status: closed
assignee: claude
blocked-by: [038]
---

# 042 — Rename a Evermore Profiler

## Question

Sacar "Android" de la identidad del producto, sin romper lo que ya está publicado.

## Contexto (grilling 2026-08-10)

Decidido junto con la costura del 035: cuando la tool perfila dos plataformas, el nombre
miente. Va **después** de que iOS realmente funcione (bloqueado por el 038) — renombrar
antes sería anunciar algo que todavía no existe.

## Superficies a tocar

- Repo publicado en GitHub: `Odaclick/evermore-android-profiler` (privado). Cambiar el
  nombre deja un redirect, pero hay que avisar a quien tenga el remoto clonado.
- `package.json` (`@odaclick/evermore-android-profiler`), nombre del binario
  (`dist/profiler` / `profiler.exe`) y los targets de build.
- `README.md` (el título dice "profilear apps Android en vivo vía ADB"), `INSTALAR.bat`
  / `INICIAR.bat` (títulos de ventana), `scripts/install-windows.ps1`.
- Título del dashboard y del reporte HTML.
- Este mapa (`docs/wayfinder/map.md`) y el título de la Destination.
- La carpeta de sesiones `~/.evermore-profiler/` **ya es agnóstica** — no se toca, y
  romperla obligaría a migrar sesiones de la gente.

## Cuidado

La rama local `pre-publish-history` conserva la historia vieja con PII sin redactar y
**no se puede pushear a ningún remoto, nunca** — incluido cualquier remoto nuevo que
aparezca por el rename.

## Entregado (2026-08-10) — "Evermore **Mobile** Profiler"

Se eligió **Mobile** sobre "Evermore Profiler" a secas: dice qué perfila sin atarse a una
plataforma, y deja lugar a que mañana entre otra.

Tocado: título y `<title>` del dashboard, sub-marca del header, footer (`Live data from
Android & iOS`), el reporte HTML exportado, el banner del CLI, el OU del certificado de la
CA del inspector, `INICIAR.bat`/`INSTALAR.bat`, `install-windows.ps1`, `capture-fixtures`
y el README.

**Lo que NO se tocó, a propósito**: las menciones a "Android" o "adb" que describen el
camino Android de verdad — el preflight de adb, la doc de depuración USB, los comentarios
de los collectors. Renombrarlas sería mentir en la otra dirección: esas partes SÍ son
específicas de Android.

**Repo renombrado (2026-08-10, aprobado por Ignacio)**:
`Odaclick/evermore-android-profiler` → **`Odaclick/evermore-mobile-profiler`**. Se eligió
kebab-case con el prefijo `evermore-` para no romper la convención del scope `@odaclick/`.
También cambió el `name` del `package.json` y las URLs de clone del README, y el remote
local ya apunta al nombre nuevo.

⚠️ **Avisarle al equipo**: GitHub deja un redirect desde el nombre viejo, así que los
clones existentes siguen funcionando — pero conviene que corran
`git remote set-url origin git@github.com:Odaclick/evermore-mobile-profiler.git` para no
depender del redirect.

`~/.evermore-profiler/` NO se toca: ya es agnóstico y migrarlo obligaría a mover las
sesiones de todos. El binario sigue llamándose `profiler`, que tampoco nombra plataforma.
