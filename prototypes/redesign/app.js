/**
 * app.js — wiring del prototipo del rediseño (ticket 031). DESCARTABLE.
 * ECharts + DOM sobre los datos de sim.js. La estructura de componentes acá
 * (tiles, timeline por carriles, verdict pill, panel de logs) es el contrato
 * visual que implementa el 032 sobre src/ui/.
 */
;(function () {
  'use strict'

  var FONT_TITLE = "'Baloo 2', ui-rounded, system-ui, sans-serif"
  var FONT_BODY = "'Inter', system-ui, sans-serif"
  var WINDOW_S = 180
  var DEVICE_RAM_MB = 8192
  var DEVICE_CORES = 8

  // ---- chart palettes (mirror de los tokens CSS; validadas con dataviz) ----
  var PALETTES = {
    dark: {
      text: '#F2F2F6',
      muted: '#9B9BAB',
      line: '#2A2A38',
      card: '#15151D',
      card2: '#1B1B25',
      split: 'rgba(42,42,56,.55)',
      legendOff: '#44444F',
      ok: '#2EE59D',
      warn: '#FFC24B',
      bad: '#FF4D6D',
      fps: '#00A89E',
      gpu: '#EB008B',
      cpu: '#8B6BE8',
      temp: '#C77F00',
      memJava: '#EB008B',
      memGraphics: '#8B6BE8',
      memNative: '#00A89E',
      memCode: '#C77F00',
      memStack: '#7A7A90',
      memOther: '#4E4E62',
      redBand: 'rgba(255,77,109,.09)',
      fpsArea: 'rgba(0,168,158,.10)',
      memArea: 'rgba(139,107,232,.14)',
      rxArea: 'rgba(0,168,158,.14)',
      txArea: 'rgba(235,0,139,.12)',
    },
    light: {
      text: '#1C1C28',
      muted: '#66667A',
      line: '#E2E2EC',
      card: '#FFFFFF',
      card2: '#FBFBFE',
      split: 'rgba(28,28,40,.09)',
      legendOff: '#C4C4D2',
      ok: '#0FA968',
      warn: '#E08A00',
      bad: '#E11D48',
      fps: '#009E96',
      gpu: '#EB008B',
      cpu: '#7C5CE0',
      temp: '#B8860B',
      memJava: '#EB008B',
      memGraphics: '#7C5CE0',
      memNative: '#009E96',
      memCode: '#B8860B',
      memStack: '#9A9AB0',
      memOther: '#C6C6D4',
      redBand: 'rgba(225,29,72,.07)',
      fpsArea: 'rgba(0,158,150,.09)',
      memArea: 'rgba(124,92,224,.12)',
      rxArea: 'rgba(0,158,150,.12)',
      txArea: 'rgba(235,0,139,.10)',
    },
  }
  var theme = 'dark'
  var C = PALETTES[theme]

  function $(id) {
    return document.getElementById(id)
  }
  function fmtMb(mb) {
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB'
  }
  function fmtKb(kb) {
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB/s' : Math.round(kb) + ' KB/s'
  }
  function fmtTotal(kb) {
    return kb >= 1024 * 1024 ? (kb / 1048576).toFixed(2) + ' GB' : (kb / 1024).toFixed(1) + ' MB'
  }
  function pad2(n) {
    return (n < 10 ? '0' : '') + n
  }
  function fmtClock(ts) {
    var d = new Date(ts)
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  }

  // ---- semáforo (espejo de src/core/perf/threshold.ts) ----
  var fpsTarget = 60
  function fpsStatusOf(fps, target) {
    if (fps === null || fps === undefined || !isFinite(fps) || fps < 0) return null
    if (typeof target !== 'number' || !isFinite(target) || target <= 0) return null
    if (fps >= target) return 'green'
    if (fps >= target * 0.8) return 'yellow'
    return 'red'
  }
  function bandColor(v, warn, bad) {
    return v < warn ? C.ok : v < bad ? C.warn : C.bad
  }

  // =====================================================================
  // Perf timeline — 2 carriles apilados, eje X compartido, unidades reales
  // =====================================================================
  var tlPerf = null
  var fpsData = [] // [ts, fps]
  var gpuData = []
  var cpuData = []
  var cpuDevData = []
  var tickStatus = [] // [ts, 'green'|'yellow'|'red'|null] para bandas rojas + verdict
  var crashMarks = [] // ts de cada crash
  var legendSelected = { FPS: true, 'GPU %': true, 'CPU %': true, 'CPU device %': false }

  function makeTlPerf() {
    var chart = echarts.init($('tlPerf'))
    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: C.muted } },
      legend: {
        top: 0,
        right: 4,
        icon: 'roundRect',
        itemWidth: 14,
        itemHeight: 5,
        textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 11.5 },
        inactiveColor: C.legendOff,
        selected: legendSelected,
        data: ['FPS', 'GPU %', 'CPU %', 'CPU device %'],
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: C.card2,
        borderColor: C.line,
        textStyle: { color: C.text, fontFamily: FONT_BODY, fontSize: 12 },
        valueFormatter: function (v) {
          return v === null || v === undefined ? 'N/A' : Math.round(v)
        },
      },
      grid: [
        { left: 46, right: 16, top: 26, height: '46%' },
        { left: 46, right: 16, top: '62%', bottom: 24 },
      ],
      xAxis: [
        {
          type: 'time',
          gridIndex: 0,
          axisLine: { lineStyle: { color: C.line } },
          axisLabel: { show: false },
          splitLine: { show: false },
        },
        {
          type: 'time',
          gridIndex: 1,
          axisLine: { lineStyle: { color: C.line } },
          axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10, formatter: '{HH}:{mm}:{ss}' },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          type: 'value',
          gridIndex: 0,
          min: 0,
          max: 70,
          name: 'fps',
          nameTextStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10, align: 'right' },
          axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          splitLine: { lineStyle: { color: C.split } },
        },
        {
          type: 'value',
          gridIndex: 1,
          min: 0,
          max: 100,
          name: '%',
          nameTextStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10, align: 'right' },
          axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          splitLine: { lineStyle: { color: C.split } },
        },
      ],
      series: [
        {
          name: 'FPS',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          smooth: 0.25,
          connectNulls: false,
          lineStyle: { width: 2, color: C.fps },
          itemStyle: { color: C.fps },
          areaStyle: { color: C.fpsArea },
          emphasis: { disabled: true },
          markLine: {
            silent: true,
            symbol: 'none',
            data: [
              {
                yAxis: fpsTarget,
                lineStyle: { color: C.muted, type: 'dashed', width: 1 },
                label: {
                  formatter: 'target ' + fpsTarget,
                  color: C.muted,
                  fontFamily: FONT_BODY,
                  fontSize: 10,
                  position: 'insideEndTop',
                },
              },
            ],
          },
          markArea: { silent: true, itemStyle: { color: C.redBand }, data: [] },
          data: [],
        },
        {
          name: 'GPU %',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          showSymbol: false,
          smooth: 0.25,
          connectNulls: false,
          lineStyle: { width: 2, color: C.gpu },
          itemStyle: { color: C.gpu },
          emphasis: { disabled: true },
          markArea: { silent: true, itemStyle: { color: C.redBand }, data: [] },
          data: [],
        },
        {
          name: 'CPU %',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          showSymbol: false,
          smooth: 0.25,
          connectNulls: false,
          lineStyle: { width: 2, color: C.cpu },
          itemStyle: { color: C.cpu },
          emphasis: { disabled: true },
          data: [],
        },
        {
          name: 'CPU device %',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          showSymbol: false,
          smooth: 0.25,
          connectNulls: false,
          lineStyle: { width: 1.5, color: C.cpu, type: 'dashed', opacity: 0.45 },
          itemStyle: { color: C.cpu, opacity: 0.45 },
          emphasis: { disabled: true },
          data: [],
        },
      ],
    })
    chart.on('legendselectchanged', function (e) {
      legendSelected = e.selected
    })
    return chart
  }

  // bandas rojas: tramos consecutivos con status 'red' (mismo criterio del reporte 026)
  function redSpans() {
    var spans = []
    var start = null
    for (var i = 0; i < tickStatus.length; i++) {
      var st = tickStatus[i][1]
      if (st === 'red' && start === null) start = tickStatus[i][0]
      if (st !== 'red' && start !== null) {
        spans.push([start, tickStatus[i][0]])
        start = null
      }
    }
    if (start !== null) spans.push([start, tickStatus[tickStatus.length - 1][0]])
    return spans
  }

  function tlMarks() {
    var areas = redSpans().map(function (s) {
      return [{ xAxis: s[0] }, { xAxis: s[1] }]
    })
    var lines = [
      {
        yAxis: fpsTarget,
        lineStyle: { color: C.muted, type: 'dashed', width: 1 },
        label: {
          formatter: 'target ' + fpsTarget,
          color: C.muted,
          fontFamily: FONT_BODY,
          fontSize: 10,
          position: 'insideEndTop',
        },
      },
    ]
    crashMarks.forEach(function (ts) {
      lines.push({
        xAxis: ts,
        lineStyle: { color: C.bad, width: 1.5 },
        label: {
          formatter: 'CRASH',
          color: C.bad,
          fontFamily: FONT_BODY,
          fontSize: 9,
          fontWeight: 700,
          position: 'insideEndTop',
        },
      })
    })
    return { areas: areas, lines: lines }
  }

  function pushTl(s) {
    var ts = s.ts
    fpsData.push([ts, s.fps])
    gpuData.push([ts, s.gpu])
    cpuData.push([ts, s.cpu])
    cpuDevData.push([ts, s.deviceCpu])
    tickStatus.push([ts, fpsStatusOf(s.fps, fpsTarget)])
    ;[fpsData, gpuData, cpuData, cpuDevData, tickStatus].forEach(function (arr) {
      while (arr.length > WINDOW_S) arr.shift()
    })
    var cutoff = ts - WINDOW_S * 1000
    crashMarks = crashMarks.filter(function (t) {
      return t >= cutoff
    })
    var marks = tlMarks()
    tlPerf.setOption({
      series: [
        { data: fpsData, markArea: { data: marks.areas }, markLine: { data: marks.lines } },
        { data: gpuData, markArea: { data: marks.areas } },
        { data: cpuData },
        { data: cpuDevData },
      ],
    })
  }

  // =====================================================================
  // Memory: donut + trend
  // =====================================================================
  var memPie = null
  var memTrend = null
  var memTrendData = [] // [ts, pss]
  var gcDots = [] // [ts, pss]

  function memMeta() {
    // orden cromático validado (magenta·violeta·teal·ámbar) + neutrales al final
    return [
      { key: 'java', name: 'Java heap', color: C.memJava },
      { key: 'graphics', name: 'Graphics', color: C.memGraphics },
      { key: 'native', name: 'Native', color: C.memNative },
      { key: 'code', name: 'Code', color: C.memCode },
      { key: 'stack', name: 'Stack', color: C.memStack },
      { key: 'other', name: 'Other', color: C.memOther },
    ]
  }

  function makeMemPie() {
    var chart = echarts.init($('memPie'))
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
      legend: {
        bottom: 0,
        left: 'center',
        type: 'scroll',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 8,
        textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10.5 },
        pageIconColor: C.muted,
        pageTextStyle: { color: C.muted },
      },
      series: [
        {
          type: 'pie',
          radius: ['52%', '76%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          minShowLabelAngle: 18,
          itemStyle: { borderColor: C.card, borderWidth: 2, borderRadius: 4 },
          label: {
            show: true,
            position: 'inside',
            formatter: '{d}%',
            color: '#fff',
            fontFamily: FONT_BODY,
            fontSize: 9.5,
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

  function makeMemTrend() {
    var chart = echarts.init($('memTrend'))
    chart.setOption({
      animation: false,
      grid: { left: 46, right: 16, top: 6, bottom: 4 },
      xAxis: { type: 'time', show: false },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: {
          color: C.muted,
          fontFamily: FONT_BODY,
          fontSize: 9,
          formatter: function (v) {
            return Math.round(v)
          },
        },
        splitLine: { lineStyle: { color: C.split } },
        splitNumber: 2,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: C.card2,
        borderColor: C.line,
        textStyle: { color: C.text, fontSize: 11, fontFamily: FONT_BODY },
        valueFormatter: function (v) {
          return v === null || v === undefined ? 'N/A' : fmtMb(v)
        },
      },
      series: [
        {
          name: 'PSS',
          type: 'line',
          showSymbol: false,
          smooth: 0.3,
          connectNulls: false,
          lineStyle: { width: 1.5, color: C.cpu },
          itemStyle: { color: C.cpu },
          areaStyle: { color: C.memArea },
          emphasis: { disabled: true },
          data: [],
        },
        {
          name: 'GC',
          type: 'scatter',
          symbolSize: 6,
          itemStyle: { color: C.temp },
          tooltip: {
            valueFormatter: function (v) {
              return 'GC · ' + fmtMb(v)
            },
          },
          data: [],
        },
      ],
    })
    return chart
  }

  // =====================================================================
  // Network spark
  // =====================================================================
  var netSpark = null
  var netData = [[], []]
  var netTotalRx = 0
  var netTotalTx = 0

  function makeNetSpark() {
    var chart = echarts.init($('netSpark'))
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
          lineStyle: { width: 1.5, color: C.fps },
          itemStyle: { color: C.fps },
          areaStyle: { color: C.rxArea },
          data: [],
        },
        {
          name: '↑ tx',
          type: 'line',
          showSymbol: false,
          smooth: 0.3,
          lineStyle: { width: 1.5, color: C.gpu },
          itemStyle: { color: C.gpu },
          areaStyle: { color: C.txArea },
          data: [],
        },
      ],
    })
    return chart
  }

  function buildCharts() {
    tlPerf = makeTlPerf()
    memPie = makeMemPie()
    memTrend = makeMemTrend()
    netSpark = makeNetSpark()
    // re-inyectar buffers (cambio de tema)
    var marks = tlMarks()
    tlPerf.setOption({
      series: [
        { data: fpsData, markArea: { data: marks.areas }, markLine: { data: marks.lines } },
        { data: gpuData, markArea: { data: marks.areas } },
        { data: cpuData },
        { data: cpuDevData },
      ],
    })
    memTrend.setOption({ series: [{ data: memTrendData }, { data: gcDots }] })
    netSpark.setOption({ series: [{ data: netData[0] }, { data: netData[1] }] })
  }
  function allCharts() {
    return [tlPerf, memPie, memTrend, netSpark].filter(Boolean)
  }
  function disposeCharts() {
    allCharts().forEach(function (c) {
      c.dispose()
    })
    tlPerf = memPie = memTrend = netSpark = null
  }

  // =====================================================================
  // Tiles (DOM)
  // =====================================================================
  var STATUS_WORD = { green: 'on target', yellow: 'below target', red: 'way below target' }

  function setSem(el, st) {
    el.classList.remove('sem-green', 'sem-yellow', 'sem-red')
    if (st) el.classList.add('sem-' + st)
  }

  function renderTiles(s) {
    // ---- FPS hero ----
    var fpsNum = $('fpsNum')
    var st = fpsStatusOf(s.fps, fpsTarget)
    fpsNum.innerHTML =
      (s.fps === null ? '—' : Math.round(s.fps)) + '<span class="unit">fps</span>'
    setSem(fpsNum, st)
    var stEl = $('fpsStatus')
    setSem(stEl, st)
    $('fpsStatusWord').textContent =
      s.fps === null ? 'app not running' : st ? STATUS_WORD[st] : 'no target'
    var fr = s.frame || {}
    var jankEl = $('jankV')
    if (fr.jankPct === null || fr.jankPct === undefined) {
      jankEl.textContent = '—'
      setSem(jankEl, null)
    } else {
      jankEl.innerHTML =
        (fr.jankPct < 10 ? fr.jankPct.toFixed(1) : Math.round(fr.jankPct)) + '<span class="u">%</span>'
      setSem(jankEl, st)
    }
    $('p90V').innerHTML =
      fr.p90Ms === null || fr.p90Ms === undefined
        ? '—'
        : Math.round(fr.p90Ms) + '<span class="u">ms</span>'
    $('p99V').innerHTML =
      fr.p99Ms === null || fr.p99Ms === undefined
        ? '—'
        : Math.round(fr.p99Ms) + '<span class="u">ms</span>'

    // ---- GPU ----
    $('gpuNum').innerHTML =
      (s.gpu === null ? '—' : Math.round(s.gpu)) + '<span class="unit">%</span>'
    var gpuBar = $('gpuBar')
    gpuBar.style.width = (s.gpu === null ? 0 : s.gpu) + '%'
    gpuBar.style.background = s.gpu === null ? 'var(--track)' : bandColor(s.gpu, 65, 85)
    $('gpuSub').textContent = s.gpu === null ? 'N/A' : ''

    // ---- CPU ----
    $('cpuNum').innerHTML =
      (s.cpu === null ? '—' : Math.round(s.cpu)) + '<span class="unit">%</span>'
    $('coreSub').textContent =
      s.cpu === null ? '' : '≈ ' + Math.round(s.cpu * DEVICE_CORES) + '% of one core'
    var cpuBar = $('cpuBar')
    cpuBar.style.width = (s.cpu === null ? 0 : s.cpu) + '%'
    cpuBar.style.background = s.cpu === null ? 'var(--track)' : bandColor(s.cpu, 55, 75)
    $('cpuDevBar').style.width = (s.deviceCpu === null ? 0 : s.deviceCpu) + '%'
    $('cpuDevSub').textContent = s.deviceCpu === null ? '—' : Math.round(s.deviceCpu) + '%'

    // ---- Temp ----
    $('tempNum').innerHTML =
      (s.tempC === null ? '—' : s.tempC.toFixed(1)) + '<span class="unit">°C</span>'
    var tempBar = $('tempBar')
    var tPct = s.tempC === null ? 0 : Math.max(0, Math.min(100, ((s.tempC - 25) / 25) * 100))
    tempBar.style.width = tPct + '%'
    tempBar.style.background = s.tempC === null ? 'var(--track)' : bandColor(s.tempC, 38, 42)

    // ---- Battery ----
    var b = s.battery || {}
    $('batNum').innerHTML =
      (b.levelPct === null || b.levelPct === undefined ? '—' : Math.round(b.levelPct)) +
      '<span class="unit">%</span>'
    var batBar = $('batBar')
    batBar.style.width = (b.levelPct || 0) + '%'
    batBar.style.background =
      b.levelPct === null || b.levelPct === undefined
        ? 'var(--track)'
        : b.levelPct < 15
          ? C.bad
          : b.levelPct < 30
            ? C.warn
            : C.ok
    $('chipCharging').classList.toggle('show', b.charging === true)
    $('batSub').textContent = b.charging ? 'plugged in' : 'on battery'

    // ---- Memory KPIs + bars ----
    if (s.mem) {
      $('pssNum').textContent = fmtMb(s.mem.pss)
      $('rssNum').textContent = fmtMb(s.mem.rss)
      $('ramAppBar').style.width = Math.min(100, (s.mem.pss / DEVICE_RAM_MB) * 100) + '%'
      $('ramAppSub').textContent =
        fmtMb(s.mem.pss) + ' · ' + ((s.mem.pss / DEVICE_RAM_MB) * 100).toFixed(1) + '%'
    } else {
      $('pssNum').textContent = '—'
      $('rssNum').textContent = '—'
    }
    $('ramDevBar').style.width = Math.min(100, (s.deviceRamUsedMb / DEVICE_RAM_MB) * 100) + '%'
    $('ramDevSub').textContent =
      fmtMb(s.deviceRamUsedMb) + ' of ' + fmtMb(DEVICE_RAM_MB)

    // ---- phase note en el rail ----
    $('phaseNote').textContent = s.appAlive === false ? '' : 'phase: ' + s.phase
  }

  function renderMem(s) {
    if (!s.mem) {
      // gap real en la tendencia mientras la app está muerta
      memTrendData.push([s.ts, null])
      while (memTrendData.length > WINDOW_S) memTrendData.shift()
      memTrend.setOption({ series: [{ data: memTrendData }, { data: gcDots }] })
      return
    }
    memPie.setOption({
      series: [
        {
          data: memMeta().map(function (m) {
            return { name: m.name, value: s.mem[m.key] || 0, itemStyle: { color: m.color } }
          }),
        },
      ],
    })
    memTrendData.push([s.ts, s.mem.pss])
    while (memTrendData.length > WINDOW_S) memTrendData.shift()
    if (s.gc) gcDots.push([s.ts, s.mem.pss])
    var cutoff = s.ts - WINDOW_S * 1000
    gcDots = gcDots.filter(function (p) {
      return p[0] >= cutoff
    })
    memTrend.setOption({ series: [{ data: memTrendData }, { data: gcDots }] })
  }

  function renderNet(s) {
    if (s.netRxKb === null) {
      $('rxNow').textContent = 'N/A'
      $('txNow').textContent = 'N/A'
      return
    }
    netTotalRx += s.netRxKb
    netTotalTx += s.netTxKb
    netData[0].push([s.ts, s.netRxKb])
    netData[1].push([s.ts, s.netTxKb])
    netData.forEach(function (arr) {
      while (arr.length > WINDOW_S) arr.shift()
    })
    netSpark.setOption({ series: [{ data: netData[0] }, { data: netData[1] }] })
    $('rxNow').textContent = '↓ ' + fmtKb(s.netRxKb)
    $('txNow').textContent = '↑ ' + fmtKb(s.netTxKb)
    $('rxTot').textContent = 'total ' + fmtTotal(netTotalRx)
    $('txTot').textContent = 'total ' + fmtTotal(netTotalTx)
  }

  // =====================================================================
  // Mini-veredicto vivo (header) — espejo del esquema del reporte (026):
  // estado = fpsStatus(FPS promedio de la ventana de 60 s); el sub muestra
  // el % de ticks en verde. Crashes de la sesión suman un chip rojo.
  // =====================================================================
  var crashCount = 0
  function renderVerdict() {
    var el = $('verdict')
    var word = $('verdictWord')
    var sub = $('verdictSub')
    var last = tickStatus.slice(-60)
    var withData = last.filter(function (t) {
      return t[1] !== null
    })
    el.classList.remove('v-green', 'v-yellow', 'v-red')
    if (withData.length < 5) {
      word.textContent = 'WARMING UP'
      sub.textContent = '— in target · 60 s'
    } else {
      var lastFps = fpsData.slice(-60).filter(function (p) {
        return p[1] !== null
      })
      var avg =
        lastFps.reduce(function (a, p) {
          return a + p[1]
        }, 0) / lastFps.length
      var st = fpsStatusOf(avg, fpsTarget)
      var green = withData.filter(function (t) {
        return t[1] === 'green'
      }).length
      var pct = Math.round((green / withData.length) * 100)
      if (st === 'green') {
        el.classList.add('v-green')
        word.textContent = 'PERF GOOD'
      } else if (st === 'yellow') {
        el.classList.add('v-yellow')
        word.textContent = 'PERF WATCH'
      } else {
        el.classList.add('v-red')
        word.textContent = 'PERF POOR'
      }
      sub.textContent = pct + '% in target · 60 s'
    }
    var vc = $('verdictCrash')
    if (crashCount > 0) {
      vc.hidden = false
      vc.textContent = crashCount + ' crash' + (crashCount > 1 ? 'es' : '')
    }
  }

  // =====================================================================
  // Logs panel (versión prototipo de logsCore/logsPanel: filtros, orden,
  // pausa, export — cap de render 500)
  // =====================================================================
  var LOG_CAP = 5000
  var RENDER_CAP = 500
  var logEntries = []
  var logChips = { E: true, W: true, I: true, D: true }
  var logSearch = ''
  var logFrom = null
  var logTo = null
  var logAsc = true
  var logPaused = false
  var pendingWhilePaused = 0
  var countE = 0
  var countW = 0

  function chipOf(level) {
    if (level === 'E' || level === 'F') return 'E'
    if (level === 'W') return 'W'
    if (level === 'I') return 'I'
    return 'D'
  }
  function passes(e) {
    if (!logChips[chipOf(e.level)]) return false
    if (logFrom !== null && e.ts < logFrom) return false
    if (logTo !== null && e.ts > logTo) return false
    if (logSearch) {
      var hay = (e.tag + ' ' + e.message).toLowerCase()
      if (hay.indexOf(logSearch) === -1) return false
    }
    return true
  }
  function filteredEntries() {
    var out = logEntries.filter(passes)
    if (!logAsc) out.reverse()
    return out
  }

  function makeRow(e, withBadge) {
    var row = document.createElement('div')
    row.className = 'log-row lvl-' + e.level + (e.isCrash ? ' crash' : '')
    var t = document.createElement('span')
    t.className = 'log-time'
    var d = new Date(e.ts)
    t.textContent =
      fmtClock(e.ts) + '.' + String(d.getMilliseconds()).padStart(3, '0')
    var lvl = document.createElement('span')
    lvl.className = 'log-lvl'
    lvl.textContent = e.level
    var tag = document.createElement('span')
    tag.className = 'log-tag'
    tag.textContent = e.tag
    var msg = document.createElement('span')
    msg.className = 'log-msg'
    msg.textContent = e.message
    row.appendChild(t)
    row.appendChild(lvl)
    if (withBadge) {
      var badge = document.createElement('span')
      badge.className = 'log-crash-badge'
      badge.textContent = 'CRASH'
      row.appendChild(badge)
    }
    row.appendChild(tag)
    row.appendChild(msg)
    return row
  }

  function renderLogList() {
    var list = $('logsList')
    var all = filteredEntries()
    var slice = logAsc ? all.slice(-RENDER_CAP) : all.slice(0, RENDER_CAP)
    var hiddenN = all.length - slice.length
    var hiddenEl = $('logsHidden')
    if (hiddenN > 0) {
      hiddenEl.hidden = false
      hiddenEl.textContent =
        hiddenN + ' older lines match the filter — refine text/date to see them'
    } else {
      hiddenEl.hidden = true
    }
    list.innerHTML = ''
    var prevCrash = false
    var prevPid = null
    slice.forEach(function (e) {
      var firstOfBlock = e.isCrash && (!prevCrash || prevPid !== e.pid)
      list.appendChild(makeRow(e, firstOfBlock))
      prevCrash = e.isCrash
      prevPid = e.pid
    })
    $('logsEmpty').hidden = logEntries.length > 0
    $('logsMatched').hidden = false
    $('logsMatched').textContent = all.length + ' in filter'
    if (!logPaused) scrollLogsToEdge()
  }

  function scrollLogsToEdge() {
    var sc = $('logsScroll')
    sc.scrollTop = logAsc ? sc.scrollHeight : 0
  }

  function onLogs(entries) {
    if (!entries.length) return
    entries.forEach(function (e) {
      logEntries.push(e)
      if (e.level === 'E' || e.level === 'F') countE++
      if (e.level === 'W') countW++
    })
    while (logEntries.length > LOG_CAP) logEntries.shift()
    $('logsTotal').textContent = logEntries.length
    var be = $('logsBadgeE')
    var bw = $('logsBadgeW')
    be.textContent = 'E ' + countE
    bw.textContent = 'W ' + countW
    be.classList.toggle('nonzero', countE > 0)
    bw.classList.toggle('nonzero', countW > 0)
    if (logPaused) {
      pendingWhilePaused += entries.length
      var live = $('logsLive')
      live.hidden = false
      live.textContent = '▼ back to live (' + pendingWhilePaused + ' new)'
      return
    }
    renderLogList()
  }

  // controls
  $('logsChips').addEventListener('click', function (ev) {
    var chip = ev.target.getAttribute && ev.target.getAttribute('data-chip')
    if (!chip) return
    logChips[chip] = !logChips[chip]
    ev.target.classList.toggle('active', logChips[chip])
    renderLogList()
  })
  var searchDebounce = null
  $('logsSearch').addEventListener('input', function (ev) {
    clearTimeout(searchDebounce)
    searchDebounce = setTimeout(function () {
      logSearch = ev.target.value.trim().toLowerCase()
      renderLogList()
    }, 150)
  })
  $('logsFrom').addEventListener('change', function (ev) {
    logFrom = ev.target.value ? new Date(ev.target.value).getTime() : null
    renderLogList()
  })
  $('logsTo').addEventListener('change', function (ev) {
    logTo = ev.target.value ? new Date(ev.target.value).getTime() + 59999 : null
    renderLogList()
  })
  $('logsOrder').addEventListener('click', function () {
    logAsc = !logAsc
    $('logsOrder').textContent = logAsc ? '↓ old→new' : '↑ new→old'
    renderLogList()
  })
  function setLogsPaused(p) {
    logPaused = p
    $('logsPause').textContent = p ? '▶ Resume' : '⏸ Pause'
    if (!p) {
      pendingWhilePaused = 0
      $('logsLive').hidden = true
      renderLogList()
    }
  }
  $('logsPause').addEventListener('click', function () {
    setLogsPaused(!logPaused)
  })
  $('logsLive').addEventListener('click', function () {
    setLogsPaused(false)
  })
  $('logsScroll').addEventListener('scroll', function () {
    var sc = $('logsScroll')
    var atEdge = logAsc
      ? sc.scrollHeight - sc.scrollTop - sc.clientHeight < 30
      : sc.scrollTop < 30
    if (!atEdge && !logPaused) setLogsPaused(true)
  })
  $('logsToggle').addEventListener('click', function () {
    var body = $('logsBody')
    body.hidden = !body.hidden
    $('logsCaret').textContent = body.hidden ? '▼' : '▲'
    if (!body.hidden) renderLogList()
  })

  // export (real en el prototipo: serializa y descarga un blob)
  function serializeTxt(entries) {
    return entries
      .map(function (e) {
        var d = new Date(e.ts)
        var pre = e.isCrash ? '[CRASH] ' : ''
        return (
          pre +
          fmtClock(e.ts) +
          '.' +
          String(d.getMilliseconds()).padStart(3, '0') +
          ' ' +
          e.level +
          '/' +
          e.tag +
          '(' +
          e.pid +
          '): ' +
          e.message
        )
      })
      .join('\n')
  }
  function serializeJsonl(entries) {
    return entries
      .map(function (e) {
        return JSON.stringify(e)
      })
      .join('\n')
  }
  $('logsExport').addEventListener('click', function (ev) {
    var kind = ev.target.getAttribute && ev.target.getAttribute('data-export')
    if (!kind) return
    var parts = kind.split('-')
    var scope = parts[0]
    var format = parts[1]
    var entries = scope === 'filtered' ? filteredEntries() : logEntries.slice()
    var status = $('logsExportStatus')
    if (!entries.length) {
      status.textContent = 'no lines to export'
      status.className = 'logs-export-status'
      return
    }
    var body = format === 'txt' ? serializeTxt(entries) : serializeJsonl(entries)
    var blob = new Blob([body], { type: format === 'txt' ? 'text/plain' : 'application/x-ndjson' })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download =
      'sample-logs-prototype' + (scope === 'filtered' ? '-filtered' : '') + '.' + format
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(function () {
      URL.revokeObjectURL(a.href)
    }, 10000)
    status.textContent = entries.length + ' lines exported ✓'
    status.className = 'logs-export-status ok'
  })

  // =====================================================================
  // Header: device ficha, selector de apps, menú, tema, inspector
  // =====================================================================
  var DEVICE = {
    name: 'Samsung SM-A155M',
    specs: ['Android 15 (API 36)', '8 GB RAM', 'Mali-G57 MC2', 'MT6789', '8 cores', '90 Hz', 'R58W34ABCDE'],
  }
  function renderDevice() {
    var el = $('devSpecs')
    el.innerHTML = ''
    DEVICE.specs.forEach(function (t) {
      var span = document.createElement('span')
      span.className = 'spec' + (/Hz$/.test(t) ? ' hz' : '')
      span.textContent = t
      el.appendChild(span)
    })
  }
  function renderDevList() {
    var list = $('devList')
    list.innerHTML = ''
    ;[
      { label: 'SM A155M', serial: 'R58W34ABCDE', state: 'device', current: true },
      { label: 'Pixel 4a', serial: '09071FDD400', state: 'unauthorized', current: false },
    ].forEach(function (d) {
      var li = document.createElement('li')
      var b = document.createElement('button')
      b.type = 'button'
      if (d.current) b.className = 'current'
      var name = document.createElement('span')
      name.textContent = (d.current ? '✓ ' : '') + d.label
      var serial = document.createElement('span')
      serial.className = 'dev-serial'
      serial.textContent = d.serial
      b.appendChild(name)
      b.appendChild(serial)
      if (d.state !== 'device') {
        var st = document.createElement('span')
        st.className = 'dev-state'
        st.textContent = d.state
        b.appendChild(st)
        b.disabled = true
      }
      li.appendChild(b)
      list.appendChild(li)
    })
  }

  var PACKAGES = [
    { pkg: 'com.sample.oda.qa', uses: 41, sample: true },
    { pkg: 'com.sample.arcade.dev', uses: 12, sample: true },
    { pkg: 'com.sample.arcade', uses: 3, sample: true },
    { pkg: 'com.miniclip.eightballpool', uses: 0 },
    { pkg: 'com.king.candycrushsaga', uses: 0 },
    { pkg: 'com.android.chrome', uses: 0, system: true },
    { pkg: 'com.samsung.android.game.gametools', uses: 0, system: true },
  ]
  var currentPkg = 'com.sample.oda.qa'
  var appChipOn = true

  function renderAppList() {
    var term = appChipOn ? 'sample' : $('appSearch').value.trim().toLowerCase()
    var withSys = $('appSys').checked
    var shown = PACKAGES.filter(function (p) {
      if (p.system && !withSys) return false
      return !term || p.pkg.toLowerCase().indexOf(term) !== -1
    })
    var list = $('appList')
    list.innerHTML = ''
    $('appEmpty').hidden = shown.length > 0
    shown.forEach(function (p) {
      var li = document.createElement('li')
      var b = document.createElement('button')
      b.type = 'button'
      if (p.pkg === currentPkg) b.className = 'current'
      var name = document.createElement('span')
      name.textContent = (p.pkg === currentPkg ? '✓ ' : '') + p.pkg
      b.appendChild(name)
      if (p.uses) {
        var u = document.createElement('span')
        u.className = 'use-count'
        u.textContent = p.uses + '×'
        b.appendChild(u)
      }
      b.addEventListener('click', function () {
        selectApp(p.pkg)
      })
      li.appendChild(b)
      list.appendChild(li)
    })
  }

  function resetSeries() {
    fpsData.length = 0
    gpuData.length = 0
    cpuData.length = 0
    cpuDevData.length = 0
    tickStatus.length = 0
    crashMarks.length = 0
    memTrendData.length = 0
    gcDots.length = 0
    netData[0].length = 0
    netData[1].length = 0
    netTotalRx = 0
    netTotalTx = 0
    logEntries.length = 0
    countE = 0
    countW = 0
    crashCount = 0
    $('verdictCrash').hidden = true
    $('logsTotal').textContent = '0'
    $('logsBadgeE').textContent = 'E 0'
    $('logsBadgeW').textContent = 'W 0'
    $('logsBadgeE').classList.remove('nonzero')
    $('logsBadgeW').classList.remove('nonzero')
    renderLogList()
  }

  function setLaunchedBadge(state) {
    var el = $('appLaunched')
    el.hidden = false
    if (state === 'waiting') {
      el.textContent = 'waiting for process…'
      el.className = 'app-launched waiting'
    } else if (state === 'launched') {
      el.textContent = '🚀 launched'
      el.className = 'app-launched'
    } else {
      el.hidden = true
    }
  }

  function selectApp(pkg) {
    closePops()
    if (pkg === currentPkg) return
    currentPkg = pkg
    $('appPkg').textContent = pkg
    resetSeries()
    session = RedesignSim.createSession() // sesión nueva de sim para la app nueva
    setLaunchedBadge('waiting')
    setTimeout(function () {
      setLaunchedBadge('launched')
    }, 2200)
  }

  // popover plumbing
  function togglePop(pop) {
    var wasHidden = pop.hidden
    closePops()
    pop.hidden = !wasHidden
  }
  function closePops() {
    ;['devPop', 'appPop', 'menuPop'].forEach(function (id) {
      $(id).hidden = true
    })
  }
  $('devBtn').addEventListener('click', function (e) {
    e.stopPropagation()
    renderDevList()
    togglePop($('devPop'))
  })
  $('devRefresh').addEventListener('click', function (e) {
    e.stopPropagation()
    renderDevList()
  })
  $('appPkgBtn').addEventListener('click', function (e) {
    e.stopPropagation()
    renderAppList()
    togglePop($('appPop'))
    $('appSearch').focus()
  })
  $('appSearch').addEventListener('input', function () {
    if ($('appSearch').value.trim()) appChipOn = false
    $('appChip').classList.toggle('active', appChipOn)
    renderAppList()
  })
  $('appChip').addEventListener('click', function () {
    appChipOn = !appChipOn
    if (appChipOn) $('appSearch').value = ''
    $('appChip').classList.toggle('active', appChipOn)
    renderAppList()
  })
  $('appSys').addEventListener('change', renderAppList)
  $('menuBtn').addEventListener('click', function (e) {
    e.stopPropagation()
    renderSessions()
    togglePop($('menuPop'))
  })
  ;['devPop', 'appPop', 'menuPop'].forEach(function (id) {
    $(id).addEventListener('click', function (e) {
      e.stopPropagation()
    })
  })
  document.addEventListener('click', closePops)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePops()
  })

  // menú ☰ (acciones simuladas + config real del prototipo)
  function setStatus(el, msg, kind) {
    el.textContent = msg || ''
    el.className = 'menu-status' + (kind ? ' ' + kind : '')
  }
  $('exportRow').addEventListener('click', function (e) {
    var w = e.target.getAttribute && e.target.getAttribute('data-window')
    if (w) setStatus($('exportStatus'), 'Prototype: report export is simulated here.', 'ok')
  })
  function renderSessions() {
    var list = $('sessList')
    list.innerHTML = ''
    ;[
      { date: 'Today 09:12', sub: '42m 10s · com.sample.oda.qa', current: true },
      { date: 'Yesterday 18:40', sub: '1h 05m · com.sample.arcade.dev', current: false },
    ].forEach(function (s) {
      var li = document.createElement('li')
      li.className = 'sess-item'
      var b = document.createElement('button')
      b.type = 'button'
      if (s.current) b.className = 'current'
      var meta = document.createElement('span')
      meta.className = 'sess-meta'
      var date = document.createElement('span')
      date.className = 'sess-date'
      date.textContent = s.date + (s.current ? ' · in progress' : '')
      var sub = document.createElement('span')
      sub.className = 'sess-sub'
      sub.textContent = s.sub
      meta.appendChild(date)
      meta.appendChild(sub)
      var dl = document.createElement('span')
      dl.className = 'use-count'
      dl.textContent = '⬇ report'
      b.appendChild(meta)
      b.appendChild(dl)
      b.addEventListener('click', function () {
        setStatus($('exportStatus'), 'Prototype: report export is simulated here.', 'ok')
      })
      li.appendChild(b)
      ;['txt', 'jsonl'].forEach(function (fmt) {
        var lb = document.createElement('button')
        lb.type = 'button'
        lb.className = 'chip'
        lb.textContent = '⬇ .' + fmt
        lb.addEventListener('click', function (e) {
          e.stopPropagation()
          setStatus($('exportStatus'), 'Prototype: session log export is simulated here.', 'ok')
        })
        li.appendChild(lb)
      })
      list.appendChild(li)
    })
  }
  $('sessRefresh').addEventListener('click', function (e) {
    e.stopPropagation()
    renderSessions()
  })
  $('cfgSave').addEventListener('click', function () {
    var n = Number($('cfgFps').value)
    if (isFinite(n) && n >= 1 && n <= 240) setFpsTarget(Math.round(n))
    setStatus($('cfgStatus'), 'Saved ✓ (prototype — target FPS applies live)', 'ok')
  })
  $('cfgTheme').addEventListener('change', function () {
    applyTheme($('cfgTheme').checked ? 'dark' : 'light')
  })

  function setFpsTarget(n) {
    fpsTarget = n
    $('targetChip').textContent = 'target ' + n
    // re-evaluar el status de todos los ticks buffereados con el target nuevo
    tickStatus = fpsData.map(function (p) {
      return [p[0], fpsStatusOf(p[1], fpsTarget)]
    })
    if (lastSample) {
      renderTiles(lastSample)
      pushless()
    }
    renderVerdict()
  }
  // re-pintar marcas sin pushear un tick nuevo
  function pushless() {
    var marks = tlMarks()
    tlPerf.setOption({
      series: [
        { data: fpsData, markArea: { data: marks.areas }, markLine: { data: marks.lines } },
        { data: gpuData, markArea: { data: marks.areas } },
      ],
    })
  }

  // tema
  function applyTheme(next) {
    if (next === theme) return
    theme = next
    C = PALETTES[theme]
    document.body.setAttribute('data-theme', theme)
    $('themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙'
    $('cfgTheme').checked = theme === 'dark'
    disposeCharts()
    buildCharts()
    if (lastSample) renderTiles(lastSample)
  }
  $('themeToggle').addEventListener('click', function () {
    applyTheme(theme === 'dark' ? 'light' : 'dark')
  })

  // inspector
  var inspectorOn = false
  var flowCount = 0
  var flowTimer = null
  function fmtBytes(b) {
    if (!b) return '—'
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB'
    if (b > 1024) return (b / 1024).toFixed(1) + ' KB'
    return b + ' B'
  }
  function addFlow(f) {
    $('flowEmpty').style.display = 'none'
    flowCount++
    $('flowN').textContent = flowCount
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
    td(null, f.host)
    td(null, f.kind === 'http' ? f.url : f.url.replace(/^https?:\/\/[^/]+/, ''))
    var status = document.createElement('span')
    if (f.status >= 200 && f.status < 300) {
      status.className = 'insp-ok'
      status.textContent = String(f.status)
    } else if (f.status > 0) {
      status.textContent = String(f.status)
    } else {
      status.className = 'insp-err'
      status.textContent = '—'
    }
    td(null, status)
    td(null, fmtBytes(f.bytes))
    var rows = $('flowRows')
    rows.prepend(tr)
    while (rows.children.length > 200) rows.removeChild(rows.lastChild)
  }
  $('inspToggle').addEventListener('click', function () {
    inspectorOn = !inspectorOn
    $('inspState').textContent = inspectorOn ? 'ON' : 'OFF'
    $('inspToggle').classList.toggle('on', inspectorOn)
    $('inspector').hidden = !inspectorOn && flowCount === 0
    if (inspectorOn) {
      flowTimer = setInterval(function () {
        if (Math.random() < 0.75) addFlow(RedesignSim.fakeFlow())
      }, 1400)
    } else {
      clearInterval(flowTimer)
    }
  })

  // =====================================================================
  // Main loop
  // =====================================================================
  var session = RedesignSim.createSession()
  var lastSample = null
  var startTs = Date.now()

  setInterval(function () {
    var s = Math.floor((Date.now() - startTs) / 1000)
    $('recTime').textContent = pad2(Math.floor(s / 60)) + ':' + pad2(s % 60)
  }, 1000)

  var wasAlive = true
  function step(nowOverride) {
    var s = session.tick(nowOverride)
    lastSample = s

    // crash / app-died plumbing
    if (wasAlive && s.appAlive === false) {
      crashCount++
      crashMarks.push(s.ts)
      setLaunchedBadge('waiting')
    }
    if (s.relaunched) setLaunchedBadge('launched')
    wasAlive = s.appAlive !== false

    renderTiles(s)
    pushTl(s)
    renderMem(s)
    renderNet(s)
    renderVerdict()
    if (s.logs && s.logs.length) onLogs(s.logs)
  }

  renderDevice()
  buildCharts()
  window.addEventListener('resize', function () {
    allCharts().forEach(function (c) {
      c.resize()
    })
  })

  // arranque con historia previa: 75 ticks ya "ocurridos" (timestamps reales
  // hacia atrás) para que la timeline, el veredicto y los logs no arranquen vacíos
  var BACKFILL = 75
  var t0 = Date.now() - BACKFILL * 1000
  for (var i = 0; i < BACKFILL; i++) step(t0 + i * 1000)
  setInterval(function () {
    step()
  }, 1000)
})()
