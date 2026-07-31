/**
 * render.js — render del LIVE dashboard (tickets 021 → rediseño 032).
 * Implementa el contrato visual del prototipo del 031 (prototypes/redesign/app.js)
 * sobre datos REALES: live.js alimenta render() con Samples del WebSocket; acá
 * solo hay ECharts + DOM, data-source-agnostic.
 *
 * Piezas (031/032):
 *  - FPS hero: número 84 px coloreado por el semáforo del 025, pill de estado en
 *    palabras, chip del target y jank%/p90/p99 (024) como sub-stats.
 *  - Timeline de perf: 2 carriles apilados (FPS arriba con markline del target,
 *    bandas rojas y marcas CRASH; GPU%/CPU% abajo), eje X + crosshair compartidos,
 *    unidades reales por carril. Ventana 180 s. Serie "CPU device %" off default.
 *  - Memory: donut PSS + KPIs (PSS/RSS) + barras app/device + trend de PSS con
 *    puntos ámbar de GC (live.js los detecta en logcat → noteGc).
 *  - System: tiles CPU/Temp/Battery con número grande + barra por umbral.
 *  - Mini-veredicto vivo del header: fpsStatus(avg FPS 60 s) + % de ticks en
 *    verde (espejo del esquema del reporte 026); crashes → chip rojo (noteCrash);
 *    < 5 ticks con dato ⇒ WARMING UP.
 *  - Todo campo del Sample puede ser null → se dibuja como N/A (nunca 0).
 */
;(function (global) {
  'use strict'

  // ---- paletas de charts (espejo de los tokens CSS; validadas con dataviz) ----
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
      track: '#22222E',
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
      track: '#ECECF4',
    },
  }
  var theme = 'dark'
  var C = PALETTES[theme]

  var FONT_BODY = "'Inter', system-ui, sans-serif"

  var WINDOW_S = 180 // ventana visible de la timeline (contrato 031)
  var VERDICT_S = 60 // ventana del mini-veredicto (espejo del reporte 026)
  var VERDICT_MIN_TICKS = 5 // menos ticks con dato ⇒ WARMING UP

  // DeviceInfo.ramTotalMb del device ACTUAL; null hasta que reporte (las barras
  // de RAM degradan a valor absoluto sin %) — nunca se hereda del device anterior
  var deviceRamMb = null
  var deviceCores = null // DeviceInfo.cores → "≈ X% of one core"

  function $(id) {
    return document.getElementById(id)
  }
  // RAM adaptativa: las apps viven en MB; GB recién pasado 1 GiB
  function fmtMb(mb) {
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB'
  }
  function fmtKb(kb) {
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB/s' : Math.round(kb) + ' KB/s'
  }
  function fmtTotal(kb) {
    return kb >= 1024 * 1024 ? (kb / 1048576).toFixed(2) + ' GB' : (kb / 1024).toFixed(1) + ' MB'
  }
  function bandColor(v, warn, bad) {
    return v < warn ? C.ok : v < bad ? C.warn : C.bad
  }

  // ---------- semáforo de FPS (ticket 025) ----------
  // Espejo de src/core/perf/threshold.ts (la UI es JS plano servido estático, sin
  // bundler): verde ≥ target · amarillo ≥ 80% del target · rojo abajo. Sin FPS o
  // target inválido ⇒ null (sin color, no rojo). live.js actualiza fpsTarget desde
  // /api/config (default 30) y el cambio re-pinta en caliente.
  // GUARDIA: src/ui/mirrors.test.ts extrae esta función del archivo y la compara
  // contra el core — si cambiás un lado y no el otro, ese test rompe.
  var fpsTarget = 30

  function fpsStatusOf(fps, target) {
    if (fps === null || fps === undefined || !isFinite(fps) || fps < 0) return null
    if (typeof target !== 'number' || !isFinite(target) || target <= 0) return null
    if (fps >= target) return 'green'
    if (fps >= target * 0.8) return 'yellow'
    return 'red'
  }

  // =====================================================================
  // Perf timeline — 2 carriles apilados, eje X compartido, unidades reales
  // =====================================================================
  var tlPerf = null
  var fpsData = [] // [ts, fps|null]
  var gpuData = []
  var cpuData = []
  var cpuDevData = []
  var tickStatus = [] // [ts, 'green'|'yellow'|'red'|null] → bandas rojas + veredicto
  var crashMarks = [] // ts de cada crash (live.js → noteCrash)
  var legendSelected = { FPS: true, 'GPU %': true, 'CPU %': true, 'CPU device %': false }
  var fpsAxisMax = 40

  // techo del carril de FPS: el target con headroom, o el máximo observado
  function computeFpsAxisMax() {
    var top = Math.ceil((fpsTarget * 7) / 6 / 10) * 10
    for (var i = 0; i < fpsData.length; i++) {
      var v = fpsData[i][1]
      if (v !== null && v > top) top = Math.ceil(v / 10) * 10
    }
    return Math.max(top, 10)
  }

  function makeTlPerf() {
    var chart = echarts.init($('tlPerf'))
    fpsAxisMax = computeFpsAxisMax()
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
          axisLabel: {
            color: C.muted,
            fontFamily: FONT_BODY,
            fontSize: 10,
            formatter: '{HH}:{mm}:{ss}',
          },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          type: 'value',
          gridIndex: 0,
          min: 0,
          max: fpsAxisMax,
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
          markLine: { silent: true, symbol: 'none', data: [] },
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

  // ± medio tick real para los spans (mismo criterio que el fix del template del
  // reporte): el intervalo efectivo es configurable (1–2 s), así que se estima
  // con la mediana de los gaps entre ticks buffereados.
  function halfTickMs() {
    var gaps = []
    for (var i = 1; i < tickStatus.length; i++) {
      gaps.push(tickStatus[i][0] - tickStatus[i - 1][0])
    }
    if (gaps.length === 0) return 500
    gaps.sort(function (a, b) {
      return a - b
    })
    return gaps[Math.floor(gaps.length / 2)] / 2
  }

  // bandas rojas: tramos consecutivos con status 'red' (mismo criterio del 026),
  // acolchonados ± medio tick — un tick rojo aislado pinta banda visible
  function redSpans() {
    var spans = []
    var start = null
    var last = null
    for (var i = 0; i < tickStatus.length; i++) {
      if (tickStatus[i][1] === 'red') {
        if (start === null) start = tickStatus[i][0]
        last = tickStatus[i][0]
      } else if (start !== null) {
        spans.push([start, last])
        start = null
      }
    }
    if (start !== null) spans.push([start, last])
    var h = halfTickMs()
    return spans.map(function (s) {
      return [s[0] - h, s[1] + h]
    })
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

  function trimByTime(arr, cutoff) {
    while (arr.length > 0 && arr[0][0] < cutoff) arr.shift()
  }

  function repaintTl() {
    if (!tlPerf) return
    var marks = tlMarks()
    var newMax = computeFpsAxisMax()
    var opt = {
      series: [
        {
          data: fpsData,
          markArea: { data: marks.areas },
          markLine: { silent: true, symbol: 'none', data: marks.lines },
        },
        { data: gpuData, markArea: { data: marks.areas } },
        { data: cpuData },
        { data: cpuDevData },
      ],
    }
    if (newMax !== fpsAxisMax) {
      fpsAxisMax = newMax
      opt.yAxis = [{ max: fpsAxisMax }, {}]
    }
    tlPerf.setOption(opt)
  }

  function pushTl(s) {
    var ts = s.ts || Date.now()
    fpsData.push([ts, s.fps])
    gpuData.push([ts, s.gpu])
    cpuData.push([ts, s.cpu])
    cpuDevData.push([ts, s.deviceCpu === undefined ? null : s.deviceCpu])
    tickStatus.push([ts, fpsStatusOf(s.fps, fpsTarget)])
    var cutoff = ts - WINDOW_S * 1000
    ;[fpsData, gpuData, cpuData, cpuDevData, tickStatus].forEach(function (arr) {
      trimByTime(arr, cutoff)
    })
    crashMarks = crashMarks.filter(function (t) {
      return t >= cutoff
    })
    repaintTl()
  }

  // =====================================================================
  // Memory: donut + KPIs + trend con puntos de GC
  // =====================================================================
  var memPie = null
  var memTrend = null
  var memTrendData = [] // [ts, pss|null]
  var gcDots = [] // [ts, pss]
  var lastPss = null

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

  function repaintMemTrend() {
    if (memTrend) memTrend.setOption({ series: [{ data: memTrendData }, { data: gcDots }] })
  }

  function renderMem(s) {
    var ts = s.ts || Date.now()
    var pss = s.mem ? s.mem.pss : null
    if (pss !== null && pss !== undefined) lastPss = pss
    // KPIs
    $('pssNum').textContent = pss === null || pss === undefined ? '—' : fmtMb(pss)
    var rss = s.mem ? s.mem.rss : null
    $('rssNum').textContent = rss === null || rss === undefined ? '—' : fmtMb(rss)
    // barras app / device (sin ramTotalMb del device: valor absoluto, sin %)
    if (pss !== null && pss !== undefined) {
      $('ramAppBar').style.width = deviceRamMb
        ? Math.min(100, (pss / deviceRamMb) * 100) + '%'
        : '0%'
      $('ramAppSub').textContent = deviceRamMb
        ? fmtMb(pss) + ' · ' + ((pss / deviceRamMb) * 100).toFixed(1) + '%'
        : fmtMb(pss)
    } else {
      $('ramAppBar').style.width = '0%'
      $('ramAppSub').textContent = '—'
    }
    var devUsed = s.deviceRamUsedMb
    if (devUsed !== null && devUsed !== undefined) {
      $('ramDevBar').style.width = deviceRamMb
        ? Math.min(100, (devUsed / deviceRamMb) * 100) + '%'
        : '0%'
      $('ramDevSub').textContent = deviceRamMb
        ? fmtMb(devUsed) + ' of ' + fmtMb(deviceRamMb)
        : fmtMb(devUsed)
    } else {
      $('ramDevBar').style.width = '0%'
      $('ramDevSub').textContent = '—'
    }
    // donut (solo con dato; con la app muerta el pie conserva la última foto)
    if (memPie && s.mem && pss !== null && pss !== undefined) {
      memPie.setOption({
        series: [
          {
            data: memMeta().map(function (m) {
              return { name: m.name, value: s.mem[m.key] || 0, itemStyle: { color: m.color } }
            }),
          },
        ],
      })
    }
    // trend (gap real con null)
    memTrendData.push([ts, pss === undefined ? null : pss])
    var cutoff = ts - WINDOW_S * 1000
    trimByTime(memTrendData, cutoff)
    gcDots = gcDots.filter(function (p) {
      return p[0] >= cutoff
    })
    repaintMemTrend()
  }

  // =====================================================================
  // Network spark
  // =====================================================================
  var netSpark = null
  var netData = [[], []]
  var netTotalRx = 0
  var netTotalTx = 0
  var netEverSeen = false

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

  function renderNet(s) {
    var ts = s.ts || Date.now()
    if (s.netRxKb === null && s.netTxKb === null) {
      var na = $('netNa')
      if (na && !netEverSeen) na.hidden = false
      $('rxNow').textContent = 'N/A'
      $('txNow').textContent = 'N/A'
      $('rxTot').textContent = ''
      $('txTot').textContent = ''
      return
    }
    netEverSeen = true
    $('netNa').hidden = true
    netTotalRx += s.netRxKb || 0
    netTotalTx += s.netTxKb || 0
    netData[0].push([ts, s.netRxKb || 0])
    netData[1].push([ts, s.netTxKb || 0])
    var cutoff = ts - WINDOW_S * 1000
    netData.forEach(function (arr) {
      trimByTime(arr, cutoff)
    })
    if (netSpark) netSpark.setOption({ series: [{ data: netData[0] }, { data: netData[1] }] })
    $('rxNow').textContent = '↓ ' + fmtKb(s.netRxKb || 0)
    $('txNow').textContent = '↑ ' + fmtKb(s.netTxKb || 0)
    $('rxTot').textContent = 'total ' + fmtTotal(netTotalRx)
    $('txTot').textContent = 'total ' + fmtTotal(netTotalTx)
  }

  // =====================================================================
  // Tiles (DOM)
  // =====================================================================
  var STATUS_WORD = { green: 'on target', yellow: 'below target', red: 'way below target' }
  var appRunning = null // live.js → setAppRunning (pid null = app no corre)

  function setSem(el, st) {
    el.classList.remove('sem-green', 'sem-yellow', 'sem-red')
    if (st) el.classList.add('sem-' + st)
  }

  function renderTiles(s) {
    // ---- FPS hero ----
    var fpsNum = $('fpsNum')
    var st = fpsStatusOf(s.fps, fpsTarget)
    fpsNum.innerHTML = (s.fps === null ? '—' : Math.round(s.fps)) + '<span class="unit">fps</span>'
    setSem(fpsNum, st)
    var stEl = $('fpsStatus')
    setSem(stEl, st)
    $('fpsStatusWord').textContent =
      s.fps === null
        ? appRunning === false
          ? 'app not running'
          : 'no data'
        : st
          ? STATUS_WORD[st]
          : 'no target'
    var fr = s.frame || {}
    var jankEl = $('jankV')
    if (fr.jankPct === null || fr.jankPct === undefined) {
      jankEl.textContent = '—'
      setSem(jankEl, null)
    } else {
      jankEl.innerHTML =
        (fr.jankPct < 10 ? fr.jankPct.toFixed(1) : Math.round(fr.jankPct)) +
        '<span class="u">%</span>'
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
    // share-of-device esconde un main thread clavado: mostrar la conversión al lado
    $('coreSub').textContent =
      s.cpu === null || !deviceCores ? '' : '≈ ' + Math.round(s.cpu * deviceCores) + '% of one core'
    var cpuBar = $('cpuBar')
    cpuBar.style.width = (s.cpu === null ? 0 : s.cpu) + '%'
    cpuBar.style.background = s.cpu === null ? 'var(--track)' : bandColor(s.cpu, 55, 75)
    var devCpu = s.deviceCpu === undefined ? null : s.deviceCpu
    $('cpuDevBar').style.width = (devCpu === null ? 0 : devCpu) + '%'
    $('cpuDevSub').textContent = devCpu === null ? '—' : Math.round(devCpu) + '%'

    // ---- Temp ----
    $('tempNum').innerHTML =
      (s.tempC === null ? '—' : s.tempC.toFixed(1)) + '<span class="unit">°C</span>'
    var tempBar = $('tempBar')
    var tPct = s.tempC === null ? 0 : Math.max(0, Math.min(100, ((s.tempC - 25) / 25) * 100))
    tempBar.style.width = tPct + '%'
    tempBar.style.background = s.tempC === null ? 'var(--track)' : bandColor(s.tempC, 38, 42)
    var batT = s.battery ? s.battery.tempC : null
    $('tempTrendSub').textContent =
      batT === null || batT === undefined ? '' : 'battery ' + batT.toFixed(1) + ' °C'

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
    $('batSub').textContent =
      b.charging === true ? 'plugged in' : b.charging === false ? 'on battery' : ''
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
    var lastTs = tickStatus.length ? tickStatus[tickStatus.length - 1][0] : Date.now()
    var cutoff = lastTs - VERDICT_S * 1000
    var withData = tickStatus.filter(function (t) {
      return t[0] >= cutoff && t[1] !== null
    })
    el.classList.remove('v-green', 'v-yellow', 'v-red')
    if (withData.length < VERDICT_MIN_TICKS) {
      word.textContent = 'WARMING UP'
      sub.textContent = '— in target · 60 s'
    } else {
      var lastFps = fpsData.filter(function (p) {
        return p[0] >= cutoff && p[1] !== null
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
      } else if (st === 'red') {
        el.classList.add('v-red')
        word.textContent = 'PERF POOR'
      } else {
        word.textContent = 'WARMING UP'
      }
      sub.textContent = pct + '% in target · 60 s'
    }
    var vc = $('verdictCrash')
    if (crashCount > 0) {
      vc.hidden = false
      vc.textContent = crashCount + ' crash' + (crashCount > 1 ? 'es' : '')
    } else {
      vc.hidden = true
    }
  }

  // live.js detecta el comienzo de un bloque de crash en el stream de logs
  // (ticket 027) y lo marca acá: chip rojo del veredicto + marca CRASH en la
  // timeline (patrón session.marks del 030).
  function noteCrash(ts) {
    crashCount++
    crashMarks.push(ts || Date.now())
    repaintTl()
    renderVerdict()
  }

  // live.js detecta líneas de GC del ART en logcat → punto ámbar sobre el trend
  function noteGc(ts) {
    if (lastPss === null) return
    gcDots.push([ts || Date.now(), lastPss])
    repaintMemTrend()
  }

  // =====================================================================
  // Build / dispose / render
  // =====================================================================
  function allCharts() {
    return [tlPerf, memPie, memTrend, netSpark].filter(Boolean)
  }

  function buildCharts() {
    tlPerf = makeTlPerf()
    memPie = makeMemPie()
    memTrend = makeMemTrend()
    netSpark = makeNetSpark()
    // re-inyectar buffers (cambio de tema)
    repaintTl()
    repaintMemTrend()
    netSpark.setOption({ series: [{ data: netData[0] }, { data: netData[1] }] })
  }

  function disposeCharts() {
    allCharts().forEach(function (c) {
      c.dispose()
    })
    tlPerf = memPie = memTrend = netSpark = null
  }

  var lastSample = null

  function render(s) {
    lastSample = s
    renderTiles(s)
    pushTl(s)
    renderMem(s)
    renderNet(s)
    renderVerdict()
  }

  // ---------- target FPS (aplica en caliente, ticket 025) ----------
  function setFpsTarget(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return
    if (n === fpsTarget) return
    fpsTarget = n
    $('targetChip').textContent = 'target ' + n
    // re-evaluar el status de todos los ticks buffereados con el target nuevo
    tickStatus = fpsData.map(function (p) {
      return [p[0], fpsStatusOf(p[1], fpsTarget)]
    })
    if (lastSample) renderTiles(lastSample)
    repaintTl()
    renderVerdict()
  }

  // ---------- ficha del device ----------
  function setDevice(info, pkg) {
    var name = [info.manufacturer, info.model].filter(Boolean).join(' ') || info.serial
    $('devName').textContent = name
    var specs = []
    if (info.androidRelease)
      specs.push(
        'Android ' + info.androidRelease + (info.apiLevel ? ' (API ' + info.apiLevel + ')' : ''),
      )
    // device nuevo sin ramTotalMb ⇒ null (las barras de RAM degradan a valor
    // absoluto); nunca queda colgada la RAM total del device anterior
    deviceRamMb = info.ramTotalMb || null
    if (deviceRamMb) specs.push((deviceRamMb / 1024).toFixed(1) + ' GB RAM')
    if (info.gpu) specs.push(info.gpu)
    if (info.soc) specs.push(info.soc)
    if (info.cores) {
      deviceCores = info.cores
      specs.push(info.cores + ' cores')
    }
    if (info.refreshHz) specs.push(info.refreshHz + ' Hz')
    specs.push(info.serial)
    var el = $('devSpecs')
    el.innerHTML = ''
    specs.forEach(function (t) {
      var span = document.createElement('span')
      span.className = 'spec' + (/Hz$/.test(t) ? ' hz' : '')
      span.textContent = t
      el.appendChild(span)
    })
    if (pkg) $('appPkg').textContent = pkg
    $('ramAppLbl').textContent = deviceRamMb ? 'app of ' + fmtMb(deviceRamMb) : 'app'
    if (lastSample) renderMem(lastSample)
  }

  // ---------- estado de la app (badge del selector → palabra del hero) ----------
  function setAppRunning(running) {
    appRunning = running
    if (lastSample) renderTiles(lastSample)
  }

  // ---------- reset al cambiar de app/device (selector) ----------
  // Mezclar series de dos apps en la misma timeline sería engañoso: se vacían
  // los buffers, los totales, el veredicto y las marcas de crash.
  function resetSeries() {
    fpsData.length = 0
    gpuData.length = 0
    cpuData.length = 0
    cpuDevData.length = 0
    tickStatus.length = 0
    crashMarks.length = 0
    memTrendData.length = 0
    gcDots = []
    lastPss = null
    netData[0].length = 0
    netData[1].length = 0
    netTotalRx = 0
    netTotalTx = 0
    netEverSeen = false
    crashCount = 0
    lastSample = null
    appRunning = null
    repaintTl()
    repaintMemTrend()
    if (netSpark) netSpark.setOption({ series: [{ data: [] }, { data: [] }] })
    if (memPie)
      memPie.setOption({
        series: [
          {
            data: memMeta().map(function (m) {
              return { name: m.name, value: 0, itemStyle: { color: m.color } }
            }),
          },
        ],
      })
    ;['pssNum', 'rssNum'].forEach(function (id) {
      $(id).textContent = '—'
    })
    $('ramAppBar').style.width = '0%'
    $('ramAppSub').textContent = '—'
    $('ramDevBar').style.width = '0%'
    $('ramDevSub').textContent = '—'
    $('fpsNum').innerHTML = '—<span class="unit">fps</span>'
    setSem($('fpsNum'), null)
    setSem($('fpsStatus'), null)
    $('fpsStatusWord').textContent = 'waiting…'
    $('jankV').textContent = '—'
    setSem($('jankV'), null)
    $('p90V').textContent = '—'
    $('p99V').textContent = '—'
    // tiles de GPU/CPU/Temp/Battery y textos de red: sin esto quedaban los
    // valores de la app/device anterior congelados hasta el próximo sample
    $('gpuNum').innerHTML = '—<span class="unit">%</span>'
    $('gpuBar').style.width = '0%'
    $('gpuSub').textContent = ''
    $('cpuNum').innerHTML = '—<span class="unit">%</span>'
    $('coreSub').textContent = ''
    $('cpuBar').style.width = '0%'
    $('cpuDevBar').style.width = '0%'
    $('cpuDevSub').textContent = '—'
    $('tempNum').innerHTML = '—<span class="unit">°C</span>'
    $('tempBar').style.width = '0%'
    $('tempTrendSub').textContent = ''
    $('batNum').innerHTML = '—<span class="unit">%</span>'
    $('batBar').style.width = '0%'
    $('batSub').textContent = ''
    $('chipCharging').classList.remove('show')
    $('rxNow').textContent = '— KB/s'
    $('txNow').textContent = '— KB/s'
    $('rxTot').textContent = 'total —'
    $('txTot').textContent = 'total —'
    renderVerdict()
  }

  // ---------- connection status ----------
  var startTs = null
  function setConnected(connected) {
    var badge = $('recBadge')
    var label = $('recLabel')
    badge.classList.toggle('offline', !connected)
    label.textContent = connected ? 'LIVE' : 'OFFLINE'
    if (connected && startTs === null) startTs = Date.now()
  }
  setInterval(function () {
    if (startTs === null) return
    var s = Math.floor((Date.now() - startTs) / 1000)
    var m = Math.floor(s / 60),
      ss = s % 60
    $('recTime').textContent = (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss
  }, 1000)

  // ---------- theme (toggle del header + Configuración del ☰; persiste) ----------
  function applyTheme(next) {
    if (next !== 'light' && next !== 'dark') return
    $('themeToggle').textContent = next === 'dark' ? '☀️' : '🌙'
    var cfgTheme = $('cfgTheme')
    if (cfgTheme) cfgTheme.checked = next === 'dark'
    if (next === theme) return
    theme = next
    C = PALETTES[theme]
    document.body.setAttribute('data-theme', theme)
    disposeCharts()
    buildCharts()
    if (lastSample) {
      renderTiles(lastSample)
      renderMem(lastSample)
    }
  }

  function init() {
    $('targetChip').textContent = 'target ' + fpsTarget
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
    setAppRunning: setAppRunning,
    resetSeries: resetSeries,
    setTheme: applyTheme,
    setFpsTarget: setFpsTarget,
    noteCrash: noteCrash,
    noteGc: noteGc,
    getTheme: function () {
      return theme
    },
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
