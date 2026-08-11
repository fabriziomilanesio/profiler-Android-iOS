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
  /** Env del proceso hijo (el transporte iOS fija PYMOBILEDEVICE3_UDID por acá). */
  env?: NodeJS.ProcessEnv
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.env ? { env: options.env } : {}),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    // TextDecoder en modo stream: chunk.toString() por chunk mutila un carácter
    // multi-byte partido entre dos chunks (U+FFFD en medio del output)
    const outDec = new TextDecoder()
    const errDec = new TextDecoder()

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          settled = true
          child.kill()
          reject(new Error(`'${command} ${args.join(' ')}' timed out after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      : undefined

    child.stdout.on('data', (chunk: Buffer) => (stdout += outDec.decode(chunk, { stream: true })))
    child.stderr.on('data', (chunk: Buffer) => (stderr += errDec.decode(chunk, { stream: true })))
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout)
      if (!settled) reject(err)
    })
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      stdout += outDec.decode() // flush de un eventual multi-byte colgado al final
      stderr += errDec.decode()
      if (!settled) resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}

/** Lanza un proceso de larga vida y entrega su stdout línea a línea. Devuelve un stop(). */
export interface StreamOptions {
  /**
   * Env del proceso hijo. Lo usa el transporte iOS: `pymobiledevice3` elige el device por
   * `PYMOBILEDEVICE3_UDID`, y con dos devices conectados aborta si no se lo fijás.
   */
  env?: NodeJS.ProcessEnv
}

export function streamLines(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  onExit?: (err: Error | null) => void,
  options: StreamOptions = {},
): () => void {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.env ? { env: options.env } : {}),
  })
  let buffer = ''
  // ídem run(): logcat a chorro corta chunks en cualquier byte; decodificar en
  // modo stream evita partir un carácter UTF-8 multi-byte entre dos chunks
  const decoder = new TextDecoder()
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
  // Sin listener de 'error', un binario inexistente tira excepción no capturada.
  child.on('error', (err) => onExit?.(err))
  child.on('close', () => onExit?.(null))
  return () => child.kill()
}
