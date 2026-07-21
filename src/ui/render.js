/**
 * render.js — ECharts wiring + render for the LIVE dashboard (ticket 021).
 * Adapted from prototypes/dashboard/app.js: same look, but data-source-agnostic.
 * live.js feeds it real Samples over WebSocket; this file only renders.
 *
 * Differences vs the prototype:
 *  - Fed by real Samples ({cpu, gpu, fps, tempC, mem:{...}, battery:{...}, netRxKb, netTxKb});
 *    every field may be null → drawn as N/A (never 0).
 *  - 5th gauge: Battery (level %). A "CHARGING" chip shows when plugged.
 *  - Network shows N/A note when netRxKb/netTxKb are null (bucketed, not realtime).
 */
;(function (global) {
  'use strict'

  var PALETTES = {
    light: {
      bg: '#F4F4F9',
      card: '#FFFFFF',
      card2: '#FBFBFE',
      primary: '#EB008B',
      secondary: '#009E96',
      text: '#1C1C28',
      muted: '#66667A',
      line: '#E2E2EC',
      ok: '#0FA968',
      warn: '#E08A00',
      bad: '#E11D48',
      violet: '#7C5CE0',
      amber: '#D98A00',
      track: '#ECECF4',
      split: 'rgba(28,28,40,.09)',
      legendOff: '#C4C4D2',
      rxArea: 'rgba(0,158,150,.12)',
      txArea: 'rgba(235,0,139,.10)',
    },
    dark: {
      bg: '#0B0B10',
      card: '#15151D',
      card2: '#1B1B25',
      primary: '#EB008B',
      secondary: '#00E6DA',
      text: '#F2F2F6',
      muted: '#9B9BAB',
      line: '#2A2A38',
      ok: '#2EE59D',
      warn: '#FFC24B',
      bad: '#FF4D6D',
      violet: '#B18CFF',
      amber: '#FFB03A',
      track: '#22222e',
      split: 'rgba(42,42,56,.55)',
      legendOff: '#44444f',
      rxArea: 'rgba(0,230,218,.12)',
      txArea: 'rgba(235,0,139,.12)',
    },
  }
  var theme = 'light'
  var C = PALETTES[theme]

  var FONT_TITLE = "'Baloo 2', ui-rounded, system-ui, sans-serif"
  var FONT_BODY = "'Inter', system-ui, sans-serif"

  var deviceRamMb = 8192 // updated from DeviceInfo.ramTotalMb when it arrives
  var deviceCores = null // DeviceInfo.cores → "≈ X% core" under the CPU gauge
  var WINDOW_S = 120

  // Adaptive RAM unit: apps live in MB (a 118 MB app frozen at "0.12 GB" hides
  // every real change); switch to GB only past 1 GiB.
  function fmtMb(mb) {
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB'
  }

  function bands(warn, bad) {
    return function (v) {
      return v < warn ? C.ok : v < bad ? C.warn : C.bad
    }
  }
  // battery: inverse thresholds (low = bad)
  function battBands(v) {
    return v < 15 ? C.bad : v < 30 ? C.warn : C.ok
  }

  var latestFps = null
  var NA = '{na|N/A}'

  function gaugeDefs() {
    return {
      cpu: {
        el: 'gCpu',
        min: 0,
        max: 100,
        color: bands(55, 75),
        device: true, // anillo secundario: CPU total del device
        fmt: function (v) {
          if (v === null) return NA
          // share-of-device esconde un main thread clavado (6% device = 49% de un
          // core en 8 cores): mostrar la conversión al lado
          var core = deviceCores ? '\n{fps|≈ ' + Math.round(v * deviceCores) + '% core}' : ''
          return Math.round(v) + '{u|%}' + core
        },
      },
      gpu: {
        el: 'gGpu',
        min: 0,
        max: 100,
        color: bands(65, 85),
        fmt: function (v) {
          var fpsLine = latestFps === null ? '' : '\n{fps|' + Math.round(latestFps) + ' FPS}'
          return (v === null ? NA : Math.round(v) + '{u|%}') + fpsLine
        },
      },
      temp: {
        el: 'gTemp',
        min: 25,
        max: 50,
        color: bands(38, 42),
        fmt: function (v) {
          return v === null ? NA : v.toFixed(1) + '{u|°C}'
        },
      },
      ram: {
        el: 'gRam',
        min: 0,
        max: deviceRamMb,
        color: bands(deviceRamMb * 0.45, deviceRamMb * 0.7),
        device: true, // anillo secundario: RAM usada total del device
        fmt: function (v) {
          if (v === null) return NA
          return v >= 1024 ? (v / 1024).toFixed(2) + '{u|GB}' : Math.round(v) + '{u|MB}'
        },
      },
      bat: {
        el: 'gBat',
        min: 0,
        max: 100,
        color: battBands,
        fmt: function (v) {
          return v === null ? NA : Math.round(v) + '{u|%}'
        },
      },
    }
  }

  function makeGauge(cfg) {
    var chart = echarts.init(document.getElementById(cfg.el), null, { renderer: 'canvas' })
    var series = [
      {
        type: 'gauge',
        startAngle: 90,
        endAngle: -270,
        min: cfg.min,
        max: cfg.max,
        pointer: { show: false },
        progress: {
          show: true,
          width: 13,
          roundCap: true,
          itemStyle: { color: C.ok, shadowColor: 'rgba(0,0,0,.25)', shadowBlur: 5 },
        },
        axisLine: { lineStyle: { width: 13, color: [[1, C.track]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { show: false },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, 0],
          formatter: cfg.fmt,
          color: C.text,
          fontFamily: FONT_TITLE,
          fontWeight: 800,
          fontSize: 30,
          lineHeight: 34,
          rich: {
            u: {
              color: C.muted,
              fontSize: 13,
              fontFamily: FONT_BODY,
              fontWeight: 500,
              padding: [8, 0, 0, 2],
            },
            fps: {
              color: C.muted,
              fontSize: 14,
              fontFamily: FONT_BODY,
              fontWeight: 600,
              padding: [4, 0, 0, 0],
            },
            na: { color: C.muted, fontSize: 20, fontFamily: FONT_BODY, fontWeight: 600 },
          },
        },
        data: [{ value: cfg.min }],
      },
    ]
    // anillo interior tenue: total del DEVICE en la misma escala que la app
    if (cfg.device) {
      series.push({
        type: 'gauge',
        startAngle: 90,
        endAngle: -270,
        min: cfg.min,
        max: cfg.max,
        radius: '68%',
        pointer: { show: false },
        progress: { show: true, width: 5, roundCap: true, itemStyle: { color: C.legendOff } },
        axisLine: { lineStyle: { width: 5, color: [[1, 'transparent']] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { show: false },
        detail: { show: false },
        data: [{ value: cfg.min }],
      })
    }
    chart.setOption({ series: series })
    cfg.chart = chart
    return cfg
  }

  function updateGauge(cfg, value, deviceValue) {
    // null → keep ring at min (grey) and show N/A text
    var ringVal = value === null ? cfg.min : value
    var series = [
      {
        data: [{ value: ringVal }],
        progress: { itemStyle: { color: value === null ? C.track : cfg.color(value) } },
        detail: {
          formatter: function () {
            return cfg.fmt(value)
          },
        },
      },
    ]
    if (cfg.device) {
      var dv = deviceValue === null || deviceValue === undefined ? cfg.min : deviceValue
      series.push({ data: [{ value: dv }] })
    }
    cfg.chart.setOption({ series: series })
  }

  // ---------- memory pie ----------
  function memMeta() {
    return [
      { key: 'java', name: 'Java heap', color: C.primary },
      { key: 'native', name: 'Native', color: C.secondary },
      { key: 'graphics', name: 'Graphics', color: C.violet },
      { key: 'code', name: 'Code', color: C.amber },
      { key: 'stack', name: 'Stack', color: theme === 'light' ? '#1E90D6' : '#5AD1FF' },
      { key: 'other', name: 'Other', color: theme === 'light' ? '#8E8EA6' : '#6E6E82' },
    ]
  }

  function makeMemPie() {
    var chart = echarts.init(document.getElementById('memPie'))
    chart.setOption({
      animationDurationUpdate: 800,
      animationEasingUpdate: 'cubicOut',
      tooltip: {
        trigger: 'item',
        backgroundColor: C.card2,
        borderColor: C.line,
        textStyle: { color: C.text, fontFamily: FONT_BODY },
        formatter: function (p) {
          return p.name + ': <b>' + Math.round(p.value) + ' MB</b> (' + p.percent + '%)'
        },
      },
      title: {
        text: '',
        left: 'center',
        top: '40%',
        textStyle: { color: C.text, fontFamily: FONT_TITLE, fontWeight: 800, fontSize: 22 },
        subtext: 'PSS total',
        subtextStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 11 },
      },
      legend: {
        bottom: 0,
        left: 'center',
        type: 'scroll',
        icon: 'circle',
        itemWidth: 9,
        itemHeight: 9,
        itemGap: 10,
        textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 11 },
        pageIconColor: C.muted,
        pageTextStyle: { color: C.muted },
      },
      series: [
        {
          type: 'pie',
          radius: ['48%', '72%'],
          center: ['50%', '46%'],
          avoidLabelOverlap: true,
          minShowLabelAngle: 18,
          itemStyle: { borderColor: C.card, borderWidth: 2, borderRadius: 5 },
          label: {
            show: true,
            position: 'inside',
            formatter: '{d}%',
            color: '#fff',
            fontFamily: FONT_BODY,
            fontSize: 10,
            fontWeight: 600,
            textShadowColor: 'rgba(0,0,0,0.45)',
            textShadowBlur: 2,
          },
          labelLine: { show: false },
          data: memMeta().map(function (m) {
            return { name: m.name, value: 0, itemStyle: { color: m.color } }
          }),
        },
      ],
    })
    return chart
  }

  function updateMemPie(mem, pssMb) {
    memPie.setOption({
      title: { text: pssMb === null ? 'N/A' : fmtMb(pssMb) },
      series: [
        {
          data: memMeta().map(function (m) {
            return { name: m.name, value: mem[m.key] || 0, itemStyle: { color: m.color } }
          }),
        },
      ],
    })
  }

  // ---------- multi-series timeline ----------
  function seriesMeta() {
    return [
      {
        name: 'CPU %',
        color: C.primary,
        plot: function (s) {
          return s.cpu
        },
        real: function (s) {
          return s.cpu.toFixed(0) + ' %'
        },
      },
      {
        name: 'RAM',
        color: C.violet,
        // placeholder: la serie RAM se re-normaliza al rango visible en render()
        // (auto-escala; % del device aplastaba una app de 118 MB contra el piso)
        plot: function (s) {
          return (s.mem.pss / deviceRamMb) * 100
        },
        real: function (s) {
          return fmtMb(s.mem.pss)
        },
      },
      {
        name: 'FPS',
        color: C.secondary,
        plot: function (s) {
          return (s.fps / 60) * 100
        },
        real: function (s) {
          return s.fps.toFixed(0) + ' fps'
        },
      },
      {
        name: 'Temp',
        color: C.amber,
        plot: function (s) {
          return ((s.tempC - 25) / (50 - 25)) * 100
        },
        real: function (s) {
          return s.tempC.toFixed(1) + ' °C'
        },
      },
      {
        name: 'Batt',
        color: C.ok,
        plot: function (s) {
          return s.battery.levelPct
        },
        real: function (s) {
          return s.battery.levelPct.toFixed(0) + ' %'
        },
      },
      // Totales del DEVICE: punteados y translúcidos, misma escala 0-100 (% de la
      // capacidad del teléfono) — responde "¿el cuello es mi app o el teléfono?"
      {
        name: 'CPU dev',
        color: C.primary,
        dim: true,
        plot: function (s) {
          return s.deviceCpu
        },
        real: function (s) {
          return s.deviceCpu.toFixed(0) + ' %'
        },
      },
      {
        name: 'RAM dev',
        color: C.violet,
        dim: true,
        plot: function (s) {
          return (s.deviceRamUsedMb / deviceRamMb) * 100
        },
        real: function (s) {
          return fmtMb(s.deviceRamUsedMb)
        },
      },
    ]
  }
  // which sample field each series needs (null → skip point)
  var SERIES_VAL = [
    function (s) {
      return s.cpu
    },
    function (s) {
      return s.mem.pss
    },
    function (s) {
      return s.fps
    },
    function (s) {
      return s.tempC
    },
    function (s) {
      return s.battery.levelPct
    },
    function (s) {
      return s.deviceCpu === undefined ? null : s.deviceCpu
    },
    function (s) {
      return s.deviceRamUsedMb === undefined ? null : s.deviceRamUsedMb
    },
  ]
  var RAM_SERIES_IDX = 1
  var SERIES = seriesMeta()

  function makeTimeline() {
    var chart = echarts.init(document.getElementById('timeline'))
    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 42, right: 16, top: 38, bottom: 28 },
      legend: {
        top: 2,
        left: 4,
        icon: 'roundRect',
        itemWidth: 14,
        itemHeight: 5,
        textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 12 },
        inactiveColor: C.legendOff,
        data: SERIES.map(function (s) {
          return s.name
        }),
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: C.card2,
        borderColor: C.line,
        textStyle: { color: C.text, fontFamily: FONT_BODY, fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: C.line } },
        formatter: function (params) {
          if (!params.length) return ''
          var lines = [echarts.time.format(params[0].value[0], '{HH}:{mm}:{ss}', false)]
          params.forEach(function (p) {
            lines.push(p.marker + ' ' + p.seriesName + ': <b>' + p.value[2] + '</b>')
          })
          return lines.join('<br/>')
        },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: C.line } },
        axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10, formatter: '{mm}:{ss}' },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10, formatter: '{value}' },
        splitLine: { lineStyle: { color: C.split } },
      },
      series: SERIES.map(function (s) {
        return {
          name: s.name,
          type: 'line',
          showSymbol: false,
          smooth: 0.25,
          connectNulls: false,
          lineStyle: {
            width: s.dim ? 1.5 : 2,
            color: s.color,
            type: s.dim ? 'dashed' : 'solid',
            opacity: s.dim ? 0.45 : 1,
          },
          itemStyle: { color: s.color, opacity: s.dim ? 0.45 : 1 },
          emphasis: { disabled: true },
          data: [],
        }
      }),
    })
    return chart
  }

  function makeNetSpark() {
    var chart = echarts.init(document.getElementById('netSpark'))
    chart.setOption({
      animation: false,
      grid: { left: 4, right: 4, top: 4, bottom: 4 },
      xAxis: { type: 'time', show: false },
      yAxis: { type: 'value', show: false },
      tooltip: {
        trigger: 'axis',
        backgroundColor: C.card2,
        borderColor: C.line,
        textStyle: { color: C.text, fontSize: 11, fontFamily: FONT_BODY },
        formatter: function (params) {
          return params
            .map(function (p) {
              return p.marker + ' ' + p.seriesName + ': <b>' + Math.round(p.value[1]) + ' KB/s</b>'
            })
            .join('<br/>')
        },
      },
      series: [
        {
          name: '↓ rx',
          type: 'line',
          showSymbol: false,
          smooth: 0.3,
          data: [],
          lineStyle: { width: 1.5, color: C.secondary },
          itemStyle: { color: C.secondary },
          areaStyle: { color: C.rxArea },
        },
        {
          name: '↑ tx',
          type: 'line',
          showSymbol: false,
          smooth: 0.3,
          data: [],
          lineStyle: { width: 1.5, color: C.primary },
          itemStyle: { color: C.primary },
          areaStyle: { color: C.txArea },
        },
      ],
    })
    return chart
  }

  // ---------- build / rebuild ----------
  var gauges, memPie, timeline, netSpark

  function allCharts() {
    var list = [memPie, timeline, netSpark]
    Object.keys(gauges || {}).forEach(function (k) {
      list.push(gauges[k].chart)
    })
    return list.filter(Boolean)
  }

  function buildCharts() {
    gauges = {}
    var defs = gaugeDefs()
    Object.keys(defs).forEach(function (k) {
      gauges[k] = makeGauge(defs[k])
    })
    memPie = makeMemPie()
    timeline = makeTimeline()
    netSpark = makeNetSpark()
    // re-feed buffered data
    timeline.setOption({
      series: tlData.map(function (d) {
        return { data: d }
      }),
    })
    netSpark.setOption({ series: [{ data: netData[0] }, { data: netData[1] }] })
  }

  function disposeCharts() {
    allCharts().forEach(function (c) {
      c.dispose()
    })
    gauges = null
    memPie = null
    timeline = null
    netSpark = null
  }

  // ---------- state ----------
  var tlData = SERIES.map(function () {
    return []
  })
  var netData = [[], []]
  var lastSample = null
  var netTotalRx = 0,
    netTotalTx = 0
  var netEverSeen = false

  function fmtKb(kb) {
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB/s' : Math.round(kb) + ' KB/s'
  }
  function fmtTotal(kb) {
    return kb >= 1024 * 1024
      ? (kb / 1024 / 1024).toFixed(2) + ' GB'
      : (kb / 1024).toFixed(1) + ' MB'
  }

  function render(s) {
    lastSample = s
    latestFps = s.fps
    updateGauge(gauges.cpu, s.cpu, s.deviceCpu === undefined ? null : s.deviceCpu)
    updateGauge(gauges.gpu, s.gpu)
    updateGauge(gauges.temp, s.tempC)
    updateGauge(gauges.ram, s.mem.pss, s.deviceRamUsedMb === undefined ? null : s.deviceRamUsedMb)
    updateGauge(gauges.bat, s.battery.levelPct)

    // charging chip
    var chip = document.getElementById('chipCharging')
    if (chip) chip.classList.toggle('show', s.battery.charging === true)

    updateMemPie(s.mem, s.mem.pss)

    var now = s.ts || Date.now()
    SERIES.forEach(function (meta, i) {
      var raw = SERIES_VAL[i](s)
      if (raw === null || raw === undefined) return // gap for N/A
      // value[3] = valor crudo (la serie RAM se re-normaliza abajo con él)
      tlData[i].push({ value: [now, meta.plot(s), meta.real(s), raw] })
      while (tlData[i].length > WINDOW_S) tlData[i].shift()
    })
    // Auto-escala de la RAM de la app: re-normalizar el buffer visible a su propio
    // rango (con padding). En % del device, una app de 118 MB era una línea plana
    // pegada al piso; así, un leak de 5 MB/min se VE.
    var ramArr = tlData[RAM_SERIES_IDX]
    if (ramArr.length) {
      var lo = Infinity
      var hi = -Infinity
      ramArr.forEach(function (p) {
        var mb = p.value[3]
        if (mb < lo) lo = mb
        if (mb > hi) hi = mb
      })
      var pad = Math.max((hi - lo) * 0.15, hi * 0.02, 1)
      var floor = Math.max(0, lo - pad)
      var span = hi + pad - floor
      ramArr.forEach(function (p) {
        p.value[1] = ((p.value[3] - floor) / span) * 100
      })
    }
    timeline.setOption({
      series: SERIES.map(function (_, i) {
        return { data: tlData[i] }
      }),
    })

    // network (null → N/A note, no spark points)
    if (s.netRxKb === null && s.netTxKb === null) {
      var na = document.getElementById('netNa')
      if (na && !netEverSeen) na.hidden = false
      document.getElementById('rxNow').textContent = 'N/A'
      document.getElementById('txNow').textContent = 'N/A'
      document.getElementById('rxTot').textContent = ''
      document.getElementById('txTot').textContent = ''
    } else {
      netEverSeen = true
      document.getElementById('netNa').hidden = true
      netTotalRx += s.netRxKb || 0
      netTotalTx += s.netTxKb || 0
      netData[0].push([now, s.netRxKb || 0])
      netData[1].push([now, s.netTxKb || 0])
      netData.forEach(function (arr) {
        while (arr.length > WINDOW_S) arr.shift()
      })
      netSpark.setOption({ series: [{ data: netData[0] }, { data: netData[1] }] })
      document.getElementById('rxNow').textContent = '↓ ' + fmtKb(s.netRxKb || 0)
      document.getElementById('txNow').textContent = '↑ ' + fmtKb(s.netTxKb || 0)
      document.getElementById('rxTot').textContent = 'total ' + fmtTotal(netTotalRx)
      document.getElementById('txTot').textContent = 'total ' + fmtTotal(netTotalTx)
    }
  }

  // ---------- device ficha ----------
  function setDevice(info, pkg) {
    var name = [info.manufacturer, info.model].filter(Boolean).join(' ') || info.serial
    document.getElementById('devName').textContent = name
    var specs = []
    if (info.androidRelease)
      specs.push(
        'Android ' + info.androidRelease + (info.apiLevel ? ' (API ' + info.apiLevel + ')' : ''),
      )
    if (info.ramTotalMb) {
      deviceRamMb = info.ramTotalMb
      specs.push((info.ramTotalMb / 1024).toFixed(1) + ' GB RAM')
    }
    if (info.gpu) specs.push(info.gpu)
    if (info.soc) specs.push(info.soc)
    if (info.cores) {
      deviceCores = info.cores
      specs.push(info.cores + ' cores')
    }
    specs.push(info.serial)
    var el = document.getElementById('devSpecs')
    el.innerHTML = ''
    specs.forEach(function (t) {
      var span = document.createElement('span')
      span.className = 'spec'
      span.textContent = t
      el.appendChild(span)
    })
    if (pkg) document.getElementById('appPkg').textContent = pkg
    // rebuild RAM gauge to pick up the real max (ambos anillos: app y device)
    if (gauges && gauges.ram) {
      gauges.ram.chart.setOption({ series: [{ max: deviceRamMb }, { max: deviceRamMb }] })
      gauges.ram.color = bands(deviceRamMb * 0.45, deviceRamMb * 0.7)
    }
  }

  // ---------- reset al cambiar de app (selector) ----------
  // Mezclar series de dos apps en el mismo timeline sería engañoso: se vacían
  // los buffers y los totales; los gauges son instantáneos y se pisan solos.
  function resetSeries() {
    tlData.forEach(function (arr) {
      arr.length = 0
    })
    netData[0].length = 0
    netData[1].length = 0
    netTotalRx = 0
    netTotalTx = 0
    netEverSeen = false
    lastSample = null
    if (timeline)
      timeline.setOption({
        series: SERIES.map(function (_, i) {
          return { data: tlData[i] }
        }),
      })
    if (netSpark) netSpark.setOption({ series: [{ data: netData[0] }, { data: netData[1] }] })
  }

  // ---------- connection status ----------
  var startTs = null
  function setConnected(connected) {
    var badge = document.getElementById('recBadge')
    var label = document.getElementById('recLabel')
    badge.classList.toggle('offline', !connected)
    label.textContent = connected ? 'LIVE' : 'OFFLINE'
    if (connected && startTs === null) startTs = Date.now()
  }
  setInterval(function () {
    if (startTs === null) return
    var s = Math.floor((Date.now() - startTs) / 1000)
    var m = Math.floor(s / 60),
      ss = s % 60
    document.getElementById('recTime').textContent =
      (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss
  }, 1000)

  // ---------- theme (se controla desde Configuración del menú ☰) ----------
  function applyTheme(next) {
    if (next !== 'light' && next !== 'dark') return
    if (next === theme) return
    theme = next
    C = PALETTES[theme]
    document.body.setAttribute('data-theme', theme)
    disposeCharts()
    SERIES = seriesMeta()
    buildCharts()
    if (lastSample) render(lastSample)
  }

  function init() {
    buildCharts()
    window.addEventListener('resize', function () {
      allCharts().forEach(function (c) {
        c.resize()
      })
    })
  }

  global.ProfilerDashboard = {
    init: init,
    render: render,
    setDevice: setDevice,
    setConnected: setConnected,
    resetSeries: resetSeries,
    setTheme: applyTheme,
    getTheme: function () {
      return theme
    },
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
