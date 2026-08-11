// La costura clave del proyecto (ver docs/wayfinder/map.md): toda interacción con
// adb pasa por esta interfaz. Producción usa RealAdbTransport; los tests y el e2e
// usan fake-adb. Nada fuera de src/core/adb conoce el binario adb.

export interface AdbDevice {
  serial: string
  /** 'device' = usable; 'unauthorized' | 'offline' requieren acción del usuario */
  state: string
  /** resto de la línea de `adb devices -l` (model:, product:, etc.) */
  description: string
  /**
   * Plataforma del device (ticket 035). Ausente = 'android': los devices que vienen de
   * `adb devices` no lo setean, así que las sesiones y los tests viejos no cambian.
   * Los iPhone entran por `src/core/ios/` con este campo en 'ios'.
   */
  platform?: 'android' | 'ios'
}

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface AdbTransport {
  /** false si el binario adb no existe o no responde */
  isAvailable(): Promise<boolean>
  version(): Promise<string>
  devices(): Promise<AdbDevice[]>
  shell(serial: string, command: string): Promise<ShellResult>
  /**
   * Comando shell long-running (logcat): entrega stdout línea a línea hasta que
   * el proceso muera o se llame el stop() devuelto. onExit avisa cuando el
   * proceso terminó solo (error de spawn o cierre) — el caller decide reintentar.
   */
  streamShell(
    serial: string,
    command: string,
    onLine: (line: string) => void,
    onExit?: (err: Error | null) => void,
  ): () => void
  /** Notifica cambios de devices (conexión/desconexión). Devuelve un stop(). */
  trackDevices(onChange: (devices: AdbDevice[]) => void): () => void
}
