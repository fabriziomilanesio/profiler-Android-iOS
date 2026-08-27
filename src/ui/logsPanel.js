/**
 * logsPanel.js — panel de logs del dashboard (wayfinder ticket 028).
 *
 * Consume el buffer que live.js alimenta desde el WS ({type:"logs"}) + el
 * bootstrap GET /api/logs, y renderiza la sección colapsable de logs con el
 * "sorteo": chips por nivel (E / W / I / D+V), búsqueda de texto, rango
 * desde/hasta, orden asc/desc, pausa de auto-scroll (botón explícito + pausa
 * automática al scrollear fuera del borde vivo, con "volver al vivo").
 *
 * Toda la lógica de filtrado/orden/dedup/cap vive en logsCore.js (puro,
 * testeado con bun:test); acá solo hay DOM. Render: cap de 1000 filas (las más
 * nuevas que pasan el filtro) con indicador de cuántas quedan fuera — ver la
 * nota de estrategia en logsCore.js. Camino caliente: los batches del WS se
 * appendean incremental (sin reconstruir el DOM); el rebuild completo solo
 * ocurre al cambiar filtro/orden, reanudar el vivo o abrir el panel.
 *
 * API para live.js (y para el export del ticket 029):
 *   LogsPanel.onLogs(entries)        — batch nuevo del WS
 *   LogsPanel.bootstrap(pane)        — fetch + merge dedup de /api/logs
 *   LogsPanel.clear()                — cambio de app/device: panel limpio
 *   LogsPanel.getFilteredEntries()   — TODAS las entries que pasan el filtro
 *                                      actual, en el orden visible (029: export)
 *   LogsPanel.downloadExport(payload, container, onStatus)
 *                                    — POST /api/logs/export → descarga blob
 *                                      (lo usa también el menú ☰ para sesiones)
 */
;(function () {
  'use strict'

  var Core = window.LogsCore
  var CLIENT_CAP = 50000 // espejo del ring del server (~12 MB peor caso)
  var RENDER_CAP = 1000 // filas máximas en el DOM (ver logsCore.js)
  var BOOTSTRAP_N = 2000 // historia razonable al conectar; el resto llega por WS
  var LIVE_EDGE_PX = 30 // tolerancia para considerar el scroll "en el borde vivo"

  var els = {
    section: document.getElementById('logsSection'),
    toggle: document.getElementById('logsToggle'),
    caret: document.getElementById('logsCaret'),
    body: document.getElementById('logsBody'),
    scroll: document.getElementById('logsScroll'),
    list: document.getElementById('logsList'),
    empty: document.getElementById('logsEmpty'),
    total: document.getElementById('logsTotal'),
    matched: document.getElementById('logsMatched'),
    badgeE: document.getElementById('logsBadgeE'),
    badgeW: document.getElementById('logsBadgeW'),
    hidden: document.getElementById('logsHidden'),
    chips: document.getElementById('logsChips'),
    search: document.getElementById('logsSearch'),
    from: document.getElementById('logsFrom'),
    to: document.getElementById('logsTo'),
    order: document.getElementById('logsOrder'),
    pause: document.getElementById('logsPause'),
    live: document.getElementById('logsLive'),
    exportWrap: document.getElementById('logsExport'),
    exportStatus: document.getElementById('logsExportStatus'),
  }

  var buf = [] // ring del cliente (más vieja primero)
  var counts = Core.countLevels([]) // contadores incrementales por nivel
  var filter = Core.defaultFilter()
  // El dashboard abre sus paneles por defecto; los logs siguen el mismo criterio.
  var open = true
  var pausedManual = false // botón Pausa (solo el botón la levanta)
  var pausedScroll = false // pausa automática al scrollear fuera del borde vivo
  var newSincePause = 0 // entradas nuevas que pasan el filtro durante la pausa
  var matchedTotal = 0 // cuántas del buffer pasan el filtro actual
  var renderedCount = 0 // filas en el DOM (≤ RENDER_CAP)
  var lastMatchedTail = null // última entry cronológica renderizada (badges CRASH)
  var programmaticScroll = false
  var searchTimer = null

  function isPaused() {
    return pausedManual || pausedScroll
  }

  function bumpCounts(entries, sign) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]
      if (counts[e.level] !== undefined) counts[e.level] += sign
      if (e.isCrash) counts.crash += sign
    }
  }

  function pad(n, w) {
    var s = String(n)
    while (s.length < w) s = '0' + s
    return s
  }

  function fmtTime(ts) {
    var d = new Date(ts)
    return (
      pad(d.getHours(), 2) +
      ':' +
      pad(d.getMinutes(), 2) +
      ':' +
      pad(d.getSeconds(), 2) +
      '.' +
      pad(d.getMilliseconds(), 3)
    )
  }

  // Celdas SIEMPRE via textContent: tag/message vienen del device (input hostil).
  function buildRow(e, badge) {
    var row = document.createElement('div')
    row.className = 'log-row lvl-' + e.level + (e.isCrash ? ' crash' : '')
    var time = document.createElement('span')
    time.className = 'log-time'
    time.textContent = fmtTime(e.ts)
    var lvl = document.createElement('span')
    lvl.className = 'log-lvl'
    lvl.textContent = e.level
    var tag = document.createElement('span')
    tag.className = 'log-tag'
    tag.textContent = e.tag
    tag.title = e.tag + ' · pid ' + e.pid + (e.tid !== undefined ? ':' + e.tid : '')
    row.appendChild(time)
    row.appendChild(lvl)
    row.appendChild(tag)
    if (badge) {
      var chip = document.createElement('span')
      chip.className = 'log-crash-badge'
      chip.textContent = e.isCrash && e.tag === 'am_anr' ? 'ANR' : 'CRASH'
      row.appendChild(chip)
    }
    var msg = document.createElement('span')
    msg.className = 'log-msg'
    msg.textContent = e.message
    row.appendChild(msg)
    return row
  }

  function updateHeader() {
    els.total.textContent = String(buf.length)
    var errs = counts.E + counts.F
    els.badgeE.textContent = 'E ' + errs
    els.badgeE.classList.toggle('nonzero', errs > 0)
    els.badgeW.textContent = 'W ' + counts.W
    els.badgeW.classList.toggle('nonzero', counts.W > 0)
    if (open) {
      els.matched.hidden = false
      els.matched.textContent = matchedTotal + ' in filter'
    } else {
      els.matched.hidden = true
    }
  }

  function updateHiddenLine() {
    var hidden = matchedTotal - renderedCount
    if (hidden > 0) {
      els.hidden.hidden = false
      els.hidden.textContent =
        'Showing the ' +
        renderedCount +
        ' most recent · ' +
        hidden +
        ' older lines match the filter (refine text/date to see them)'
    } else {
      els.hidden.hidden = true
    }
  }

  function updateLiveBtn() {
    if (isPaused()) {
      // pop sutil SOLO al aparecer (Motion vendoreado; sin lib o con
      // prefers-reduced-motion aparece sin animar)
      if (
        els.live.hidden &&
        typeof window.Motion !== 'undefined' &&
        !(
          typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        )
      ) {
        try {
          window.Motion.animate(
            els.live,
            {
              opacity: [0, 1],
              transform: ['translateX(-50%) scale(0.85)', 'translateX(-50%) scale(1)'],
            },
            { duration: 0.25, ease: [0.22, 1, 0.36, 1] },
          )
        } catch (e) {}
      }
      els.live.hidden = false
      els.live.textContent =
        (filter.order === 'desc' ? '▲' : '▼') +
        ' back to live' +
        (newSincePause > 0 ? ' (' + newSincePause + ' new)' : '')
    } else {
      els.live.hidden = true
    }
    els.pause.classList.toggle('on', pausedManual)
    els.pause.textContent = pausedManual ? '▶ Resume' : '⏸ Pause'
  }

  function atLiveEdge() {
    var s = els.scroll
    if (filter.order === 'desc') return s.scrollTop < LIVE_EDGE_PX
    return s.scrollHeight - s.scrollTop - s.clientHeight < LIVE_EDGE_PX
  }

  function scrollToEdge() {
    programmaticScroll = true
    els.scroll.scrollTop = filter.order === 'desc' ? 0 : els.scroll.scrollHeight
    // el evento scroll dispara async: soltar el flag en el próximo frame
    setTimeout(function () {
      programmaticScroll = false
    }, 0)
  }

  /** Rebuild completo del DOM desde el buffer (cambio de filtro/orden/resume/open). */
  function rebuild() {
    var view = Core.computeView(buf, filter, RENDER_CAP)
    matchedTotal = view.matched
    renderedCount = view.rows.length
    newSincePause = 0
    var frag = document.createDocumentFragment()
    for (var i = 0; i < view.rows.length; i++) {
      frag.appendChild(buildRow(view.rows[i].e, view.rows[i].badge))
    }
    els.list.innerHTML = ''
    els.list.appendChild(frag)
    if (view.rows.length > 0) {
      var tail = filter.order === 'desc' ? view.rows[0] : view.rows[view.rows.length - 1]
      lastMatchedTail = tail.e
    } else {
      lastMatchedTail = null
    }
    els.empty.hidden = buf.length > 0
    updateHiddenLine()
    updateHeader()
    updateLiveBtn()
    if (!isPaused()) scrollToEdge()
  }

  /** Append incremental del camino caliente (batch WS con el panel vivo). */
  function appendLive(entries) {
    var appended = 0
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]
      if (!Core.matchesFilter(e, filter)) continue
      matchedTotal++
      var badge =
        !!e.isCrash &&
        !(lastMatchedTail && lastMatchedTail.isCrash && lastMatchedTail.pid === e.pid)
      lastMatchedTail = e
      var row = buildRow(e, badge)
      if (filter.order === 'desc') els.list.insertBefore(row, els.list.firstChild)
      else els.list.appendChild(row)
      renderedCount++
      appended++
    }
    if (appended === 0) {
      updateHeader()
      return
    }
    while (renderedCount > RENDER_CAP) {
      // el extremo "viejo" del DOM: arriba en asc, abajo en desc
      var victim = filter.order === 'desc' ? els.list.lastChild : els.list.firstChild
      if (!victim) break
      els.list.removeChild(victim)
      renderedCount--
    }
    els.empty.hidden = true
    updateHiddenLine()
    updateHeader()
    scrollToEdge()
  }

  // ---------- API pública (live.js + export del 029) ----------

  function onLogs(entries) {
    if (!entries || entries.length === 0) return
    var r = Core.appendCapped(buf, entries, CLIENT_CAP)
    buf = r.buf
    bumpCounts(entries, 1)
    if (r.removed.length > 0) {
      bumpCounts(r.removed, -1)
      // entradas que cayeron del ring pueden haber estado en el conteo del filtro
      for (var i = 0; i < r.removed.length; i++) {
        if (Core.matchesFilter(r.removed[i], filter)) matchedTotal--
      }
    }
    if (!open) {
      updateHeader()
      return
    }
    if (isPaused()) {
      for (var j = 0; j < entries.length; j++) {
        if (Core.matchesFilter(entries[j], filter)) newSincePause++
      }
      updateHeader()
      updateLiveBtn()
      return
    }
    appendLive(entries)
  }

  function bootstrap(pane) {
    var dataPane = pane === 'secondary' ? 'secondary' : 'primary'
    fetch('/api/logs?n=' + BOOTSTRAP_N + '&pane=' + dataPane)
      .then(function (res) {
        return res.json()
      })
      .then(function (data) {
        if (!data || !data.entries || data.entries.length === 0) return
        buf = Core.mergeLogs(buf, data.entries, CLIENT_CAP)
        counts = Core.countLevels(buf)
        if (open) rebuild()
        else updateHeader()
      })
      .catch(function () {
        /* best-effort: sin bootstrap el stream WS igual llena el panel */
      })
  }

  function clear() {
    buf = []
    counts = Core.countLevels([])
    matchedTotal = 0
    renderedCount = 0
    newSincePause = 0
    lastMatchedTail = null
    els.list.innerHTML = ''
    els.empty.hidden = false
    updateHiddenLine()
    updateHeader()
    updateLiveBtn()
  }

  /** Todas las entries que pasan el filtro actual, en el orden visible (029: export). */
  function getFilteredEntries() {
    var view = Core.computeView(buf, filter, Number.MAX_SAFE_INTEGER)
    var out = []
    for (var i = 0; i < view.rows.length; i++) out.push(view.rows[i].e)
    return out
  }

  // ---------- Export (ticket 029) ----------

  function setExportStatus(msg, kind) {
    els.exportStatus.textContent = msg || ''
    els.exportStatus.className = 'logs-export-status' + (kind ? ' ' + kind : '')
  }

  /**
   * POST /api/logs/export → blob → descarga en el browser. El server además
   * guarda una copia en la carpeta de reportes (mismo doble destino que el
   * reporte HTML). `container` recibe el <a> sintético: dentro de un popover
   * evita que el click burbujee a document y lo cierre (patrón de live.js).
   */
  function downloadExport(payload, container, onStatus) {
    onStatus('Exporting logs…', '')
    fetch('/api/logs/export', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) {
        if (!r.ok) {
          // el error puede venir como texto plano (p.ej. 403 'Forbidden origin'):
          // try-parse JSON y, si no parsea, mostrar el texto crudo
          return r.text().then(function (text) {
            var msg = text
            try {
              var body = JSON.parse(text)
              if (body && body.error) msg = body.error
            } catch (e2) {}
            throw new Error(msg || 'error ' + r.status)
          })
        }
        var dispo = r.headers.get('content-disposition') || ''
        var m = dispo.match(/filename="([^"]+)"/)
        return r.blob().then(function (blob) {
          var a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = m ? m[1] : 'sample-logs.' + payload.format
          ;(container || document.body).appendChild(a)
          a.click()
          a.remove()
          setTimeout(function () {
            URL.revokeObjectURL(a.href)
          }, 10000)
          onStatus('Logs exported (copy in the reports folder).', 'ok')
        })
      })
      .catch(function (e) {
        onStatus('Export failed: ' + e.message, 'err')
      })
  }

  els.exportWrap.addEventListener('click', function (ev) {
    var kind = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-export')
    if (!kind) return
    var parts = kind.split('-') // "scope-format"
    var payload = { scope: parts[0], format: parts[1] }
    if (payload.scope === 'filtered') {
      // el export de "lo visible" serializa lo que el cliente ya sabe que se ve
      payload.entries = getFilteredEntries()
      if (payload.entries.length === 0) {
        setExportStatus('No lines match the current filter.', 'err')
        return
      }
    }
    downloadExport(payload, null, setExportStatus)
  })

  // ---------- Controles ----------

  els.toggle.addEventListener('click', function () {
    open = !open
    els.body.hidden = !open
    els.caret.textContent = open ? '▲' : '▼'
    if (open) rebuild()
    else updateHeader()
  })

  els.chips.addEventListener('click', function (ev) {
    var chip = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-chip')
    if (!chip) return
    filter.chips[chip] = !filter.chips[chip]
    ev.target.classList.toggle('active', filter.chips[chip])
    rebuild()
  })

  els.search.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(function () {
      searchTimer = null
      filter.text = els.search.value.trim().toLowerCase()
      rebuild()
    }, 150)
  })

  function parseTimeInput(value) {
    if (!value) return null
    var ms = new Date(value).getTime()
    return isNaN(ms) ? null : ms
  }

  els.from.addEventListener('change', function () {
    filter.fromMs = parseTimeInput(els.from.value)
    rebuild()
  })
  els.to.addEventListener('change', function () {
    var ms = parseTimeInput(els.to.value)
    // datetime-local sin segundos: "hasta las 10:15" incluye 10:15:59.999
    filter.toMs = ms === null ? null : ms + 59999
    rebuild()
  })

  els.order.addEventListener('click', function () {
    filter.order = filter.order === 'asc' ? 'desc' : 'asc'
    els.order.textContent = filter.order === 'asc' ? '↓ old→new' : '↑ new→old'
    rebuild()
  })

  els.pause.addEventListener('click', function () {
    pausedManual = !pausedManual
    if (!pausedManual) {
      pausedScroll = false
      rebuild()
    } else {
      updateLiveBtn()
    }
  })

  els.live.addEventListener('click', function () {
    pausedManual = false
    pausedScroll = false
    rebuild()
  })

  // Pausa automática estilo consola: scrollear fuera del borde vivo pausa;
  // volver al borde reanuda (solo si la pausa fue automática, no el botón).
  els.scroll.addEventListener('scroll', function () {
    if (programmaticScroll) return
    var edge = atLiveEdge()
    if (!edge && !isPaused()) {
      pausedScroll = true
      updateLiveBtn()
    } else if (edge && pausedScroll && !pausedManual) {
      pausedScroll = false
      if (newSincePause > 0) rebuild()
      else updateLiveBtn()
    }
  })

  updateHeader()
  updateLiveBtn()

  window.LogsPanel = {
    onLogs: onLogs,
    bootstrap: bootstrap,
    clear: clear,
    getFilteredEntries: getFilteredEntries,
    downloadExport: downloadExport,
  }
})()
