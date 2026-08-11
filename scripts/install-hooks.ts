// Instala los git hooks del repo (gate de PII en pre-commit, ticket 036).
//
// Existe como script y no como una línea en package.json porque la versión anterior era
// `git config … && chmod +x .githooks/*`, y **`chmod` no existe en Windows**: el comando
// fallaba justo en la máquina donde el equipo va a correr la tool.
import { chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'
import { run } from '../src/runtime/spawn'

const HOOKS_DIR = '.githooks'

async function main(): Promise<void> {
  const result = await run('git', ['config', 'core.hooksPath', HOOKS_DIR], { timeoutMs: 10_000 })
  if (result.exitCode !== 0) {
    console.error('no se pudo setear core.hooksPath:', result.stderr.trim())
    process.exit(1)
  }

  // El bit de ejecución sólo tiene sentido en POSIX; en Windows Git ignora los permisos
  // y ejecuta el hook por el shebang con el bash que trae Git for Windows.
  if (platform() !== 'win32') {
    for (const file of readdirSync(HOOKS_DIR)) {
      try {
        chmodSync(join(HOOKS_DIR, file), 0o755)
      } catch {
        // un hook sin permisos de escritura no debe romper la instalación del resto
      }
    }
  }

  console.log(`hooks instalados desde ${HOOKS_DIR}/ (gate de PII en pre-commit)`)
}

await main()
