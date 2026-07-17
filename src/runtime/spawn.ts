// Thin adapter over process spawning. Único punto del código que sabe cómo se
// lanzan subprocesos: usa node:child_process (soportado por Bun y Node) para que
// la lógica de negocio quede agnóstica de runtime.
import { spawn } from 'node:child_process'

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunOptions {
  timeoutMs?: number
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          settled = true
          child.kill()
          reject(new Error(`'${command} ${args.join(' ')}' timed out after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      : undefined

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout)
      if (!settled) reject(err)
    })
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      if (!settled) resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}

/** Lanza un proceso de larga vida y entrega su stdout línea a línea. Devuelve un stop(). */
export function streamLines(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  onExit?: (err: Error | null) => void,
): () => void {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
  // Sin listener de 'error', un binario inexistente tira excepción no capturada.
  child.on('error', (err) => onExit?.(err))
  child.on('close', () => onExit?.(null))
  return () => child.kill()
}
