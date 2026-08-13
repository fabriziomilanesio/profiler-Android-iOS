// Captura de logs iOS (ticket 039): `syslog live` → `LogEntry`, el mismo tipo que produce
// `LogcatCapture` en Android. De ahí para arriba se reusa TODO sin tocar: ring de 50k
// (027), panel con filtros (028), export .txt/.jsonl (029) y marcas sobre el timeline del
// reporte (030).
//
// FILTRADO EN DOS ETAPAS, y la primera importa para el overhead:
//
//  1. **En el device** (`--process-name`): sin esto `syslog live` manda el sistema ENTERO
//     por USB. Medido contra el iPhone real: 5.756 líneas en 60 s para un solo proceso, y
//     eso es lo que sobrevive al filtro — el crudo es mucho más. Traer todo y descartar el
//     99 % en el host viola de frente la restricción transversal de la iteración 2 ("cero
//     overhead nuevo en el device"), porque el costo de serializar y empujar esas líneas
//     lo paga el teléfono.
//  2. **En el host, por pid**: el nombre de proceso puede matchear más de una instancia, y
//     cuando la app se reinicia cambia de pid sin cambiar de nombre. Filtrar por pid acá
//     cuesta nada y es exacto.
//
// La segunda etapa además permite seguir un pid nuevo sin re-armar el stream, que en iOS
// costaría el handshake del túnel entero.
import type { LogEntry } from '../logs/logEntry'
import type { IosTransport } from './IosTransport'
import { isFromPid, parseSyslogLine } from './parseSyslog'
import { ResilientStream } from './resilientStream'

export interface IosLogCaptureOptions {
  transport: Pick<IosTransport, 'stream'>
  serial: string
  onEntries: (entries: LogEntry[]) => void
  /** pid de la app; sin él no se emite nada (ver `isFromPid`). */
  pid?: number | null
  /** nombre de proceso para filtrar EN EL DEVICE; sin él se trae el syslog entero. */
  processName?: string | null
  /** escalera de reintento del stream (los tests la bajan a milisegundos). */
  backoffMs?: number[]
}

export class IosLogCapture {
  private stream: ResilientStream | null = null
  private pid: number | null

  constructor(private readonly opts: IosLogCaptureOptions) {
    this.pid = opts.pid ?? null
  }

  start(): void {
    const name = this.opts.processName
    const args =
      name !== undefined && name !== null && name !== ''
        ? ['syslog', 'live', '--process-name', name]
        : ['syslog', 'live']
    // `syslog` es LOCKDOWN: no paga el handshake del túnel, así que si su proceso muere se
    // repone solo con backoff (ticket 046). Antes, un syslog caído dejaba el panel de logs
    // mudo hasta el próximo enganche del device.
    this.stream = new ResilientStream({
      ...(this.opts.backoffMs !== undefined ? { backoffMs: this.opts.backoffMs } : {}),
      start: (onExit) =>
        this.opts.transport.stream(
          this.opts.serial,
          args,
          (line) => {
            const entry = parseSyslogLine(line)
            if (entry === null) return
            this.stream?.noteData()
            if (!isFromPid(entry, this.pid)) return
            this.opts.onEntries([entry])
          },
          onExit,
        ),
    })
    this.stream.start()
  }

  /**
   * Cambia el pid filtrado sin re-armar el stream.
   *
   * Es la ventaja de filtrar del lado del host: cuando la app se reinicia y cambia de pid,
   * Android tiene que relanzar `logcat --pid` (y en iOS eso costaría decenas de segundos
   * de handshake del túnel); acá es asignar una variable.
   */
  setPid(pid: number | null): void {
    this.pid = pid
  }

  stop(): void {
    this.stream?.stop()
    this.stream = null
  }
}
