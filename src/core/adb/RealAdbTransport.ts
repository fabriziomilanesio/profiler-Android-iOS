import { run, streamLines } from '../../runtime/spawn'
import type { AdbDevice, AdbTransport, ShellResult } from './AdbTransport'
import { parseDevices } from './parseDevices'

const DEFAULT_TIMEOUT_MS = 10_000

/** AdbTransport de producción: shell-out al binario adb real. */
export class RealAdbTransport implements AdbTransport {
  constructor(private readonly adbPath: string = 'adb') {}

  async isAvailable(): Promise<boolean> {
    try {
      const result = await run(this.adbPath, ['version'], { timeoutMs: DEFAULT_TIMEOUT_MS })
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  async version(): Promise<string> {
    const result = await run(this.adbPath, ['version'], { timeoutMs: DEFAULT_TIMEOUT_MS })
    return result.stdout.trim()
  }

  async devices(): Promise<AdbDevice[]> {
    const result = await run(this.adbPath, ['devices', '-l'], { timeoutMs: DEFAULT_TIMEOUT_MS })
    return parseDevices(result.stdout)
  }

  async shell(serial: string, command: string): Promise<ShellResult> {
    return run(this.adbPath, ['-s', serial, 'shell', command], { timeoutMs: DEFAULT_TIMEOUT_MS })
  }

  streamShell(
    serial: string,
    command: string,
    onLine: (line: string) => void,
    onExit?: (err: Error | null) => void,
  ): () => void {
    return streamLines(this.adbPath, ['-s', serial, 'shell', command], onLine, onExit)
  }

  trackDevices(onChange: (devices: AdbDevice[]) => void): () => void {
    // `adb track-devices` emite en cada cambio; ante cualquier evento re-listamos
    // con -l para tener también la descripción (model/product).
    const stop = streamLines(this.adbPath, ['track-devices'], () => {
      void this.devices().then(onChange, () => onChange([]))
    })
    return stop
  }
}
