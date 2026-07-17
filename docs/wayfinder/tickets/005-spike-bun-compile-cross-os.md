---
id: 5
title: Spike bun build --compile cross-OS
label: wayfinder:prototype
status: closed
assignee: agent-spike
blocked-by: []
---

## Question

Validar TEMPRANO el riesgo principal del stack: ¿`bun build --compile` produce ejecutables
funcionales para los tres targets (`bun-windows-x64`, `bun-linux-x64`, `bun-darwin-arm64`)
desde esta Mac, incluyendo assets embebidos (HTML/JS del UI) y spawn de subprocess?

Spike descartable: un hello-server (HTTP + WS + un asset embebido + spawn de `echo`)
compilado a los 3 targets. Verificar acá el darwin-arm64; anotar cómo se validarían los
otros dos (CI matrix / VM). Si el cross-compile falla o los binarios pesan/fallan
inaceptablemente, documentar el plan B (build por-OS en CI con matrix) y su costo.

Entregable: nota corta en el ticket con veredicto + tamaños de binario + gotchas
(firma en macOS, antivirus en Windows, assets embebidos con `Bun.embeddedFiles` o import).

## Resolution (2026-07-16)

**Veredicto: VIABLE. El cross-compile desde esta Mac funciona para los 3 targets con
Bun v1.3.11. No hace falta plan B (build por-OS) para _compilar_ — sí una CI matrix para
_validar_ en runtime los binarios de Windows/Linux.** El darwin-arm64 se ejecutó acá y
pasó todo: HTML embebido servido por HTTP, WebSocket echo, y spawn de subprocess vía
`node:child_process` (`execFile("echo", ["hola"])` → `{"spawned":true,"output":"hola"}`).
`Bun.embeddedFiles` reportó el asset embebido correctamente.

Spike descartable en `/tmp/bun-compile-spike/` (server.ts: `Bun.serve` con HTTP + WS +
`import indexHtmlPath from "./index.html" with { type: "file" }` + `Bun.file(path)`).

### Comandos exactos (funcionaron tal cual)

```sh
bun build --compile --target=bun-darwin-arm64 ./server.ts --outfile spike-darwin-arm64
bun build --compile --target=bun-windows-x64  ./server.ts --outfile spike-windows-x64
bun build --compile --target=bun-linux-x64    ./server.ts --outfile spike-linux-x64
```

La primera vez que se usa un target ajeno, bun descarga el runtime de ese target (~40 MB,
una sola vez, queda cacheado) — la CI necesita red o cache para ese paso. Compilar tarda
~0.2–5 s por target.

### Tamaños y formato (verificados con `ls -lh` + `file`)

| Target           | Binario                                       | Tamaño | Formato                                                                  |
| ---------------- | --------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| bun-darwin-arm64 | spike-darwin-arm64                            | 58 MB  | Mach-O 64-bit arm64 (adhoc/linker-signed)                                |
| bun-windows-x64  | spike-windows-x64.exe (`.exe` lo agrega solo) | 110 MB | PE32+ console x86-64                                                     |
| bun-linux-x64    | spike-linux-x64                               | 95 MB  | ELF 64-bit x86-64, dynamic (glibc), interp `/lib64/ld-linux-x86-64.so.2` |

`--minify --sourcemap` no cambia el tamaño en un programa chico (58 MB igual): el peso es
el runtime de Bun embebido, no nuestro código. Asumir ~60–110 MB por release; es el costo
fijo del stack, aceptable para una tool interna.

### Validación runtime de windows/linux (no ejecutables en esta Mac)

CI matrix en GitHub Actions: `runs-on: [macos-14, windows-latest, ubuntu-latest]`, cada job
compila (o baja el artifact) su binario nativo, lo arranca, y corre el harness e2e
(fake-adb + Playwright) contra él — ya previsto en el mapa como "e2e verde en 3 OS".
Alternativa puntual: VM local (UTM/Parallels) para smoke manual.

### Gotchas

- **Assets embebidos:** `import path from "./x.html" with { type: "file" }` → path virtual
  `/$bunfs/root/x-<hash>.html`, se lee con `Bun.file(path)` o `node:fs`. Verificado en el
  spike. El nombre lleva content-hash por default (`--asset-naming="[name].[ext]"` lo
  desactiva). `Bun.embeddedFiles` lista todo como Blobs. Para directorios: pasar globs como
  entrypoints extra (`bun build --compile ./index.ts ./public/**/*.png`). Desde v1.2.17
  también se puede importar HTML directo y `Bun.serve` sirve el bundle completo (JS/CSS).
- **macOS firma/Gatekeeper:** el binario sale adhoc/linker-signed — corre local, pero
  _descargado_ (release/artifact) dispara Gatekeeper. Fix: `codesign --sign "<Developer ID>"`
  con `entitlements.plist` con permisos JIT (`com.apple.security.cs.allow-jit`,
  `allow-unsigned-executable-memory`, etc. — receta en bun.sh/docs/bundler/executables) +
  notarización, o para equipo interno: `xattr -d com.apple.quarantine`. Requiere Bun ≥1.2.4.
  Ojo: los docs de bun sugieren `--deep --force` pero Apple los desaconseja para notarizar.
- **Windows antivirus:** hay falsos positivos reportados contra binarios de bun sin firmar
  (Windows Defender issue #16981, Norton #19155 en oven-sh/bun). Mitigación: firmar el .exe
  (signtool + cert) o exclusión de Defender para la tool interna. Además, los flags
  `--windows-icon`/`--windows-hide-console` **no funcionan cross-compilando** (requieren
  APIs de Windows) — el icono/branding del .exe se pondría en el job de Windows de la CI.
- **CPU baseline:** los builds x64 default requieren AVX2 (CPUs 2013+). Si alguna máquina
  QA vieja tira "Illegal instruction", usar `bun-windows-x64-baseline`/`bun-linux-x64-baseline`.
- **Linux = glibc dinámico:** el ELF no es estático; para Alpine/containers musl usar
  `bun-linux-x64-musl`. Para desktops Ubuntu/Fedora normales, el default está bien.
- **Autoload de config:** el ejecutable lee `.env` y `bunfig.toml` del cwd por default
  (sorpresas en runtime); desactivable con `--no-compile-autoload-dotenv
--no-compile-autoload-bunfig` para builds deterministas — recomendado para la release.
- **Subprocess:** `node:child_process` funciona igual dentro del binario (clave para la
  costura `AdbTransport`/`runtime/spawn.ts`): el binario spawnea el `adb` del sistema sin
  problema.
