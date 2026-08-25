/**
 * live.js — WebSocket client for the LIVE dashboard (ticket 021).
 * Connects to /ws on the same origin, receives {type:"device"|"sample"|"app"|"flow"|"logs"}
 * messages, and drives ProfilerDashboard (render.js) + LogsPanel (logsPanel.js).
 * Auto-reconnects if the socket drops. También maneja el selector de apps
 * (dropdown del header + /api/packages).
 */
;(function () {
  'use strict'

  ProfilerDashboard.init()

  var pkg = null
  var device = null
  var reconnectDelay = 1000
  // El mismo dashboard se reutiliza dentro de cada mitad del split. Cada iframe sólo
  // procesa su propio carril y nunca puede cambiar el sampler de la otra mitad.
  var pane =
    new URLSearchParams(location.search).get('pane') === 'secondary' ? 'secondary' : 'primary'
  var paneQuery = 'pane=' + pane
  var isEmbeddedPane = new URLSearchParams(location.search).has('pane')
  var dualInspectorStyle = null

  function setDualInspectorHidden(hidden) {
    if (!isEmbeddedPane) return
    if (hidden && !dualInspectorStyle) {
      dualInspectorStyle = document.createElement('style')
      dualInspectorStyle.textContent =
        '#inspToggle,#inspWarn,#inspector,[data-cap="network"]{display:none!important}'
      document.head.appendChild(dualInspectorStyle)
    } else if (!hidden && dualInspectorStyle) {
      dualInspectorStyle.remove()
      dualInspectorStyle = null
    }
  }

  if (isEmbeddedPane) {
    window.addEventListener('message', function (event) {
      if (event.origin !== location.origin || !event.data || event.data.type !== 'dual-inspector')
        return
      setDualInspectorHidden(event.data.hidden === true)
    })
  }

  // Logs e inspector pertenecen a la sesión A; B sólo presenta sus métricas.
  if (isEmbeddedPane && pane === 'secondary') {
    var secondaryStyle = document.createElement('style')
    secondaryStyle.textContent = '#logs,#inspector{display:none!important}'
    document.head.appendChild(secondaryStyle)
  }

  /** Activa dos instancias del dashboard existente en iframes del mismo origen. Así cada
   * panel conserva sus charts, resize handlers y estado sin copiar miles de líneas de UI. */
  function installDualToggle() {
    if (isEmbeddedPane) return
    var button = document.createElement('button')
    button.type = 'button'
    button.id = 'dualToggle'
    button.className = 'chip'
    button.textContent = '⇄ Dual comparison'
    button.title = 'Compare two connected devices side by side'
    var header = document.querySelector('header .header-right')
    if (!header) return
    header.insertBefore(button, header.firstChild)

    function closeDual() {
      fetch('/api/dual', { method: 'POST', body: JSON.stringify({ enabled: false }) }).catch(
        function () {},
      )
      var root = document.getElementById('dualRoot')
      if (root) root.remove()
      document.body.style.overflow = ''
      button.textContent = '⇄ Dual comparison'
      button.classList.remove('active')
    }

    function openDual() {
      fetch('/api/dual', { method: 'POST', body: JSON.stringify({ enabled: true }) })
        .then(function (r) {
          if (!r.ok) throw new Error('could not enable dual mode')
          var root = document.createElement('div')
          root.id = 'dualRoot'
          root.innerHTML =
            '<div class="dual-toolbar"><strong>Dual comparison</strong><span>Device A and B stream independently</span><button type="button">Exit dual mode</button></div>' +
            '<div class="dual-panels"><iframe title="Device A metrics" src="/?pane=primary"></iframe><iframe title="Device B metrics" src="/?pane=secondary"></iframe></div>'
          root.querySelector('button').addEventListener('click', closeDual)
          document.body.appendChild(root)
          // El panel A puede ser Android y anunciarse antes que B: ocultarlo desde el
          // primer frame, sin depender de la plataforma de los devices.
          var frames = root.querySelectorAll('iframe')
          for (var i = 0; i < frames.length; i++) {
            frames[i].addEventListener('load', function () {
              this.contentWindow.postMessage(
                { type: 'dual-inspector', hidden: true },
                location.origin,
              )
            })
          }
          document.body.style.overflow = 'hidden'
          button.textContent = 'Dual comparison active'
          button.classList.add('active')
        })
        .catch(function () {
          button.title = 'Could not enable dual comparison'
        })
    }
    button.addEventListener('click', function () {
      if (document.getElementById('dualRoot')) closeDual()
      else openDual()
    })
  }

  if (!isEmbeddedPane) {
    var dualStyle = document.createElement('style')
    dualStyle.textContent =
      '#dualRoot{position:fixed;inset:0;z-index:10000;background:var(--bg,#10151c);display:grid;grid-template-rows:48px minmax(0,1fr)}' +
      '.dual-toolbar{display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid rgba(255,255,255,.15);font:600 13px Inter,system-ui,sans-serif}' +
      '.dual-toolbar span{opacity:.72;font-weight:400;flex:1}.dual-toolbar button{border:0;border-radius:7px;padding:7px 10px;cursor:pointer}' +
      '.dual-panels{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:2px;background:rgba(255,255,255,.2);min-height:0}' +
      '.dual-panels iframe{border:0;width:100%;height:100%;background:#10151c}' +
      '@media(max-width:900px){.dual-panels{grid-template-columns:1fr;overflow:auto}.dual-panels iframe{min-height:760px}}'
    document.head.appendChild(dualStyle)
    installDualToggle()
  }

  // --- Micro-animaciones (Motion vendoreado; feedback HITL 2026-08-01) ---
  // Guardas: sin window.Motion (archivo faltante) o con prefers-reduced-motion
  // todo funciona igual, sin animar.
  var REDUCED_MOTION =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  function canAnimate() {
    return !REDUCED_MOTION && typeof window.Motion !== 'undefined'
  }
  // fade+drop sutil de los popovers del header (device / app)
  function animPopoverIn(el) {
    if (!canAnimate() || !el) return
    try {
      window.Motion.animate(
        el,
        { opacity: [0, 1], transform: ['translateY(-6px)', 'translateY(0)'] },
        { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
      )
    } catch (e) {}
  }

  // --- Selector de apps (dropdown del header) ---
  var appSel = {
    btn: document.getElementById('appPkgBtn'),
    pop: document.getElementById('appPop'),
    search: document.getElementById('appSearch'),
    chip: document.getElementById('appChip'),
    sys: document.getElementById('appSys'),
    list: document.getElementById('appList'),
    empty: document.getElementById('appEmpty'),
    pkgLabel: document.getElementById('appPkg'),
    launched: document.getElementById('appLaunched'),
  }
  var chipOn = true // filtro default: solo apps que matchean filterTerm ("sample")
  var appData = null // {packages, usage, filterTerm, current} del último fetch
  var appSwitching = false

  function onAppStatus(app) {
    // cambio de app: las series del timeline y los logs son de la app anterior — resetear
    if (pkg && pkg !== app.packageName) {
      ProfilerDashboard.resetSeries()
      LogsPanel.clear()
    }
    pkg = app.packageName
    appSel.pkgLabel.textContent = app.packageName
    // el hero de FPS usa este estado para distinguir "app not running" de "no data"
    ProfilerDashboard.setAppRunning(app.pid !== null)
    if (app.pid === null) {
      appSel.launched.textContent = device ? 'waiting for process…' : 'waiting for device…'
      appSel.launched.className = 'app-launched waiting'
      appSel.launched.hidden = false
    } else if (app.launched) {
      appSel.launched.textContent = '🚀 launched'
      appSel.launched.className = 'app-launched'
      appSel.launched.hidden = false
    } else {
      appSel.launched.hidden = true
    }
  }

  function loadPackages() {
    var url = '/api/packages?' + paneQuery + (appSel.sys.checked ? '&system=1' : '')
    appSel.empty.hidden = false
    appSel.empty.textContent = 'Loading device apps…'
    fetch(url)
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        appData = data
        // el término del chip es configurable (apps.json), no hardcodeado acá
        appSel.chip.textContent = data.filterTerm.charAt(0).toUpperCase() + data.filterTerm.slice(1)
        renderAppList()
      })
      .catch(function () {
        appSel.empty.textContent = 'Could not list the apps.'
      })
  }

  function renderAppList() {
    if (!appData) return
    var term = chipOn ? appData.filterTerm : appSel.search.value.trim()
    term = term.toLowerCase()
    var shown = appData.packages.filter(function (p) {
      return !term || p.toLowerCase().indexOf(term) !== -1
    })
    appSel.list.innerHTML = ''
    appSel.empty.hidden = shown.length > 0
    appSel.empty.textContent = 'No results.'
    shown.forEach(function (p) {
      var li = document.createElement('li')
      var b = document.createElement('button')
      b.type = 'button'
      if (p === pkg) b.className = 'current'
      var name = document.createElement('span')
      name.textContent = (p === pkg ? '✓ ' : '') + p
      b.appendChild(name)
      var uses = appData.usage[p]
      if (uses) {
        var u = document.createElement('span')
        u.className = 'app-use'
        u.textContent = uses + '×'
        b.appendChild(u)
      }
      b.addEventListener('click', function () {
        selectApp(p)
      })
      li.appendChild(b)
      appSel.list.appendChild(li)
    })
  }

  function selectApp(p) {
    if (appSwitching || p === pkg) {
      closeAppPop()
      return
    }
    appSwitching = true
    appSel.pkgLabel.textContent = p + ' — switching…'
    closeAppPop()
    fetch('/api/app', { method: 'POST', body: JSON.stringify({ package: p, pane: pane }) })
      .then(function (r) {
        if (!r.ok) throw new Error('switch failed')
        // el estado real llega por WS ({type:"app"}) — acá no hay nada más que hacer
      })
      .catch(function () {
        appSel.pkgLabel.textContent = pkg || '—'
      })
      .finally(function () {
        appSwitching = false
      })
  }

  function closeAppPop() {
    appSel.pop.hidden = true
  }

  appSel.btn.addEventListener('click', function (e) {
    e.stopPropagation()
    appSel.pop.hidden = !appSel.pop.hidden
    if (!appSel.pop.hidden) {
      animPopoverIn(appSel.pop)
      loadPackages()
      appSel.search.focus()
    }
  })
  appSel.search.addEventListener('input', function () {
    // escribir apaga el chip: la búsqueda es sobre todas las apps listadas
    if (appSel.search.value.trim()) chipOn = false
    appSel.chip.classList.toggle('active', chipOn)
    renderAppList()
  })
  appSel.chip.addEventListener('click', function () {
    chipOn = !chipOn
    if (chipOn) appSel.search.value = ''
    appSel.chip.classList.toggle('active', chipOn)
    renderAppList()
  })
  appSel.sys.addEventListener('change', loadPackages)
  appSel.pop.addEventListener('click', function (e) {
    e.stopPropagation()
  })

  // --- Selector de device (ficha del header + refresh) ---
  var devSel = {
    btn: document.getElementById('devBtn'),
    pop: document.getElementById('devPop'),
    list: document.getElementById('devList'),
    empty: document.getElementById('devEmpty'),
    refresh: document.getElementById('devRefresh'),
  }
  var devSwitching = false

  function loadDevices() {
    devSel.empty.hidden = false
    devSel.empty.textContent = 'Looking for devices…'
    devSel.list.innerHTML = ''
    fetch('/api/devices')
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        renderDeviceList(data)
      })
      .catch(function () {
        devSel.empty.textContent = 'Could not list the devices.'
      })
  }

  function renderDeviceList(data) {
    devSel.list.innerHTML = ''
    devSel.empty.hidden = data.devices.length > 0
    devSel.empty.textContent = 'No devices. Plug in via USB and hit Refresh.'
    data.devices.forEach(function (d) {
      var li = document.createElement('li')
      var b = document.createElement('button')
      b.type = 'button'
      var isCurrent = d.serial === (pane === 'secondary' ? data.secondary : data.current)
      if (isCurrent) b.className = 'current'
      // "model:SM_A155M product:a15ub ..." → SM A155M
      var modelMatch = (d.description || '').match(/model:(\S+)/)
      var label = modelMatch ? modelMatch[1].replace(/_/g, ' ') : d.serial
      var isIos = d.platform === 'ios'
      var name = document.createElement('span')
      name.className = 'dev-item-name'
      // El iPhone entra a la MISMA lista que los Android (ticket 035); la plataforma es
      // sólo una etiqueta. La versión de iOS va al label porque en iOS es lo que importa.
      var iosVer = (d.description || '').match(/ios:(\S+)/)
      name.textContent =
        (isCurrent ? '✓ ' : '') + label + (isIos ? ' · iOS ' + (iosVer ? iosVer[1] : '?') : '')
      var serial = document.createElement('span')
      serial.className = 'dev-serial'
      serial.textContent = d.serial
      b.appendChild(name)
      b.appendChild(serial)
      if (d.state !== 'device') {
        // unauthorized/offline: visible pero no elegible
        var state = document.createElement('span')
        state.className = 'dev-state'
        state.textContent = d.state
        b.appendChild(state)
        b.disabled = true
      } else {
        b.addEventListener('click', function () {
          selectDevice(d.serial)
        })
      }
      li.appendChild(b)
      devSel.list.appendChild(li)
    })
  }

  function selectDevice(serial) {
    if (devSwitching) return
    devSwitching = true
    closeDevPop()
    document.getElementById('devName').textContent = 'Switching device…'
    fetch('/api/device', { method: 'POST', body: JSON.stringify({ serial: serial, pane: pane }) })
      .then(function (r) {
        if (!r.ok) throw new Error('switch failed')
        // la ficha nueva llega por WS ({type:"device"} + {type:"app"})
      })
      .catch(function () {
        if (device) ProfilerDashboard.setDevice(device, pkg)
      })
      .finally(function () {
        devSwitching = false
      })
  }

  function closeDevPop() {
    devSel.pop.hidden = true
  }

  devSel.btn.addEventListener('click', function (e) {
    e.stopPropagation()
    devSel.pop.hidden = !devSel.pop.hidden
    if (!devSel.pop.hidden) {
      animPopoverIn(devSel.pop)
      loadDevices()
    }
  })
  devSel.refresh.addEventListener('click', function (e) {
    e.stopPropagation()
    loadDevices()
  })
  devSel.pop.addEventListener('click', function (e) {
    e.stopPropagation()
  })

  // --- Menú ☰: side drawer con export, registros de sesiones y configuración
  // (feedback HITL 2026-08-01: era dropdown; ahora panel lateral + backdrop) ---
  var menu = {
    btn: document.getElementById('menuBtn'),
    pop: document.getElementById('menuPop'),
    backdrop: document.getElementById('menuBackdrop'),
    exportRow: document.getElementById('exportRow'),
    exportStatus: document.getElementById('exportStatus'),
    sessList: document.getElementById('sessList'),
    sessEmpty: document.getElementById('sessEmpty'),
    sessRefresh: document.getElementById('sessRefresh'),
    cfgFilter: document.getElementById('cfgFilter'),
    cfgInterval: document.getElementById('cfgInterval'),
    cfgFps: document.getElementById('cfgFps'),
    cfgTheme: document.getElementById('cfgTheme'),
    cfgReports: document.getElementById('cfgReports'),
    cfgSave: document.getElementById('cfgSave'),
    cfgStatus: document.getElementById('cfgStatus'),
  }

  function setStatus(el, msg, kind) {
    el.textContent = msg || ''
    el.className = 'menu-status' + (kind ? ' ' + kind : '')
  }

  // Las respuestas de error pueden ser texto plano (p.ej. 403 'Forbidden origin'):
  // leer como texto y try-parsear JSON; si no parsea, mostrar el texto crudo.
  function errorFromResponse(r) {
    return r.text().then(function (text) {
      var msg = text
      try {
        var body = JSON.parse(text)
        if (body && body.error) msg = body.error
      } catch (e) {}
      return new Error(msg || 'error ' + r.status)
    })
  }

  // Descarga vía blob (no navegación): un error del server se muestra, no rompe la página.
  function downloadReport(query, statusEl) {
    setStatus(statusEl, 'Generating report…')
    fetch('/api/report?' + query)
      .then(function (r) {
        if (!r.ok) {
          return errorFromResponse(r).then(function (err) {
            throw err
          })
        }
        var dispo = r.headers.get('content-disposition') || ''
        var m = dispo.match(/filename="([^"]+)"/)
        return r.blob().then(function (blob) {
          var a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = m ? m[1] : 'sample-report.html'
          // dentro del popover: el click sintético no burbujea a document (cerraría el menú)
          menu.pop.appendChild(a)
          a.click()
          a.remove()
          setTimeout(function () {
            URL.revokeObjectURL(a.href)
          }, 10000)
          setStatus(statusEl, 'Report downloaded (copy in the reports folder).', 'ok')
        })
      })
      .catch(function (e) {
        setStatus(statusEl, 'Export failed: ' + e.message, 'err')
      })
  }

  menu.exportRow.addEventListener('click', function (e) {
    var w = e.target && e.target.getAttribute && e.target.getAttribute('data-window')
    if (w) downloadReport('window=' + w, menu.exportStatus)
  })

  function fmtDur(s) {
    if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
    if (s >= 60) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
    return s + 's'
  }

  function loadSessions() {
    menu.sessEmpty.hidden = false
    menu.sessEmpty.textContent = 'Loading…'
    menu.sessList.innerHTML = ''
    fetch('/api/sessions')
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        menu.sessEmpty.hidden = data.sessions.length > 0
        menu.sessEmpty.textContent = 'No saved sessions.'
        data.sessions.forEach(function (s) {
          var li = document.createElement('li')
          li.className = 'sess-item'
          var b = document.createElement('button')
          b.type = 'button'
          var metaBox = document.createElement('span')
          metaBox.className = 'sess-meta'
          var date = document.createElement('span')
          date.className = 'sess-date'
          var d = new Date(s.startedAt)
          date.textContent =
            d.toLocaleDateString() +
            ' ' +
            d.toLocaleTimeString().slice(0, 5) +
            (s.id === data.current ? ' · in progress' : '')
          if (s.id === data.current) b.className = 'current'
          var sub = document.createElement('span')
          sub.className = 'sess-sub'
          sub.textContent = fmtDur(s.durationS) + ' · ' + (s.packages.join(', ') || '—')
          metaBox.appendChild(date)
          metaBox.appendChild(sub)
          var dl = document.createElement('span')
          dl.className = 'app-use'
          dl.textContent = '⬇ report'
          b.appendChild(metaBox)
          b.appendChild(dl)
          b.addEventListener('click', function () {
            downloadReport('session=' + encodeURIComponent(s.id), menu.exportStatus)
          })
          li.appendChild(b)
          // export de logs de la sesión (ticket 029): .txt / .jsonl junto al reporte;
          // sesión sin archivo de logs ⇒ botones deshabilitados, sin error
          ;['txt', 'jsonl'].forEach(function (fmt) {
            var lb = document.createElement('button')
            lb.type = 'button'
            lb.className = 'app-chip'
            lb.textContent = '⬇ .' + fmt
            if (s.hasLogs) {
              lb.title = 'Export the session logs (.' + fmt + ')'
              lb.addEventListener('click', function (e) {
                e.stopPropagation()
                LogsPanel.downloadExport(
                  { scope: 'session', format: fmt, sessionId: s.id },
                  menu.pop,
                  function (msg, kind) {
                    setStatus(menu.exportStatus, msg, kind)
                  },
                )
              })
            } else {
              lb.disabled = true
              lb.title = 'Session without saved logs'
            }
            li.appendChild(lb)
          })
          menu.sessList.appendChild(li)
        })
      })
      .catch(function () {
        menu.sessEmpty.textContent = 'Could not load the history.'
      })
  }

  function fillConfig(cfg, effectiveIntervalMs) {
    menu.cfgFilter.value = cfg.filterTerm
    menu.cfgTheme.checked = cfg.theme === 'dark'
    // auto (default): el server resuelve el intervalo según el device (gama baja → 2 s)
    menu.cfgInterval.value = cfg.intervalAuto ? 'auto' : String(cfg.intervalMs)
    if (typeof effectiveIntervalMs === 'number') {
      menu.cfgInterval.options[0].textContent = 'Auto (' + effectiveIntervalMs / 1000 + ' s)'
    }
    menu.cfgReports.value = cfg.reportsDir
    menu.cfgFps.value = cfg.fpsTarget
    // el semáforo del donut usa el target al toque (aplica en caliente, ticket 025)
    ProfilerDashboard.setFpsTarget(cfg.fpsTarget)
  }

  function loadConfig(applyTheme) {
    return fetch('/api/config')
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        fillConfig(data.config, data.effectiveIntervalMs)
        if (applyTheme) ProfilerDashboard.setTheme(data.config.theme)
        // estado real del inspector (pudo arrancar prendido con --inspect)
        if (data.inspector) setInspectorUi(data.inspector.enabled)
        return data.config
      })
  }

  menu.cfgSave.addEventListener('click', function () {
    var patch = {
      filterTerm: menu.cfgFilter.value.trim(),
      theme: menu.cfgTheme.checked ? 'dark' : 'light',
      reportsDir: menu.cfgReports.value.trim(),
      // el server valida el rango (1–240); inválido ⇒ lo ignora y fillConfig
      // repone el valor vigente con la respuesta
      fpsTarget: Number(menu.cfgFps.value),
    }
    // "auto" delega el intervalo al server (según device); un valor concreto = manual
    if (menu.cfgInterval.value === 'auto') patch.intervalAuto = true
    else patch.intervalMs = Number(menu.cfgInterval.value)
    setStatus(menu.cfgStatus, 'Saving…')
    fetch('/api/config', { method: 'PUT', body: JSON.stringify(patch) })
      .then(function (r) {
        if (!r.ok) throw new Error('error ' + r.status)
        return r.json()
      })
      .then(function (data) {
        fillConfig(data.config, data.effectiveIntervalMs)
        // el chip del selector de apps refleja el término nuevo
        appSel.chip.textContent =
          data.config.filterTerm.charAt(0).toUpperCase() + data.config.filterTerm.slice(1)
        appData = null // el próximo open re-fetchea con el filtro nuevo
        setStatus(menu.cfgStatus, 'Saved ✓', 'ok')
      })
      .catch(function (e) {
        setStatus(menu.cfgStatus, 'Could not save: ' + e.message, 'err')
      })
  })

  // Drawer: slide-in desde la derecha + fade del backdrop (Motion; sin Motion o
  // con prefers-reduced-motion aparece/desaparece instantáneo).
  function slideMenu(open, done) {
    if (!canAnimate()) {
      if (done) done()
      return
    }
    try {
      window.Motion.animate(
        menu.pop,
        {
          transform: open
            ? ['translateX(102%)', 'translateX(0%)']
            : ['translateX(0%)', 'translateX(102%)'],
        },
        open
          ? { type: 'spring', stiffness: 320, damping: 34 }
          : { duration: 0.22, ease: [0.4, 0, 1, 1] },
      )
      var fade = window.Motion.animate(
        menu.backdrop,
        { opacity: open ? [0, 1] : [1, 0] },
        { duration: open ? 0.25 : 0.2 },
      )
      if (done) fade.finished.then(done, done)
    } catch (e) {
      if (done) done()
    }
  }
  function openMenuPop() {
    if (!menu.pop.hidden) return
    menu.pop.hidden = false
    menu.backdrop.hidden = false
    menu.pop.style.transform = '' // limpia un close interrumpido
    slideMenu(true)
    setStatus(menu.exportStatus, '')
    setStatus(menu.cfgStatus, '')
    loadSessions()
    void loadConfig(false)
  }
  function closeMenuPop() {
    if (menu.pop.hidden) return
    slideMenu(false, function () {
      menu.pop.hidden = true
      menu.backdrop.hidden = true
    })
  }
  menu.btn.addEventListener('click', function (e) {
    e.stopPropagation()
    if (menu.pop.hidden) openMenuPop()
    else closeMenuPop()
  })
  menu.sessRefresh.addEventListener('click', function (e) {
    e.stopPropagation()
    loadSessions()
  })
  menu.pop.addEventListener('click', function (e) {
    e.stopPropagation()
  })
  // click en el backdrop: burbujea a document → closePops. Escape: idem.

  // Tema persistido: aplicar el guardado al cargar. El control vive en ☰
  // Settings (switch "Dark mode" — feedback HITL 2026-08-01, revierte el toggle
  // ☀️ del header): aplica y persiste al instante vía /api/config (sin Guardar).
  void loadConfig(true)
  function persistTheme(theme) {
    ProfilerDashboard.setTheme(theme)
    fetch('/api/config', { method: 'PUT', body: JSON.stringify({ theme: theme }) }).catch(
      function () {},
    )
  }
  menu.cfgTheme.addEventListener('change', function () {
    persistTheme(menu.cfgTheme.checked ? 'dark' : 'light')
  })

  function closePops() {
    closeAppPop()
    closeDevPop()
    closeMenuPop()
  }
  document.addEventListener('click', closePops)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePops()
  })

  // --- Toggle del inspector HTTP (proxy del device, en caliente) ---
  var inspBtn = document.getElementById('inspToggle')
  var inspStateEl = document.getElementById('inspState')
  var inspectorOn = false

  function setInspectorUi(on) {
    inspectorOn = on
    inspStateEl.textContent = on ? 'ON' : 'OFF'
    inspBtn.classList.toggle('on', on)
    // aviso del proxy (feedback HITL 2026-08-01): con el inspector ON, desenchufar
    // el celu lo deja sin internet — el aviso vive junto al toggle mientras esté ON
    document.getElementById('inspWarn').hidden = !on
    if (on) {
      // mostrar la tabla ya (aunque todavía no haya flows) para que se vea que graba
      var section = document.getElementById('inspector')
      if (section) section.hidden = false
    }
  }

  inspBtn.addEventListener('click', function () {
    inspBtn.disabled = true
    fetch('/api/inspector', { method: 'POST', body: JSON.stringify({ enabled: !inspectorOn }) })
      .then(function (r) {
        if (!r.ok) {
          return errorFromResponse(r).then(function (err) {
            throw err
          })
        }
        return r.json()
      })
      .then(function (body) {
        setInspectorUi(body.inspector.enabled)
      })
      .catch(function (e) {
        inspStateEl.textContent = 'ERR'
        inspBtn.title = 'Could not toggle the inspector: ' + e.message
        setTimeout(function () {
          setInspectorUi(inspectorOn)
        }, 2500)
      })
      .finally(function () {
        inspBtn.disabled = false
      })
  })

  // --- Network inspector (tabla de requests en vivo, debajo de la red) ---
  var flowCount = 0
  function fmtBytes(b) {
    if (!b) return '—'
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB'
    if (b > 1024) return (b / 1024).toFixed(1) + ' KB'
    return b + ' B'
  }
  function addFlow(f) {
    var section = document.getElementById('inspector')
    if (section && section.hidden) section.hidden = false // aparece al primer flow
    var empty = document.getElementById('flowEmpty')
    if (empty) empty.style.display = 'none'
    var rows = document.getElementById('flowRows')
    if (!rows) return
    flowCount++
    var n = document.getElementById('flowN')
    if (n) n.textContent = flowCount
    // Celdas via textContent, nunca innerHTML: host/URL/método vienen del tráfico
    // interceptado (cualquier proceso del device los controla) — son input hostil.
    var tr = document.createElement('tr')
    function td(cls, content) {
      var cell = document.createElement('td')
      if (cls) cell.className = cls
      if (typeof content === 'string') cell.textContent = content
      else if (content) cell.appendChild(content)
      tr.appendChild(cell)
    }
    td('insp-time', new Date(f.ts).toLocaleTimeString())
    var method = document.createElement('span')
    method.className = 'insp-m ' + (f.kind === 'https' ? 'https' : 'http')
    method.textContent = f.method
    td(null, method)
    td('insp-host', f.host)
    td(null, f.url || '')
    var status = document.createElement('span')
    if (f.status && f.status >= 200 && f.status < 300) {
      status.className = 'insp-ok'
      status.textContent = String(f.status)
    } else if (f.status && f.status > 0) {
      status.textContent = String(f.status)
    } else {
      status.className = 'insp-err'
      status.textContent = '—'
    }
    td(null, status)
    td(null, fmtBytes(f.bytes || 0))
    rows.prepend(tr)
    while (rows.children.length > 500) rows.removeChild(rows.lastChild)
  }

  // --- Señales de perf derivadas del stream de logs (rediseño 031/032) ---
  // Crash: MISMO criterio que crashBlocks del reporte (reportLogs.ts): entradas
  // isCrash con gap ≤ CRASH_BLOCK_GAP_MS son el mismo bloque, SIN mirar el pid —
  // un crash nativo llega con DOS pids (la línea "F libc" con el pid de la app,
  // los frames del tombstone con el pid de crash_dump64) y aun así es UN crash.
  // GC: las líneas del ART ("GC freed…") ponen el punto ámbar sobre el trend de
  // PSS. Ambas son best-effort — solo miran lo que ya llega por WS.
  // Espejo hardcodeado de CRASH_BLOCK_GAP_MS (src/core/logs/reportLogs.ts):
  // live.js es JS plano servido estático y no puede importar el core TS.
  // GUARDIA: src/ui/mirrors.test.ts compara este valor contra el del core.
  var CRASH_BLOCK_GAP_MS = 2000
  var lastCrashTs = null
  var GC_RE = /\bGC freed\b|concurrent copying GC|concurrent mark compact GC/

  function scanLogSignals(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]
      if (e.isCrash) {
        if (lastCrashTs === null || e.ts - lastCrashTs > CRASH_BLOCK_GAP_MS) {
          ProfilerDashboard.noteCrash(e.ts)
        }
        lastCrashTs = e.ts
      } else if (GC_RE.test(e.message)) {
        ProfilerDashboard.noteGc(e.ts)
      }
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws'
    var ws = new WebSocket(proto + '://' + location.host + '/ws')

    ws.addEventListener('open', function () {
      reconnectDelay = 1000
      ProfilerDashboard.setConnected(true)
      // bootstrap del panel de logs (últimas N del ring del server); el merge
      // dedupea contra lo que llegue por WS mientras tanto (ticket 028)
      if (pane === 'primary') LogsPanel.bootstrap()
    })

    ws.addEventListener('message', function (ev) {
      var msg
      try {
        msg = JSON.parse(ev.data)
      } catch (e) {
        return
      }
      // Los mensajes sin pane son los de versiones anteriores y equivalen al panel A.
      if (
        (msg.type === 'device' ||
          msg.type === 'sample' ||
          msg.type === 'app' ||
          msg.type === 'connection') &&
        (msg.pane || 'primary') !== pane
      ) {
        return
      }
      if (pane === 'secondary' && (msg.type === 'flow' || msg.type === 'logs')) return
      if (msg.type === 'device') {
        // cambio de device: las series del timeline y los logs son del device anterior
        if (device && device.serial !== msg.device.serial) {
          ProfilerDashboard.resetSeries()
          LogsPanel.clear()
        }
        device = msg.device
        // Capacidades de la plataforma (ticket 040): se esconde lo que en este device NO
        // EXISTE (temperatura de SoC en iOS, torta de memoria, frame-times, red, logs).
        // Lo que existe pero falló este tick sigue mostrándose en N/A.
        if (typeof Capabilities !== 'undefined') {
          Capabilities.apply(document, msg.capabilities)
          var pssLbl = document.getElementById('pssLbl')
          if (pssLbl) pssLbl.textContent = Capabilities.memoryLabel(device.platform)
        }
        // el package lo anuncia el server con {type:"app"} — acá solo la ficha
        ProfilerDashboard.setDevice(device, pkg)
      } else if (msg.type === 'sample') {
        ProfilerDashboard.render(msg.sample)
      } else if (msg.type === 'flow') {
        addFlow(msg.flow)
      } else if (msg.type === 'app') {
        onAppStatus(msg.app)
      } else if (msg.type === 'logs') {
        scanLogSignals(msg.entries)
        LogsPanel.onLogs(msg.entries)
      } else if (msg.type === 'connection') {
        // Estado del CABLE con el device, no del WS (ticket 046). Llega en cada transición
        // y también al abrir, porque la ficha {type:'device'} es del último device conocido
        // y sin esto un dashboard abierto tarde pintaría un teléfono que no está.
        ProfilerDashboard.setDeviceState(msg.state)
      }
    })

    ws.addEventListener('close', function () {
      ProfilerDashboard.setConnected(false)
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 1.5, 8000)
    })

    ws.addEventListener('error', function () {
      try {
        ws.close()
      } catch (e) {}
    })
  }

  connect()
})()
