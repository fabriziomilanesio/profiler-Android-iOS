// La costura clave del proyecto (ver docs/wayfinder/map.md): toda interacción con
// adb pasa por esta interfaz. Producción usa RealAdbTransport; los tests y el e2e
// usan fake-adb. Nada fuera de src/core/adb conoce el binario adb.

export interface AdbDevice {
  serial: string
  /** 'device' = usable; 'unauthorized' | 'offline' requieren acción del usuario */
  state: string
  /** resto de la línea de `adb devices -l` (model:, product:, etc.) */
  description: string
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
  /** Notifica cambios de devices (conexión/desconexión). Devuelve un stop(). */
  trackDevices(onChange: (devices: AdbDevice[]) => void): () => void
}
