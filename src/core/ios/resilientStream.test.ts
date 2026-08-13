// Ticket 046 — reintento de los canales lockdown (batería, syslog).
//
// El escenario que motivó esto salió del iPhone real: matar el proceso de
// `diagnostics battery monitor` dejaba la temperatura en N/A por el resto de la sesión,
// porque el canal no es el vital y nadie lo reponía.
import { describe, expect, test } from 'bun:test'
import { ResilientStream } from './resilientStream'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Fabrica de streams fake: cada arranque queda registrado con su onExit. */
function spawner() {
  const spawns: Array<{ onExit: (err: Error | null) => void; stopped: boolean }> = []
  return {
    spawns,
    start: (onExit: (err: Error | null) => void) => {
      const s = { onExit, stopped: false }
      spawns.push(s)
      return () => {
        s.stopped = true
      }
    },
  }
}

describe('ResilientStream', () => {
  test('el hijo muerto se repone tras el backoff', async () => {
    const sp = spawner()
    const rs = new ResilientStream({ start: sp.start, backoffMs: [10] })
    rs.start()
    expect(sp.spawns).toHaveLength(1)

    sp.spawns[0]!.onExit(null)
    expect(rs.retrying).toBe(true)
    await wait(40)
    rs.stop()
    expect(sp.spawns).toHaveLength(2)
  })

  test('la escalera de backoff avanza mientras siga fallando', async () => {
    const sp = spawner()
    const rs = new ResilientStream({ start: sp.start, backoffMs: [5, 200] })
    rs.start()
    sp.spawns[0]!.onExit(null)
    await wait(30) // primer escalón: 5 ms, ya reintentó
    expect(sp.spawns).toHaveLength(2)

    sp.spawns[1]!.onExit(null)
    await wait(30) // segundo escalón: 200 ms, todavía NO
    expect(sp.spawns).toHaveLength(2)
    rs.stop()
  })

  test('un canal que entregó datos vuelve al primer escalón', async () => {
    const sp = spawner()
    const rs = new ResilientStream({ start: sp.start, backoffMs: [5, 200] })
    rs.start()
    sp.spawns[0]!.onExit(null)
    await wait(30)
    expect(sp.spawns).toHaveLength(2)

    rs.noteData() // el stream nuevo entrega: el próximo corte es "el primero" otra vez
    sp.spawns[1]!.onExit(null)
    await wait(30)
    rs.stop()
    expect(sp.spawns).toHaveLength(3)
  })

  test('stop() cancela el reintento pendiente', async () => {
    const sp = spawner()
    const rs = new ResilientStream({ start: sp.start, backoffMs: [10] })
    rs.start()
    sp.spawns[0]!.onExit(null)
    rs.stop()
    await wait(40)
    expect(sp.spawns).toHaveLength(1)
    expect(rs.retrying).toBe(false)
  })

  test('el onExit tardío del hijo viejo no programa un reintento de más', async () => {
    const sp = spawner()
    const rs = new ResilientStream({ start: sp.start, backoffMs: [5] })
    rs.start()
    const viejo = sp.spawns[0]!
    viejo.onExit(null)
    await wait(30) // ya hay un hijo nuevo corriendo
    expect(sp.spawns).toHaveLength(2)

    viejo.onExit(null) // el cadáver avisa de nuevo: no debe disparar nada
    await wait(30)
    rs.stop()
    expect(sp.spawns).toHaveLength(2)
  })
})
