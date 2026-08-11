// Tests de la captura de logs iOS (ticket 039) con transporte fake.
import { describe, expect, test } from 'bun:test'
import { IosLogCapture } from './IosLogCapture'
import type { LogEntry } from '../logs/logEntry'

function fake() {
  const streams: Array<{ args: string[]; onLine: (l: string) => void; stopped: boolean }> = []
  return {
    streams,
    stream(_s: string, args: string[], onLine: (l: string) => void): () => void {
      const e = { args, onLine, stopped: false }
      streams.push(e)
      return () => {
        e.stopped = true
      }
    },
  }
}

const LINE = (pid: number): string =>
  `2026-08-10 17:51:15.627744 EvermoreArcade{Unity}[${pid}] <ERROR>: algo falló`

function make(opts: { pid?: number | null; processName?: string | null } = {}) {
  const transport = fake()
  const entries: LogEntry[] = []
  const cap = new IosLogCapture({
    transport,
    serial: 'UDID',
    onEntries: (e) => entries.push(...e),
    ...opts,
  })
  return { transport, entries, cap }
}

describe('IosLogCapture', () => {
  test('filtra EN EL DEVICE cuando conoce el nombre del proceso', () => {
    // Sin esto `syslog live` empuja el sistema entero por USB y el costo lo paga el
    // teléfono — choca con la regla de "cero overhead nuevo" de la iteración 2.
    const { transport, cap } = make({ processName: 'EvermoreArcade' })
    cap.start()
    expect(transport.streams[0]?.args).toEqual([
      'syslog',
      'live',
      '--process-name',
      'EvermoreArcade',
    ])
  })

  test('sin nombre de proceso cae al syslog completo', () => {
    const { transport, cap } = make({})
    cap.start()
    expect(transport.streams[0]?.args).toEqual(['syslog', 'live'])
  })

  test('emite las entradas del pid seguido', () => {
    const { transport, entries, cap } = make({ pid: 42 })
    cap.start()
    transport.streams[0]?.onLine(LINE(42))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.level).toBe('E')
    expect(entries[0]?.tag).toBe('Unity')
  })

  test('descarta las de otros pids aunque el device haya filtrado por nombre', () => {
    // El nombre puede matchear más de una instancia; el pid es exacto.
    const { transport, entries, cap } = make({ pid: 42 })
    cap.start()
    transport.streams[0]?.onLine(LINE(99))
    expect(entries).toHaveLength(0)
  })

  test('sin pid conocido no emite nada', () => {
    // Con la app cerrada, mejor panel vacío que volcar el syslog del sistema.
    const { transport, entries, cap } = make({ pid: null, processName: 'X' })
    cap.start()
    transport.streams[0]?.onLine(LINE(42))
    expect(entries).toHaveLength(0)
  })

  test('setPid sigue un reinicio de la app SIN re-armar el stream', () => {
    // Es la ventaja de filtrar por pid en el host: re-armar costaría el handshake del
    // túnel entero (decenas de segundos).
    const { transport, entries, cap } = make({ pid: 1 })
    cap.start()
    cap.setPid(42)
    transport.streams[0]?.onLine(LINE(42))
    expect(transport.streams).toHaveLength(1)
    expect(entries).toHaveLength(1)
  })

  test('las líneas que no son log se ignoran sin romper', () => {
    const { transport, entries, cap } = make({ pid: 42 })
    cap.start()
    transport.streams[0]?.onLine('WARNING Trying again over a no-root userspace tunnel')
    transport.streams[0]?.onLine('')
    expect(entries).toHaveLength(0)
  })

  test('stop() corta el stream', () => {
    const { transport, cap } = make({ pid: 42 })
    cap.start()
    cap.stop()
    expect(transport.streams[0]?.stopped).toBe(true)
  })
})
