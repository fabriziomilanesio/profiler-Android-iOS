// Gate de scrub de PII (ticket 036). Lógica pura en src/core/fixtures/scrub.ts.
//
//   bun run scripts/scrub-fixtures.ts <path>            redacta in-place (recursivo)
//   bun run scripts/scrub-fixtures.ts --check <path>    NO escribe; sale 1 si hay PII
//   bun run scripts/scrub-fixtures.ts --check --staged  chequea lo staged (hook pre-commit)
//   bun run scripts/scrub-fixtures.ts --out <dir> <path>  redacta hacia otra carpeta
//
// El modo --check es lo que corre el hook: falla el commit ANTES de que la PII entre a la
// historia. Arreglarlo después obliga a reescribir la historia — ya pasó una vez.
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, relative, extname } from 'node:path'
import { PlaceholderRegistry, isExempt, scrubText } from '../src/core/fixtures/scrub'

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.woff2', '.zip', '.gz', '.ips'])

function listFiles(path: string): string[] {
  const st = statSync(path)
  if (st.isFile()) return [path]
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git' || e.name === 'node_modules') return []
    return listFiles(join(path, e.name))
  })
}

function stagedFiles(): string[] {
  const out = Bun.spawnSync(['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  return new TextDecoder()
    .decode(out.stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => {
      try {
        return statSync(f).isFile()
      } catch {
        return false
      }
    })
}

function main(): void {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const staged = argv.includes('--staged')
  const outIdx = argv.indexOf('--out')
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : undefined
  const positional = argv.filter(
    (a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1),
  )

  const targets = staged ? stagedFiles() : positional.flatMap(listFiles)

  if (targets.length === 0) {
    if (staged) {
      console.log('scrub: nada staged para revisar')
      process.exit(0)
    }
    console.error(
      'uso: bun run scripts/scrub-fixtures.ts [--check] [--staged] [--out <dir>] <path…>',
    )
    process.exit(2)
  }

  // Un registry para toda la corrida: el mismo serial redacta igual en los 30 ticks.
  const registry = new PlaceholderRegistry()
  const dirty: Array<{ file: string; summary: string }> = []
  const exempted: string[] = []
  let written = 0

  for (const file of targets) {
    if (BINARY_EXT.has(extname(file).toLowerCase())) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // binario o ilegible
    }
    if (text.includes('\u0000')) continue // binario disfrazado de texto
    if (isExempt(text)) {
      exempted.push(file)
      continue
    }

    const { text: scrubbed, hits } = scrubText(text, { registry })
    if (hits.length === 0) continue

    const summary = hits.map((h) => `${h.ruleId}×${h.count}`).join(' ')
    dirty.push({ file, summary })

    if (!check) {
      const dest = outDir ? join(outDir, relative(process.cwd(), file)) : file
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, scrubbed, 'utf8')
      written += 1
    }
  }

  const exemptNote =
    exempted.length > 0 ? ` · ${exempted.length} exento(s) por ${'scrub:allow' + '-synthetic'}` : ''

  if (dirty.length === 0) {
    console.log(
      `scrub: limpio — ${targets.length} archivo(s) revisado(s), sin PII detectada${exemptNote}`,
    )
    for (const f of exempted) console.log(`   exento: ${f}`)
    process.exit(0)
  }

  if (check) {
    console.error(`\n✗ scrub: PII detectada en ${dirty.length} archivo(s)\n`)
    for (const d of dirty) console.error(`   ${d.file}\n      ${d.summary}`)
    console.error('\nEsto NO puede entrar al repo. Redactá con:')
    console.error(`   bun run scripts/scrub-fixtures.ts ${dirty.map((d) => d.file).join(' ')}\n`)
    process.exit(1)
  }

  console.log(`scrub: ${written} archivo(s) redactado(s)`)
  for (const d of dirty) console.log(`   ${d.file}  ${d.summary}`)
  console.log(`\nvalores distintos redactados: ${registry.entries().length}`)
}

main()
