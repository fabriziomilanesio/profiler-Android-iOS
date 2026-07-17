---
id: 4
title: Scaffold del proyecto Bun con costura AdbTransport
label: wayfinder:task
status: closed
assignee: ignacio
blocked-by: []
---

## Question

Montar en este repo el esqueleto del proyecto: Bun + TypeScript estricto,
estructura `src/` (core / collectors / server / ui / report / cli), la interfaz
`AdbTransport` (métodos: `shell(cmd)`, `devices()`, `trackDevices()`, availability) con su
implementación real por subprocess, entry CLI, `bun test` andando con un test trivial,
lint/format, y README con cómo correr en dev.

Restricción: código agnóstico de runtime — APIs de Bun solo detrás de thin adapters
(spawn, serve, WS) para poder migrar a Node. Nada de lógica de negocio acoplada a Bun.

## Resolution (2026-07-16)

Scaffold montado e instalado, todo verde (`bun install` · `bun test` 3/3 ·
`bun run typecheck` · CLI detecta adb real):

- `package.json` (scripts: dev/test/typecheck/fmt/build-compile) + `tsconfig.json` estricto
  (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`) + prettier.
- **Costura `AdbTransport`** en `src/core/adb/AdbTransport.ts` (isAvailable/version/devices/
  shell/trackDevices) — nada fuera de `src/core/adb` conoce el binario adb.
- `RealAdbTransport` shell-out vía `src/runtime/spawn.ts`, el ÚNICO adapter de runtime
  (usa `node:child_process`, que Bun y Node soportan — la migración a Node queda trivial).
- Primer parser puro con tests: `parseDevices` (`adb devices -l`), patrón a seguir por el
  ticket 8.
- `.mcp.json` del repo wirea **context7** (disponible al abrir sesión en esta carpeta).
