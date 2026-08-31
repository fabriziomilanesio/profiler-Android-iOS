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
  // El dashboard se reutiliza dentro de cada mitad del split. Cada iframe procesa un
  // carril independiente y reporta su plataforma al contenedor para decidir qué métricas
  // son realmente comparables.
  var searchParams = new URLSearchParams(location.search)
  var dataPane = searchParams.get('pane') === 'secondary' ? 'secondary' : 'primary'
  var pane = searchParams.get('slot') === 'secondary' ? 'secondary' : dataPane
  var isMirrorPane = pane === 'secondary' && dataPane === 'primary'
  var paneQuery = 'pane=' + dataPane
  var isEmbeddedPane = searchParams.has('pane')
  var dualInspectorStyle = null
  var dualFrameTimesStyle = null
  var dualLaunchStatusStyle = null
  var stickyDeviceEnabled = false
  var stickyDeviceCard = null
  var panelAppearance = null
  var ACCENTS = {
    magenta: '#eb008b',
    cyan: '#00a89e',
    violet: '#7c5ce6',
    amber: '#d88a00',
  }

  function defaultAppearance(whichPane) {
    return { theme: 'dark', accent: whichPane === 'secondary' ? 'cyan' : 'magenta' }
  }

  function appearanceStorageKey(whichPane) {
    return 'dualAppearance.' + whichPane
  }

  function readAppearance(whichPane) {
    try {
      var value = JSON.parse(localStorage.getItem(appearanceStorageKey(whichPane)) || 'null')
      if (value && (value.theme === 'dark' || value.theme === 'light') && ACCENTS[value.accent]) {
        return value
      }
    } catch (e) {}
    return defaultAppearance(whichPane)
  }

  function applyPanelAppearance(next, announce) {
    if (!isEmbeddedPane || !next) return
    panelAppearance = {
      theme: next.theme === 'light' ? 'light' : 'dark',
      accent: ACCENTS[next.accent] ? next.accent : defaultAppearance(pane).accent,
    }
    ProfilerDashboard.setTheme(panelAppearance.theme)
    var color = ACCENTS[panelAppearance.accent]
    document.body.style.setProperty('--accent', color)
    document.body.style.setProperty('--accent2', color)
    document.body.style.setProperty('--accent2-ink', color)
    try {
      localStorage.setItem(appearanceStorageKey(pane), JSON.stringify(panelAppearance))
    } catch (e) {}
    var themeInput = document.getElementById('panelTheme')
    if (themeInput) themeInput.checked = panelAppearance.theme === 'dark'
    var choices = document.querySelectorAll('#panelAccents [data-accent]')
    for (var i = 0; i < choices.length; i++) {
      choices[i].classList.toggle(
        'active',
        choices[i].getAttribute('data-accent') === panelAppearance.accent,
      )
    }
    if (announce !== false) {
      window.parent.postMessage(
        { type: 'dual-appearance', pane: pane, appearance: panelAppearance },
        location.origin,
      )
    }
  }

  if (isEmbeddedPane) {
    document.body.classList.add('dual-pane', 'dual-pane-' + pane)
    if (isMirrorPane) document.body.classList.add('dual-pane-mirror')
  }

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

  /** En Android+iOS no alcanza con que el iframe iOS oculte sus nulls: las tres métricas
   * también se ocultan en Android porque ya no existe un par que comparar. */
  function setDualFrameTimesComparable(comparable) {
    if (!isEmbeddedPane) return
    if (!comparable && !dualFrameTimesStyle) {
      dualFrameTimesStyle = document.createElement('style')
      dualFrameTimesStyle.textContent = '[data-cap="frameTimes"]{display:none!important}'
      document.head.appendChild(dualFrameTimesStyle)
    } else if (comparable && dualFrameTimesStyle) {
      dualFrameTimesStyle.remove()
      dualFrameTimesStyle = null
    }
  }

  function setDualLaunchStatusComparable(comparable) {
    if (!isEmbeddedPane) return
    if (!comparable && !dualLaunchStatusStyle) {
      dualLaunchStatusStyle = document.createElement('style')
      dualLaunchStatusStyle.textContent = '#appLaunched{display:none!important}'
      document.head.appendChild(dualLaunchStatusStyle)
    } else if (comparable && dualLaunchStatusStyle) {
      dualLaunchStatusStyle.remove()
      dualLaunchStatusStyle = null
    }
  }

  function stripIds(root) {
    root.removeAttribute('id')
    var withIds = root.querySelectorAll('[id]')
    for (var i = 0; i < withIds.length; i++) withIds[i].removeAttribute('id')
  }

  function syncStickyDeviceCard() {
    if (!isEmbeddedPane || !stickyDeviceEnabled) return
    var source = document.getElementById('devBtn')
    if (!source) return
    if (!stickyDeviceCard) {
      stickyDeviceCard = document.createElement('div')
      stickyDeviceCard.className = 'device-card card dual-sticky-card'
      document.body.appendChild(stickyDeviceCard)
    }
    var clone = source.cloneNode(true)
    stripIds(clone)
    clone.title = 'Back to device controls'
    clone.setAttribute('aria-label', 'Back to device controls')
    clone.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
    stickyDeviceCard.replaceChildren(clone)
  }

  function updateStickyDeviceCard() {
    if (!stickyDeviceCard) return
    var source = document.getElementById('devSelect')
    var pastSource = source && source.getBoundingClientRect().bottom <= 8
    stickyDeviceCard.classList.toggle('visible', stickyDeviceEnabled && Boolean(pastSource))
  }

  function setStickyDeviceEnabled(enabled) {
    if (!isEmbeddedPane) return
    stickyDeviceEnabled = enabled === true
    document.body.classList.toggle('dual-sticky-device', stickyDeviceEnabled)
    if (stickyDeviceEnabled) syncStickyDeviceCard()
    updateStickyDeviceCard()
  }

  if (isEmbeddedPane) {
    window.addEventListener('scroll', updateStickyDeviceCard, { passive: true })
    window.addEventListener('resize', updateStickyDeviceCard)
    window.addEventListener('message', function (event) {
      if (event.origin !== location.origin || !event.data) return
      if (event.data.type === 'dual-layout') {
        setDualInspectorHidden(event.data.hideInspector === true)
        setDualFrameTimesComparable(event.data.frameTimesComparable !== false)
        setDualLaunchStatusComparable(event.data.launchStatusComparable !== false)
        setStickyDeviceEnabled(event.data.stickyDevices === true)
        applyPanelAppearance(event.data.appearance, false)
      } else if (event.data.type === 'dual-shared-config' && event.data.config) {
        ProfilerDashboard.setFpsTarget(event.data.config.fpsTarget)
        appSel.chip.textContent =
          event.data.config.filterTerm.charAt(0).toUpperCase() +
          event.data.config.filterTerm.slice(1)
        appData = null
      }
    })
  }

  // El inspector pertenece a la sesión A; los logs siguen el carril de datos de cada panel.
  if (isEmbeddedPane && pane === 'secondary') {
    var secondaryStyle = document.createElement('style')
    secondaryStyle.textContent = '#inspToggle,#inspWarn,#inspector{display:none!important}'
    document.head.appendChild(secondaryStyle)
  }

  function stickyPreference() {
    try {
      return localStorage.getItem('dualStickyDevices') === 'true'
    } catch (e) {
      return false
    }
  }

  function saveStickyPreference(enabled) {
    try {
      localStorage.setItem('dualStickyDevices', String(enabled))
    } catch (e) {}
  }

  /** Activa dos instancias del dashboard existente en iframes del mismo origen. */
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

    var onPaneDevice = null

    function closeDual() {
      fetch('/api/dual', { method: 'POST', body: JSON.stringify({ enabled: false }) }).catch(
        function () {},
      )
      if (onPaneDevice) window.removeEventListener('message', onPaneDevice)
      onPaneDevice = null
      var root = document.getElementById('dualRoot')
      if (root) root.remove()
      document.body.style.overflow = ''
      button.textContent = '⇄ Dual comparison'
      button.classList.remove('active')
    }

    function openDual() {
      fetch('/api/dual', { method: 'POST', body: JSON.stringify({ enabled: true }) })
        .then(function (response) {
          if (!response.ok) throw new Error('could not enable dual mode')

          var root = document.createElement('div')
          root.id = 'dualRoot'
          root.innerHTML =
            '<div class="dual-toolbar">' +
            '<div class="dual-toolbar-title"><strong>Dual comparison</strong><span>independent live streams</span></div>' +
            '<div class="dual-platform-notice" id="dualPlatformNotice" role="status" hidden></div>' +
            '<span class="dual-toolbar-spacer"></span>' +
            '<label class="dual-sticky-toggle" title="Keep a compact device card visible while each metrics panel scrolls">' +
            '<input id="dualStickyDevices" type="checkbox"><span class="dual-sticky-track"></span><span>Pin device cards</span></label>' +
            '<button class="dual-settings-toggle" id="dualSettingsToggle" type="button">⚙ Dual Settings</button>' +
            '<button class="dual-exit" type="button">Exit dual mode</button></div>' +
            '<div class="dual-settings-backdrop" id="dualSettingsBackdrop" hidden></div>' +
            '<aside class="dual-settings-drawer" id="dualSettingsDrawer" aria-label="Dual Settings" hidden>' +
            '<div class="dual-settings-head"><strong>Dual Settings</strong><button class="dual-settings-close" type="button" aria-label="Close">×</button></div>' +
            '<div class="dual-mirror-notice" id="dualMirrorNotice" role="status" hidden>Both panels are mirroring the same device. Dual reports and session records are disabled until Device B is independent.</div>' +
            '<section class="dual-settings-section" id="dualReportSettings"><div class="dual-settings-title">Report</div>' +
            '<div class="dual-control-label">Export dual report</div>' +
            '<div class="dual-export-row" id="dualExportRow"><button class="chip" data-window="full" type="button">Full session</button><button class="chip" data-window="5" type="button">5 min</button><button class="chip" data-window="15" type="button">15 min</button><button class="chip" data-window="30" type="button">30 min</button><button class="chip" data-window="60" type="button">1 h</button></div>' +
            '<div class="menu-status" id="dualExportStatus"></div>' +
            '<div class="dual-records" id="dualRecords" hidden><div class="dual-records-title">Dual session records</div><div id="dualRecordsList"></div></div>' +
            '<div class="dual-settings-grid" style="margin-top:12px"><label for="dualReportsFolder">Reports folder</label><input id="dualReportsFolder" type="text" spellcheck="false"></div>' +
            '<div class="dual-folder-hint" id="dualFolderHint"></div>' +
            '<button class="dual-comparison-placeholder" id="dualComparisonExport" type="button">Export Comparison Report 📊</button></section>' +
            '<section class="dual-settings-section"><div class="dual-settings-title">Shared comparison</div>' +
            '<div class="dual-settings-grid"><label for="dualAppFilter">App filter</label><input id="dualAppFilter" type="text" spellcheck="false">' +
            '<label for="dualSampling">Sampling</label><select id="dualSampling"><option value="auto">Auto (shared)</option><option value="500">0.5 s</option><option value="1000">1 s</option><option value="2000">2 s</option><option value="5000">5 s</option></select>' +
            '<label for="dualTargetFps">Target FPS</label><input id="dualTargetFps" type="number" min="1" max="240" step="1"></div>' +
            '<div class="cfg-actions"><button class="cfg-save" id="dualSettingsSave" type="button">Save</button><span class="menu-status" id="dualSettingsStatus"></span></div></section>' +
            '</aside>' +
            '<div class="dual-panels">' +
            '<section class="dual-panel"><div class="dual-panel-label" data-pane-label="primary">Device A</div><iframe data-pane="primary" title="Device A metrics" src="/?pane=primary"></iframe></section>' +
            '<section class="dual-panel"><div class="dual-panel-label" data-pane-label="secondary">Device B</div><iframe data-pane="secondary" title="Device B metrics" src="/?pane=secondary"></iframe></section>' +
            '</div>'

          var platforms = { primary: null, secondary: null }
          var mirrorActive = false
          var appearances = {
            primary: readAppearance('primary'),
            secondary: readAppearance('secondary'),
          }
          var sticky = root.querySelector('#dualStickyDevices')
          var notice = root.querySelector('#dualPlatformNotice')
          var frames = root.querySelectorAll('iframe[data-pane]')
          sticky.checked = stickyPreference()

          function comparisonState() {
            return DualComparison.stateFor(platforms)
          }

          function postLayout(frame) {
            var state = comparisonState()
            frame.contentWindow.postMessage(
              {
                type: 'dual-layout',
                hideInspector: state.hasIos,
                frameTimesComparable: state.frameTimesComparable,
                launchStatusComparable: state.launchStatusComparable,
                stickyDevices: sticky.checked,
                appearance: appearances[frame.getAttribute('data-pane')],
              },
              location.origin,
            )
          }

          function updateComparison() {
            var state = comparisonState()
            notice.hidden = !state.hasIos
            notice.textContent = state.notice
            for (var i = 0; i < frames.length; i++) postLayout(frames[i])
          }

          onPaneDevice = function (event) {
            if (event.origin !== location.origin || !event.data) return
            if (event.data.type === 'dual-appearance') {
              var appearancePane =
                event.data.pane === 'secondary'
                  ? 'secondary'
                  : event.data.pane === 'primary'
                    ? 'primary'
                    : null
              if (!appearancePane) return
              var appearanceFrame = root.querySelector('iframe[data-pane="' + appearancePane + '"]')
              if (!appearanceFrame || event.source !== appearanceFrame.contentWindow) return
              appearances[appearancePane] = event.data.appearance
              return
            }
            if (event.data.type === 'dual-mirror-secondary') {
              var primaryFrame = root.querySelector('iframe[data-pane="primary"]')
              var secondaryFrame = root.querySelector('iframe[data-pane="secondary"]')
              if (!primaryFrame || !secondaryFrame || event.source !== primaryFrame.contentWindow)
                return
              setMirrorMode(true)
              secondaryFrame.contentWindow.location.replace(
                '/?pane=primary&slot=secondary&mirror=1',
              )
              return
            }
            if (event.data.type === 'dual-detach-secondary-mirror') {
              var detachPrimaryFrame = root.querySelector('iframe[data-pane="primary"]')
              var detachSecondaryFrame = root.querySelector('iframe[data-pane="secondary"]')
              if (
                !detachPrimaryFrame ||
                !detachSecondaryFrame ||
                event.source !== detachPrimaryFrame.contentWindow
              )
                return
              setMirrorMode(false)
              detachSecondaryFrame.contentWindow.location.replace('/?pane=secondary&slot=secondary')
              return
            }
            if (event.data.type !== 'dual-device') return
            var reportedPane =
              event.data.pane === 'secondary'
                ? 'secondary'
                : event.data.pane === 'primary'
                  ? 'primary'
                  : null
            if (!reportedPane) return
            var frame = root.querySelector('iframe[data-pane="' + reportedPane + '"]')
            if (!frame || event.source !== frame.contentWindow) return
            platforms[reportedPane] = event.data.platform
            if (reportedPane === 'secondary') {
              var paneLabel = root.querySelector('[data-pane-label="secondary"]')
              paneLabel.textContent = event.data.mirror ? 'Device B · Mirror of A' : 'Device B'
              setMirrorMode(event.data.mirror === true)
            }
            updateComparison()
          }
          window.addEventListener('message', onPaneDevice)

          sticky.addEventListener('change', function () {
            saveStickyPreference(sticky.checked)
            updateComparison()
          })
          root.querySelector('.dual-exit').addEventListener('click', closeDual)

          var settingsToggle = root.querySelector('#dualSettingsToggle')
          var settingsDrawer = root.querySelector('#dualSettingsDrawer')
          var settingsBackdrop = root.querySelector('#dualSettingsBackdrop')
          var settingsStatus = root.querySelector('#dualSettingsStatus')
          var exportStatus = root.querySelector('#dualExportStatus')
          var comparisonExport = root.querySelector('#dualComparisonExport')
          var mirrorNotice = root.querySelector('#dualMirrorNotice')
          var reportSettings = root.querySelector('#dualReportSettings')
          var records = root.querySelector('#dualRecords')
          var recordsList = root.querySelector('#dualRecordsList')
          var reportsInput = root.querySelector('#dualReportsFolder')
          var folderHint = root.querySelector('#dualFolderHint')
          var filterInput = root.querySelector('#dualAppFilter')
          var samplingInput = root.querySelector('#dualSampling')
          var fpsInput = root.querySelector('#dualTargetFps')

          function setDualStatus(el, message, kind) {
            el.textContent = message || ''
            el.className = 'menu-status' + (kind ? ' ' + kind : '')
          }

          function setMirrorMode(enabled) {
            mirrorActive = enabled === true
            mirrorNotice.hidden = !mirrorActive
            reportSettings.classList.toggle('mirror-disabled', mirrorActive)
            var controls = reportSettings.querySelectorAll('button, input, select')
            for (var i = 0; i < controls.length; i++) controls[i].disabled = mirrorActive
            if (mirrorActive) {
              records.hidden = true
              recordsList.innerHTML = ''
              setDualStatus(exportStatus, '')
            } else if (!settingsDrawer.hidden) {
              void loadDualRecords()
            }
          }

          function dualFolder(base) {
            if (!base) return 'Dual session'
            var slash = /\\/.test(base) ? '\\' : '/'
            return base.replace(/[\\/]$/, '') + slash + 'Dual session'
          }

          function fillDualConfig(data) {
            var cfg = data.config
            reportsInput.value = cfg.reportsDir
            folderHint.textContent = 'Dual reports: ' + dualFolder(cfg.reportsDir)
            filterInput.value = cfg.filterTerm
            samplingInput.value = cfg.intervalAuto ? 'auto' : String(cfg.intervalMs)
            if (cfg.intervalAuto && typeof data.effectiveIntervalMs === 'number') {
              samplingInput.options[0].textContent =
                'Auto shared (' + data.effectiveIntervalMs / 1000 + ' s)'
            }
            fpsInput.value = cfg.fpsTarget
          }

          function downloadDualReport(query) {
            if (mirrorActive) {
              setDualStatus(exportStatus, 'Dual reports are unavailable while mirroring.', 'err')
              return
            }
            setDualStatus(exportStatus, 'Generating both reports…')
            var appearanceQuery =
              '&themeA=' +
              encodeURIComponent(appearances.primary.theme) +
              '&themeB=' +
              encodeURIComponent(appearances.secondary.theme)
            fetch('/api/dual/report?' + query + appearanceQuery)
              .then(function (response) {
                if (!response.ok) {
                  return errorFromResponse(response).then(function (error) {
                    throw error
                  })
                }
                var disposition = response.headers.get('content-disposition') || ''
                var match = disposition.match(/filename="([^"]+)"/)
                return response.blob().then(function (blob) {
                  var anchor = document.createElement('a')
                  anchor.href = URL.createObjectURL(blob)
                  anchor.download = match ? match[1] : 'sample-dual-report.html'
                  root.appendChild(anchor)
                  anchor.click()
                  anchor.remove()
                  setTimeout(function () {
                    URL.revokeObjectURL(anchor.href)
                  }, 10000)
                  setDualStatus(exportStatus, 'Dual report downloaded.', 'ok')
                })
              })
              .catch(function (error) {
                setDualStatus(exportStatus, 'Export failed: ' + error.message, 'err')
              })
          }

          function downloadComparisonReport() {
            if (mirrorActive) {
              setDualStatus(
                exportStatus,
                'Comparison reports are unavailable while mirroring.',
                'err',
              )
              return
            }
            comparisonExport.disabled = true
            setDualStatus(exportStatus, 'Generating comparison report…')
            var themeQuery = '&theme=' + encodeURIComponent(appearances.primary.theme)
            fetch('/api/dual/comparison-report?window=full' + themeQuery)
              .then(function (response) {
                if (!response.ok) {
                  return errorFromResponse(response).then(function (error) {
                    throw error
                  })
                }
                var disposition = response.headers.get('content-disposition') || ''
                var match = disposition.match(/filename="([^"]+)"/)
                return response.blob().then(function (blob) {
                  var anchor = document.createElement('a')
                  var href = URL.createObjectURL(blob)
                  anchor.href = href
                  anchor.download = match ? match[1] : 'sample-comparison-report.html'
                  root.appendChild(anchor)
                  anchor.click()
                  anchor.remove()
                  setTimeout(function () {
                    URL.revokeObjectURL(href)
                  }, 10000)
                  setDualStatus(exportStatus, 'Comparison report downloaded.', 'ok')
                })
              })
              .catch(function (error) {
                setDualStatus(exportStatus, 'Export failed: ' + error.message, 'err')
              })
              .finally(function () {
                comparisonExport.disabled = mirrorActive
              })
          }

          function loadDualRecords() {
            if (mirrorActive) {
              records.hidden = true
              recordsList.innerHTML = ''
              return Promise.resolve()
            }
            return fetch('/api/dual/sessions')
              .then(function (response) {
                if (!response.ok) throw new Error('Could not load dual records')
                return response.json()
              })
              .then(function (data) {
                if (data.mirror === true) {
                  setMirrorMode(true)
                  return
                }
                recordsList.innerHTML = ''
                records.hidden = !data.sessions.length
                data.sessions.forEach(function (session) {
                  var recordButton = document.createElement('button')
                  recordButton.type = 'button'
                  recordButton.className = 'dual-record'
                  var details = document.createElement('span')
                  details.appendChild(
                    document.createTextNode(new Date(session.startedAt).toLocaleString()),
                  )
                  details.appendChild(document.createElement('br'))
                  var devices = document.createElement('small')
                  devices.textContent =
                    (session.primaryDevice || 'Device A') +
                    ' ↔ ' +
                    (session.secondaryDevice || 'Device B')
                  details.appendChild(devices)
                  var action = document.createElement('span')
                  action.textContent = '⬇ report'
                  recordButton.appendChild(details)
                  recordButton.appendChild(action)
                  recordButton.addEventListener('click', function () {
                    downloadDualReport('session=' + encodeURIComponent(session.id))
                  })
                  recordsList.appendChild(recordButton)
                })
              })
              .catch(function () {
                records.hidden = true
              })
          }

          function loadDualSettings() {
            setDualStatus(settingsStatus, '')
            return Promise.all([
              fetch('/api/config')
                .then(function (response) {
                  return response.json()
                })
                .then(fillDualConfig),
              loadDualRecords(),
            ])
          }

          function toggleDualSettings(open) {
            settingsDrawer.hidden = !open
            settingsBackdrop.hidden = !open
            if (open) void loadDualSettings()
          }

          settingsToggle.addEventListener('click', function () {
            toggleDualSettings(settingsDrawer.hidden)
          })
          settingsBackdrop.addEventListener('click', function () {
            toggleDualSettings(false)
          })
          root.querySelector('.dual-settings-close').addEventListener('click', function () {
            toggleDualSettings(false)
          })
          root.querySelector('#dualExportRow').addEventListener('click', function (event) {
            var target = event.target
            var windowValue = target && target.getAttribute && target.getAttribute('data-window')
            if (windowValue) downloadDualReport('window=' + windowValue)
          })
          comparisonExport.addEventListener('click', downloadComparisonReport)
          root.querySelector('#dualSettingsSave').addEventListener('click', function () {
            var patch = {
              filterTerm: filterInput.value.trim(),
              reportsDir: reportsInput.value.trim(),
              fpsTarget: Number(fpsInput.value),
            }
            if (samplingInput.value === 'auto') patch.intervalAuto = true
            else patch.intervalMs = Number(samplingInput.value)
            setDualStatus(settingsStatus, 'Saving…')
            fetch('/api/config', { method: 'PUT', body: JSON.stringify(patch) })
              .then(function (response) {
                if (!response.ok) throw new Error('error ' + response.status)
                return response.json()
              })
              .then(function (data) {
                fillDualConfig(data)
                for (var i = 0; i < frames.length; i++) {
                  frames[i].contentWindow.postMessage(
                    { type: 'dual-shared-config', config: data.config },
                    location.origin,
                  )
                }
                setDualStatus(settingsStatus, 'Saved ✓', 'ok')
              })
              .catch(function (error) {
                setDualStatus(settingsStatus, 'Could not save: ' + error.message, 'err')
              })
          })

          for (var i = 0; i < frames.length; i++) {
            frames[i].addEventListener('load', function () {
              postLayout(this)
            })
          }

          document.body.appendChild(root)
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

  if (!isEmbeddedPane) installDualToggle()

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
    fetch('/api/app', { method: 'POST', body: JSON.stringify({ package: p, pane: dataPane }) })
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
  var devRefreshTimer = null

  function setDeviceRefreshing(refreshing) {
    devSel.refresh.disabled = refreshing
    devSel.refresh.textContent = refreshing ? '⟳ Searching…' : '⟳ Refresh'
    devSel.list.setAttribute('aria-busy', refreshing ? 'true' : 'false')
    if (refreshing && devSel.list.children.length === 0) {
      devSel.empty.hidden = false
      devSel.empty.textContent = 'Looking for devices…'
    }
  }

  function loadDevices(force) {
    if (devRefreshTimer) clearTimeout(devRefreshTimer)
    devRefreshTimer = null
    setDeviceRefreshing(true)
    fetch('/api/devices' + (force === true ? '?refresh=1' : ''))
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        renderDeviceList(data)
        setDeviceRefreshing(data.refreshing === true)
        if (data.refreshing && !devSel.pop.hidden) {
          devRefreshTimer = setTimeout(function () {
            loadDevices(false)
          }, 600)
        }
      })
      .catch(function () {
        setDeviceRefreshing(false)
        if (devSel.list.children.length === 0) {
          devSel.empty.hidden = false
          devSel.empty.textContent = 'Could not list the devices.'
        }
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
      var isCurrent = d.serial === (dataPane === 'secondary' ? data.secondary : data.current)
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
        return r.json()
      })
      .then(function (body) {
        if (pane === 'primary' && isEmbeddedPane) {
          if (body.detachSecondaryMirror === true) {
            window.parent.postMessage({ type: 'dual-detach-secondary-mirror' }, location.origin)
          } else if (body.mirrorSecondary === true) {
            window.parent.postMessage({ type: 'dual-mirror-secondary' }, location.origin)
          }
        }
        if (pane !== 'secondary') return
        if (body.mirror === true && !isMirrorPane) {
          location.replace('/?pane=primary&slot=secondary&mirror=1')
        } else if (body.mirror !== true && isMirrorPane) {
          location.replace('/?pane=secondary&slot=secondary')
        }
        // Sin recarga, la ficha nueva llega por WS ({type:"device"} + {type:"app"}).
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
    if (devRefreshTimer) clearTimeout(devRefreshTimer)
    devRefreshTimer = null
  }

  devSel.btn.addEventListener('click', function (e) {
    e.stopPropagation()
    devSel.pop.hidden = !devSel.pop.hidden
    if (!devSel.pop.hidden) {
      animPopoverIn(devSel.pop)
      loadDevices(false)
    }
  })
  devSel.refresh.addEventListener('click', function (e) {
    e.stopPropagation()
    loadDevices(true)
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

  if (isEmbeddedPane) {
    var regularSections = menu.pop.querySelectorAll('.menu-section:not(.panel-appearance-section)')
    for (var rs = 0; rs < regularSections.length; rs++) regularSections[rs].hidden = true
    var appearanceSection = document.getElementById('panelAppearance')
    var appearanceTheme = document.getElementById('panelTheme')
    var appearanceAccents = document.getElementById('panelAccents')
    appearanceSection.hidden = false
    menu.btn.textContent = '🎨'
    menu.btn.title = 'Panel appearance'
    menu.btn.setAttribute('aria-label', 'Panel appearance')
    applyPanelAppearance(readAppearance(pane), false)
    appearanceTheme.addEventListener('change', function () {
      applyPanelAppearance(
        {
          theme: appearanceTheme.checked ? 'dark' : 'light',
          accent: panelAppearance ? panelAppearance.accent : defaultAppearance(pane).accent,
        },
        true,
      )
    })
    appearanceAccents.addEventListener('click', function (event) {
      var accent = event.target && event.target.getAttribute('data-accent')
      if (!ACCENTS[accent]) return
      applyPanelAppearance(
        { theme: panelAppearance ? panelAppearance.theme : 'dark', accent: accent },
        true,
      )
    })
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
    if (!isEmbeddedPane) {
      loadSessions()
      void loadConfig(false)
    }
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
  if (!isEmbeddedPane) void loadConfig(true)
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
      LogsPanel.bootstrap(dataPane)
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
          msg.type === 'connection' ||
          msg.type === 'logs') &&
        (msg.pane || 'primary') !== dataPane
      ) {
        return
      }
      if (pane === 'secondary' && msg.type === 'flow') return
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
        if (isEmbeddedPane) {
          syncStickyDeviceCard()
          updateStickyDeviceCard()
          window.parent.postMessage(
            {
              type: 'dual-device',
              pane: pane,
              mirror: isMirrorPane,
              // Compatibilidad con fichas Android históricas: plataforma ausente = Android.
              platform: device.platform === 'ios' ? 'ios' : 'android',
              serial: device.serial,
            },
            location.origin,
          )
        }
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
