// Robustez del adapter de subprocesos (review 024-027, hallazgo #6): un carácter
// UTF-8 multi-byte partido entre dos chunks de stdout no debe mutilarse (con
// chunk.toString() por chunk, cada mitad decodifica a U+FFFD). Se fuerza el corte
// con un child real que escribe los bytes en dos writes separados por un delay.
import { describe, expect, test } from 'bun:test'
import { run, streamLines } from './spawn'

// escribe 'ñandú\n' partiendo el primer byte de la 'ñ' (0xC3 | 0xB1...) en dos writes
const SPLIT_SCRIPT = `
  const b = Buffer.from('ñandú\\n', 'utf8')
  process.stdout.write(b.subarray(0, 1))
  setTimeout(() => process.stdout.write(b.subarray(1)), 50)
`

describe('spawn UTF-8 entre chunks', () => {
  test('streamLines no parte un carácter multi-byte entre dos chunks', async () => {
    const lines: string[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout esperando al child')), 5000)
      streamLines(
        process.execPath,
        ['-e', SPLIT_SCRIPT],
        (l) => lines.push(l),
        () => {
          clearTimeout(timer)
          resolve()
        },
      )
    })
    expect(lines).toEqual(['ñandú'])
  })

  test('run() acumula stdout con decoder streaming (sin U+FFFD)', async () => {
    const r = await run(process.execPath, ['-e', SPLIT_SCRIPT], { timeoutMs: 5000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('ñandú\n')
    expect(r.stdout.includes('�')).toBe(false)
  })
})
