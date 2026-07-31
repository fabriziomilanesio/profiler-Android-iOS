/**
 * logsCore.js — lógica pura del panel de logs (wayfinder ticket 028).
 *
 * Único origen de la lógica de filtrado/orden/dedup/ventana de render: el browser
 * lo carga como script clásico (window.LogsCore) y bun:test lo require()a como
 * CommonJS — mismo archivo, cero espejos (a diferencia del semáforo del 025, acá
 * la lógica es grande y duplicarla en render.js invitaría a divergir).
 *
 * Estrategia de render elegida (decisión del ticket): CAP DE RENDER, no
 * virtualización por viewport. computeView() corta la lista filtrada a las
 * últimas `cap` entradas (las más nuevas) y reporta cuántas matchean pero no se
 * renderizan (`hidden`). Con cap ~1000 el DOM queda chico aunque el buffer tenga
 * 50k líneas, sin math de scroll frágil ni libs nuevas; para leer más atrás se
 * refina el filtro (texto/fecha), que es el flujo real de uso.
 *
 * Clave de dedup (bootstrap GET /api/logs vs stream WS):
 * ts|pid|tid|level|tag|message. Limitación documentada: dos líneas IDÉNTICAS del
 * mismo thread en el mismo milisegundo colapsan en una — aceptable (logcat tiene
 * resolución de ms y un duplicado exacto no aporta señal).
 */
;(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.LogsCore = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  /** Chip de filtro que gobierna cada nivel: E cubre E+F, D cubre D+V. */
  function chipForLevel(level) {
    if (level === 'E' || level === 'F') return 'E'
    if (level === 'W') return 'W'
    if (level === 'I') return 'I'
    return 'D' // D y V (y cualquier cosa rara) caen en el chip Debug+Verbose
  }

  /** Filtro default: todo pasa (chips prendidos, sin texto, sin rango, asc). */
  function defaultFilter() {
    return {
      chips: { E: true, W: true, I: true, D: true },
      /** búsqueda case-insensitive sobre message y tag (guardar en minúsculas) */
      text: '',
      /** epoch ms inclusive; null = sin cota */
      fromMs: null,
      toMs: null,
      /** 'asc' = más vieja arriba (tail al fondo) · 'desc' = más nueva arriba */
      order: 'asc',
    }
  }

  function matchesFilter(e, f) {
    if (!f.chips[chipForLevel(e.level)]) return false
    if (f.fromMs !== null && e.ts < f.fromMs) return false
    if (f.toMs !== null && e.ts > f.toMs) return false
    if (f.text) {
      var t = f.text
      if (e.message.toLowerCase().indexOf(t) === -1 && e.tag.toLowerCase().indexOf(t) === -1) {
        return false
      }
    }
    return true
  }

  /**
   * Vista renderizable: filtra, corta a las últimas `cap` (las más nuevas) y
   * ordena según filter.order. Cada row trae `badge`: true en la PRIMERA línea
   * de un bloque de crash (líneas isCrash consecutivas del mismo pid comparten
   * un solo badge CRASH — un stacktrace no necesita 40 badges).
   */
  function computeView(entries, filter, cap) {
    var matched = []
    for (var i = 0; i < entries.length; i++) {
      if (matchesFilter(entries[i], filter)) matched.push(entries[i])
    }
    var start = Math.max(0, matched.length - cap)
    var rows = []
    for (var j = start; j < matched.length; j++) {
      var e = matched[j]
      var prev = j > 0 ? matched[j - 1] : null
      var badge = !!e.isCrash && !(prev && prev.isCrash && prev.pid === e.pid)
      rows.push({ e: e, badge: badge })
    }
    if (filter.order === 'desc') rows.reverse()
    return { rows: rows, matched: matched.length, hidden: start, total: entries.length }
  }

  /** Conteo por nivel sobre un array de entradas (+ crashes). */
  function countLevels(entries) {
    var c = { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, crash: 0 }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]
      if (c[e.level] !== undefined) c[e.level]++
      if (e.isCrash) c.crash++
    }
    return c
  }

  /** Clave de dedup entre bootstrap HTTP y stream WS (limitación: ver header). */
  function dedupKey(e) {
    return (
      e.ts +
      '|' +
      e.pid +
      '|' +
      (e.tid === undefined ? '' : e.tid) +
      '|' +
      e.level +
      '|' +
      e.tag +
      '|' +
      e.message
    )
  }

  /**
   * Merge del bootstrap (GET /api/logs) contra lo ya llegado por WS: descarta
   * duplicados por dedupKey (también dentro de `incoming`), ordena por ts
   * (sort estable: las continuation lines de un stacktrace con el mismo ts
   * conservan su orden relativo) y aplica el cap del cliente.
   */
  function mergeLogs(current, incoming, cap) {
    var seen = new Set()
    for (var i = 0; i < current.length; i++) seen.add(dedupKey(current[i]))
    var added = []
    for (var j = 0; j < incoming.length; j++) {
      var k = dedupKey(incoming[j])
      if (seen.has(k)) continue
      seen.add(k)
      added.push(incoming[j])
    }
    if (added.length === 0) return current
    var merged = current.concat(added)
    merged.sort(function (a, b) {
      return a.ts - b.ts
    })
    if (merged.length > cap) merged = merged.slice(merged.length - cap)
    return merged
  }

  /**
   * Append con cap del ring del cliente: devuelve el buffer nuevo y las entradas
   * que cayeron por el cap (para descontar contadores incrementales).
   */
  function appendCapped(buf, entries, cap) {
    var next = buf.concat(entries)
    var removed = []
    if (next.length > cap) {
      removed = next.slice(0, next.length - cap)
      next = next.slice(next.length - cap)
    }
    return { buf: next, removed: removed }
  }

  return {
    chipForLevel: chipForLevel,
    defaultFilter: defaultFilter,
    matchesFilter: matchesFilter,
    computeView: computeView,
    countLevels: countLevels,
    dedupKey: dedupKey,
    mergeLogs: mergeLogs,
    appendCapped: appendCapped,
  }
})
