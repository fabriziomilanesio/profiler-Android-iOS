// Tests de la lógica pura del panel de logs (ticket 028). El módulo es UMD:
// el browser lo carga como script clásico y acá lo require()amos tal cual —
// exactamente el mismo código que corre en el dashboard, sin espejo.
import { describe, expect, test } from 'bun:test'

const Core = require('./logsCore.js')

/** entry de prueba con defaults razonables */
function e(over = {}) {
  return {
    ts: 1000,
    level: 'I',
    tag: 'Unity',
    message: 'hello world',
    pid: 111,
    tid: 222,
    source: 'logcat',
    ...over,
  }
}

describe('chipForLevel', () => {
  test('E y F caen en el chip Error; D y V en Debug+Verbose', () => {
    expect(Core.chipForLevel('E')).toBe('E')
    expect(Core.chipForLevel('F')).toBe('E')
    expect(Core.chipForLevel('W')).toBe('W')
    expect(Core.chipForLevel('I')).toBe('I')
    expect(Core.chipForLevel('D')).toBe('D')
    expect(Core.chipForLevel('V')).toBe('D')
  })
})

describe('matchesFilter', () => {
  test('filtro default deja pasar todo', () => {
    const f = Core.defaultFilter()
    for (const level of ['V', 'D', 'I', 'W', 'E', 'F']) {
      expect(Core.matchesFilter(e({ level }), f)).toBe(true)
    }
  })

  test('chip apagado bloquea sus niveles (F cae con E, V con D)', () => {
    const f = Core.defaultFilter()
    f.chips.E = false
    expect(Core.matchesFilter(e({ level: 'E' }), f)).toBe(false)
    expect(Core.matchesFilter(e({ level: 'F' }), f)).toBe(false)
    expect(Core.matchesFilter(e({ level: 'W' }), f)).toBe(true)
    f.chips.D = false
    expect(Core.matchesFilter(e({ level: 'D' }), f)).toBe(false)
    expect(Core.matchesFilter(e({ level: 'V' }), f)).toBe(false)
  })

  test('texto case-insensitive sobre message Y tag', () => {
    const f = Core.defaultFilter()
    f.text = 'unity'
    expect(Core.matchesFilter(e({ tag: 'Unity', message: 'x' }), f)).toBe(true)
    expect(Core.matchesFilter(e({ tag: 'other', message: 'NullReference in UNITY code' }), f)).toBe(
      true,
    )
    expect(Core.matchesFilter(e({ tag: 'other', message: 'nada' }), f)).toBe(false)
  })

  test('rango desde/hasta inclusive', () => {
    const f = Core.defaultFilter()
    f.fromMs = 1000
    f.toMs = 2000
    expect(Core.matchesFilter(e({ ts: 999 }), f)).toBe(false)
    expect(Core.matchesFilter(e({ ts: 1000 }), f)).toBe(true)
    expect(Core.matchesFilter(e({ ts: 2000 }), f)).toBe(true)
    expect(Core.matchesFilter(e({ ts: 2001 }), f)).toBe(false)
  })
})

describe('computeView', () => {
  test('cap de render: quedan las más nuevas y reporta hidden', () => {
    const entries = []
    for (let i = 0; i < 10; i++) entries.push(e({ ts: i, message: 'm' + i }))
    const view = Core.computeView(entries, Core.defaultFilter(), 3)
    expect(view.total).toBe(10)
    expect(view.matched).toBe(10)
    expect(view.hidden).toBe(7)
    expect(view.rows.map((r) => r.e.message)).toEqual(['m7', 'm8', 'm9'])
  })

  test('el cap corta sobre lo FILTRADO, no sobre el buffer', () => {
    const entries = [
      e({ ts: 1, level: 'E', message: 'err1' }),
      e({ ts: 2, level: 'I', message: 'ruido' }),
      e({ ts: 3, level: 'E', message: 'err2' }),
    ]
    const f = Core.defaultFilter()
    f.chips.I = false
    const view = Core.computeView(entries, f, 10)
    expect(view.matched).toBe(2)
    expect(view.rows.map((r) => r.e.message)).toEqual(['err1', 'err2'])
  })

  test('orden desc invierte las filas', () => {
    const entries = [e({ ts: 1, message: 'a' }), e({ ts: 2, message: 'b' })]
    const f = Core.defaultFilter()
    f.order = 'desc'
    const view = Core.computeView(entries, f, 10)
    expect(view.rows.map((r) => r.e.message)).toEqual(['b', 'a'])
  })

  test('badge CRASH solo en la primera línea del bloque (mismo pid consecutivo)', () => {
    const entries = [
      e({ ts: 1, message: 'normal' }),
      e({ ts: 2, level: 'E', isCrash: true, message: 'FATAL EXCEPTION' }),
      e({ ts: 3, level: 'E', isCrash: true, message: '\tat com.foo' }),
      e({ ts: 4, level: 'E', isCrash: true, message: '\tat com.bar' }),
      e({ ts: 5, message: 'normal de nuevo' }),
      e({ ts: 6, level: 'E', isCrash: true, pid: 999, message: 'otro crash otro pid' }),
    ]
    const view = Core.computeView(entries, Core.defaultFilter(), 100)
    expect(view.rows.map((r) => r.badge)).toEqual([false, true, false, false, false, true])
  })

  test('badge respeta el límite del cap (la anterior cronológica cuenta aunque no se renderice)', () => {
    const entries = [
      e({ ts: 1, level: 'E', isCrash: true, message: 'primera del bloque' }),
      e({ ts: 2, level: 'E', isCrash: true, message: 'segunda del bloque' }),
    ]
    const view = Core.computeView(entries, Core.defaultFilter(), 1)
    // la única fila renderizada es continuación de un bloque ya empezado: sin badge
    expect(view.rows.length).toBe(1)
    expect(view.rows[0].badge).toBe(false)
  })
})

describe('countLevels', () => {
  test('cuenta por nivel y crashes', () => {
    const c = Core.countLevels([
      e({ level: 'E' }),
      e({ level: 'F', isCrash: true }),
      e({ level: 'W' }),
      e({ level: 'I' }),
      e({ level: 'I' }),
    ])
    expect(c.E).toBe(1)
    expect(c.F).toBe(1)
    expect(c.W).toBe(1)
    expect(c.I).toBe(2)
    expect(c.crash).toBe(1)
  })
})

describe('mergeLogs (dedup bootstrap vs WS)', () => {
  test('descarta duplicados exactos y ordena por ts', () => {
    const viaWs = [e({ ts: 300, message: 'c' }), e({ ts: 400, message: 'd' })]
    const bootstrap = [
      e({ ts: 100, message: 'a' }),
      e({ ts: 300, message: 'c' }), // duplicado exacto del WS
      e({ ts: 200, message: 'b' }),
    ]
    const merged = Core.mergeLogs(viaWs, bootstrap, 100)
    expect(merged.map((x) => x.message)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('mismo ts pero pid/tid/message distinto NO es duplicado', () => {
    const a = e({ ts: 100, message: 'igual ts' })
    const b = e({ ts: 100, message: 'igual ts', pid: 999 })
    const merged = Core.mergeLogs([a], [b], 100)
    expect(merged.length).toBe(2)
  })

  test('dedup también dentro del bootstrap y respeta el cap', () => {
    const dup = e({ ts: 100, message: 'x' })
    const incoming = [dup, { ...dup }, e({ ts: 200, message: 'y' }), e({ ts: 300, message: 'z' })]
    const merged = Core.mergeLogs([], incoming, 2)
    expect(merged.map((x) => x.message)).toEqual(['y', 'z'])
  })

  test('sin novedades devuelve el mismo array (sin realocar)', () => {
    const current = [e({ ts: 100 })]
    expect(Core.mergeLogs(current, [e({ ts: 100 })], 10)).toBe(current)
  })

  test('sort estable: continuation lines con el mismo ts conservan el orden', () => {
    const stack = [
      e({ ts: 100, message: 'FATAL EXCEPTION' }),
      e({ ts: 100, message: '\tat com.a' }),
      e({ ts: 100, message: '\tat com.b' }),
    ]
    const merged = Core.mergeLogs([], stack, 100)
    expect(merged.map((x) => x.message)).toEqual(['FATAL EXCEPTION', '\tat com.a', '\tat com.b'])
  })
})

describe('appendCapped', () => {
  test('sin overflow devuelve concat y removed vacío', () => {
    const r = Core.appendCapped([e({ ts: 1 })], [e({ ts: 2 })], 10)
    expect(r.buf.length).toBe(2)
    expect(r.removed).toEqual([])
  })

  test('con overflow caen las más viejas y se reportan', () => {
    const buf = [e({ ts: 1, message: 'a' }), e({ ts: 2, message: 'b' })]
    const r = Core.appendCapped(buf, [e({ ts: 3, message: 'c' }), e({ ts: 4, message: 'd' })], 3)
    expect(r.buf.map((x) => x.message)).toEqual(['b', 'c', 'd'])
    expect(r.removed.map((x) => x.message)).toEqual(['a'])
  })
})
