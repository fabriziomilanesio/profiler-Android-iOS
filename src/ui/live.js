/**
 * live.js — WebSocket client for the LIVE dashboard (ticket 021).
 * Connects to /ws on the same origin, receives {type:"device"|"sample"|"app"|"flow"}
 * messages, and drives ProfilerDashboard (render.js). Auto-reconnects if the socket
 * drops. También maneja el selector de apps (dropdown del header + /api/packages).
 */
;(function () {
  'use strict'

  ProfilerDashboard.init()

  var pkg = null
  var device = null
  var reconnectDelay = 1000

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
  var chipOn = true // filtro default: solo apps que matchean filterTerm ("evermore")
  var appData = null // {packages, usage, filterTerm, current} del último fetch
  var appSwitching = false

  function onAppStatus(app) {
    // cambio de app: las series del timeline son de la app anterior — resetear
    if (pkg && pkg !== app.packageName) ProfilerDashboard.resetSeries()
    pkg = app.packageName
    appSel.pkgLabel.textContent = app.packageName
    if (app.pid === null) {
      appSel.launched.textContent = device ? 'esperando proceso…' : 'esperando device…'
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
    var url = '/api/packages' + (appSel.sys.checked ? '?system=1' : '')
    appSel.empty.hidden = false
    appSel.empty.textContent = 'Cargando apps del device…'
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
        appSel.empty.textContent = 'No se pudo listar las apps.'
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
    appSel.empty.textContent = 'Sin resultados.'
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
    appSel.pkgLabel.textContent = p + ' — cambiando…'
    closeAppPop()
    fetch('/api/app', { method: 'POST', body: JSON.stringify({ package: p }) })
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
    devSel.empty.textContent = 'Buscando devices…'
    devSel.list.innerHTML = ''
    fetch('/api/devices')
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        renderDeviceList(data)
      })
      .catch(function () {
        devSel.empty.textContent = 'No se pudo listar los devices.'
      })
  }

  function renderDeviceList(data) {
    devSel.list.innerHTML = ''
    devSel.empty.hidden = data.devices.length > 0
    devSel.empty.textContent = 'Sin devices. Conectá por USB y tocá Refrescar.'
    data.devices.forEach(function (d) {
      var li = document.createElement('li')
      var b = document.createElement('button')
      b.type = 'button'
      var isCurrent = d.serial === data.current
      if (isCurrent) b.className = 'current'
      // "model:SM_A155M product:a15ub ..." → SM A155M
      var modelMatch = (d.description || '').match(/model:(\S+)/)
      var label = modelMatch ? modelMatch[1].replace(/_/g, ' ') : d.serial
      var name = document.createElement('span')
      name.className = 'dev-item-name'
      name.textContent = (isCurrent ? '✓ ' : '') + label
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
    document.getElementById('devName').textContent = 'Cambiando de device…'
    fetch('/api/device', { method: 'POST', body: JSON.stringify({ serial: serial }) })
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
    if (!devSel.pop.hidden) loadDevices()
  })
  devSel.refresh.addEventListener('click', function (e) {
    e.stopPropagation()
    loadDevices()
  })
  devSel.pop.addEventListener('click', function (e) {
    e.stopPropagation()
  })

  function closePops() {
    closeAppPop()
    closeDevPop()
  }
  document.addEventListener('click', closePops)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePops()
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

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws'
    var ws = new WebSocket(proto + '://' + location.host + '/ws')

    ws.addEventListener('open', function () {
      reconnectDelay = 1000
      ProfilerDashboard.setConnected(true)
    })

    ws.addEventListener('message', function (ev) {
      var msg
      try {
        msg = JSON.parse(ev.data)
      } catch (e) {
        return
      }
      if (msg.type === 'device') {
        // cambio de device: las series del timeline son del device anterior
        if (device && device.serial !== msg.device.serial) ProfilerDashboard.resetSeries()
        device = msg.device
        // el package lo anuncia el server con {type:"app"} — acá solo la ficha
        ProfilerDashboard.setDevice(device, pkg)
      } else if (msg.type === 'sample') {
        ProfilerDashboard.render(msg.sample)
      } else if (msg.type === 'flow') {
        addFlow(msg.flow)
      } else if (msg.type === 'app') {
        onAppStatus(msg.app)
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
