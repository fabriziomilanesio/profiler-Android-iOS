/**
 * template.js — wiring ECharts del reporte exportado (modo single del ticket 020),
 * adaptado a datos REALES: consume window.ReportData = { session } (contrato de
 * src/core/session/stats.ts). Null-safe: cualquier métrica ausente ⇒ N/A / gap.
 */
;(function () {
  'use strict'

  var PALETTES = {
    light: {
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
      blue: '#1E90D6',
      grey: '#8E8EA6',
      split: 'rgba(28,28,40,.09)',
      legendOff: '#C4C4D2',
    },
    dark: {
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
      blue: '#5AD1FF',
      grey: '#6E6E82',
      split: 'rgba(42,42,56,.55)',
      legendOff: '#44444f',
    },
  }
  var theme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  var C = PALETTES[theme]
  var FONT_TITLE = "'Baloo 2', ui-rounded, system-ui, sans-serif"
  var FONT_BODY = "'Inter', system-ui, sans-serif"

  var SESSION = window.ReportData.session

  // ---------- helpers null-safe ----------
  function nf(v, digits, suffix) {
    if (v === null || v === undefined || !isFinite(v)) return 'N/A'
    return v.toFixed(digits) + (suffix || '')
  }
  function gb(mb) {
    if (mb === null || mb === undefined) return 'N/A'
    return (mb / 1024).toFixed(2)
  }
  // unidad adaptativa: apps chicas viven en MB (118 MB como "0.12 GB" congela el número)
  function fmtMb(mb) {
    if (mb === null || mb === undefined || !isFinite(mb)) return 'N/A'
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB'
  }
  function fmtDuration(s) {
    var m = Math.floor(s / 60),
      ss = s % 60
    return m + 'm ' + (ss < 10 ? '0' : '') + ss + 's'
  }
  function fmtDate(iso) {
    var d = new Date(iso)
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n
    }
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    )
  }

  // ---------- meta ----------
  function renderMeta(sess) {
    var dev = sess.device
    document.getElementById('devName').textContent = dev ? dev.name : 'Sin device'
    var specs = dev
      ? [
          dev.os,
          dev.ramMb ? (dev.ramMb / 1024).toFixed(1) + ' GB RAM' : null,
          dev.gpu,
          dev.soc,
          dev.serial,
        ]
      : []
    document.getElementById('devSpecs').innerHTML = specs
      .filter(Boolean)
      .map(function (s) {
        return '<span class="spec"></span>'
      })
      .join('')
    // textContent por si algún spec trae HTML raro (input del device)
    var specEls = document.getElementById('devSpecs').children
    specs = specs.filter(Boolean)
    for (var i = 0; i < specEls.length; i++) specEls[i].textContent = specs[i]

    document.getElementById('sesApp').textContent = sess.app
    document.getElementById('sesBundle').textContent = sess.bundleId
    var facts = [
      ['Fecha', fmtDate(sess.startedAt)],
      ['Duración', fmtDuration(sess.durationS)],
      ['Sampling', sess.samplingHz + ' Hz'],
      ['Muestras', String(sess.sampleCount)],
    ]
    document.getElementById('sesFacts').innerHTML = facts
      .map(function (f) {
        return '<span class="fact">' + f[0] + ' <b>' + f[1] + '</b></span>'
      })
      .join('')
    if (sess.trimmed) {
      var note = document.getElementById('trimNote')
      note.hidden = false
      note.textContent =
        'Recortado al tramo continuo de ' +
        sess.bundleId +
        ' (hubo cambios de app/device en la ventana)'
    }
  }

  function fmtTime(ts) {
    var d = new Date(ts)
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n
    }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }

  // ---------- veredicto de perf (ticket 026) ----------
  function renderVerdict(sess) {
    var V = sess.verdict || null
    var target = sess.fpsTarget
    document.getElementById('verdictTarget').textContent = 'target: ' + target + ' FPS'

    var light = document.getElementById('verdictLight')
    var title = document.getElementById('verdictTitle')
    var sub = document.getElementById('verdictSubtitle')
    var overall = V ? V.overall : null
    var TITLES = {
      green: 'Performance on target',
      yellow: 'Performance near target',
      red: 'Performance below target',
    }
    light.className = 'verdict-light' + (overall ? ' sem-' + overall : '')
    title.textContent = overall ? TITLES[overall] : 'Insufficient data'
    if (V && V.avgFps !== null) {
      var jank = sess.summary.frame ? sess.summary.frame.jankPct : null
      sub.textContent =
        'avg ' +
        nf(V.avgFps, 1, ' FPS') +
        ' over the exported window' +
        (jank !== null ? ' · session jank ' + nf(jank, 1, '%') : '')
    } else {
      sub.textContent = 'no FPS data in this window — verdict unavailable'
    }

    // % del tiempo en target (ponderado por ticks con dato)
    var bar = document.getElementById('shareBar')
    var legend = document.getElementById('shareLegend')
    var T = V && V.timeInTarget
    if (T) {
      bar.innerHTML =
        '<div class="share-seg-green" style="width:' +
        T.greenPct +
        '%"></div>' +
        '<div class="share-seg-yellow" style="width:' +
        T.yellowPct +
        '%"></div>' +
        '<div class="share-seg-red" style="width:' +
        T.redPct +
        '%"></div>'
      legend.innerHTML =
        'time in target <b class="g">' +
        nf(T.greenPct, 0, '%') +
        '</b> · near <b class="y">' +
        nf(T.yellowPct, 0, '%') +
        '</b> · below <b class="r">' +
        nf(T.redPct, 0, '%') +
        '</b> (' +
        T.ticks +
        ' ticks)'
    } else {
      bar.innerHTML = ''
      legend.textContent = 'no FPS data to split by status'
    }

    // peores tramos (ventana deslizante 30 s, score compuesto FPS+jank)
    var worst = document.getElementById('worstList')
    var wins = (V && V.worstWindows) || []
    if (wins.length) {
      worst.innerHTML = wins
        .map(function (w, i) {
          var facts = [
            'FPS ' + nf(w.avgFps, 1) + ' avg / ' + nf(w.minFps, 1) + ' min',
            w.avgJankPct !== null ? 'jank ' + nf(w.avgJankPct, 1, '%') : null,
            w.avgGpu !== null ? 'GPU ' + nf(w.avgGpu, 0, '%') : null,
            w.avgCpu !== null ? 'CPU ' + nf(w.avgCpu, 0, '%') : null,
            w.avgTempC !== null ? nf(w.avgTempC, 1, ' °C') : null,
          ]
          return (
            '<div class="worst-row">' +
            '<span class="worst-score">#' +
            (i + 1) +
            ' · score ' +
            nf(w.score, 0) +
            '</span>' +
            '<span class="worst-when">' +
            fmtTime(w.startTs) +
            '–' +
            fmtTime(w.endTs) +
            '</span>' +
            '<span class="worst-facts">' +
            facts.filter(Boolean).join(' · ') +
            '</span>' +
            '</div>'
          )
        })
        .join('')
    } else {
      worst.innerHTML =
        '<div class="verdict-empty">' +
        (T
          ? 'No bad stretches — the whole window stayed on target.'
          : 'No FPS data — nothing to rank.') +
        '</div>'
    }

    // throttling térmico (heurística conservadora del core, ya resuelta en los datos)
    var box = document.getElementById('throttleBox')
    var th = V && V.throttling
    if (th && th.detected) {
      var drops = []
      if (th.fpsDropPct !== null && th.baselineFps !== null) {
        drops.push(
          'FPS ' +
            nf(th.baselineFps, 1) +
            ' → ' +
            nf(th.hotFps, 1) +
            ' (−' +
            nf(th.fpsDropPct, 0, '%') +
            ')',
        )
      }
      if (th.gpuDropPct !== null && th.baselineGpu !== null) {
        drops.push(
          'GPU ' +
            nf(th.baselineGpu, 0, '%') +
            ' → ' +
            nf(th.hotGpu, 0, '%') +
            ' (−' +
            nf(th.gpuDropPct, 0, '%') +
            ')',
        )
      }
      box.innerHTML =
        '<span class="throttle-flag bad">Throttling detected</span><br/>' +
        'Sustained high temperature ' +
        fmtTime(th.hotStartTs) +
        '–' +
        fmtTime(th.hotEndTs) +
        ' (peak ' +
        nf(th.peakTempC, 1, ' °C') +
        ') with a correlated drop vs the cool baseline: ' +
        drops.join(' · ')
    } else if (th && th.hotStartTs !== null) {
      box.innerHTML =
        '<span class="throttle-flag ok">Not detected</span><br/>' +
        'Sustained heat ' +
        fmtTime(th.hotStartTs) +
        '–' +
        fmtTime(th.hotEndTs) +
        ' (peak ' +
        nf(th.peakTempC, 1, ' °C') +
        ') but no correlated FPS/GPU drop — not calling it throttling.'
    } else {
      box.innerHTML =
        '<span class="throttle-flag ok">Not detected</span><br/>' +
        (sess.summary.tempC
          ? 'Temperature never stayed high long enough in this window.'
          : 'No temperature data in this window.')
    }
  }

  // ---------- cards ----------
  function metricCardDefs(sess) {
    var S = sess.summary
    var B = S.battery
    var cores = sess.device ? sess.device.cores : null
    return [
      {
        title: '🔋 Battery',
        star: true,
        big: B.drainPct !== null ? '−' + B.drainPct.toFixed(1) : 'N/A',
        unit: B.drainPct !== null ? '%' : '',
        sub:
          B.levelStart !== null
            ? 'drenada · ' +
              nf(B.levelStart, 0) +
              '% → ' +
              nf(B.levelEnd, 0) +
              '% · <span class="hi">' +
              nf(B.tempPeak, 1) +
              '°C</span> peak · ' +
              nf(B.avgMa, 0) +
              ' mA avg'
            : 'sin datos de batería',
      },
      {
        title: 'CPU',
        big: S.cpu ? S.cpu.avg.toFixed(0) : 'N/A',
        unit: S.cpu ? '%' : '',
        sub: S.cpu
          ? '<span class="hi">peak ' +
            nf(S.cpu.peak, 0) +
            '%</span> · min ' +
            nf(S.cpu.min, 0) +
            '% · p90 ' +
            nf(S.cpu.p90, 0) +
            '%' +
            (cores ? ' · avg ≈ ' + Math.round(S.cpu.avg * cores) + '% core' : '')
          : 'sin datos',
      },
      {
        title: 'GPU',
        big: S.gpu ? S.gpu.avg.toFixed(0) : 'N/A',
        unit: S.gpu ? '%' : '',
        sub: S.gpu
          ? '<span class="hi">peak ' +
            nf(S.gpu.peak, 0) +
            '%</span> · min ' +
            nf(S.gpu.min, 0) +
            '% · p90 ' +
            nf(S.gpu.p90, 0) +
            '%'
          : 'sin datos',
      },
      {
        title: 'FPS',
        big: S.fps ? S.fps.avg.toFixed(0) : 'N/A',
        unit: S.fps ? 'fps' : '',
        sub: S.fps
          ? '<span class="lo">min ' +
            nf(S.fps.min, 0) +
            '</span> · peak ' +
            nf(S.fps.peak, 0) +
            ' · p90 ' +
            nf(S.fps.p90, 0)
          : 'sin datos',
      },
      {
        title: 'Temp',
        big: S.tempC ? S.tempC.avg.toFixed(1) : 'N/A',
        unit: S.tempC ? '°C' : '',
        sub: S.tempC
          ? '<span class="hi">peak ' +
            nf(S.tempC.peak, 1) +
            '°C</span> · min ' +
            nf(S.tempC.min, 1) +
            '°C'
          : 'sin datos',
      },
      {
        title: 'RAM (PSS)',
        big: S.ramMb ? (S.ramMb.avg >= 1024 ? gb(S.ramMb.avg) : Math.round(S.ramMb.avg)) : 'N/A',
        unit: S.ramMb ? (S.ramMb.avg >= 1024 ? 'GB' : 'MB') : '',
        sub: S.ramMb
          ? '<span class="hi">peak ' + fmtMb(S.ramMb.peak) + '</span> · min ' + fmtMb(S.ramMb.min)
          : 'sin datos',
      },
      {
        title: '📱 Device',
        big: S.deviceCpu ? S.deviceCpu.avg.toFixed(0) : 'N/A',
        unit: S.deviceCpu ? '% CPU' : '',
        sub:
          S.deviceCpu || S.deviceRamMb
            ? (S.deviceCpu ? '<span class="hi">peak ' + nf(S.deviceCpu.peak, 0) + '%</span>' : '') +
              (S.deviceRamMb
                ? (S.deviceCpu ? ' · ' : '') +
                  'RAM ' +
                  fmtMb(S.deviceRamMb.avg) +
                  (sess.device && sess.device.ramMb ? ' / ' + fmtMb(sess.device.ramMb) : '')
                : '')
            : 'uso total del teléfono (sin datos)',
      },
    ]
  }

  function renderCards(sess) {
    document.getElementById('metricCards').innerHTML = metricCardDefs(sess)
      .map(function (d) {
        return (
          '<div class="card metric-card' +
          (d.star ? ' star' : '') +
          '">' +
          '<div class="card-title">' +
          d.title +
          '</div>' +
          '<div class="metric-big">' +
          d.big +
          '<span class="unit">' +
          d.unit +
          '</span></div>' +
          '<div class="metric-sub">' +
          d.sub +
          '</div>' +
          '</div>'
        )
      })
      .join('')
  }

  // ---------- memory pie ----------
  var memPie, timeline, corr

  function memMeta() {
    return [
      { key: 'java', name: 'Java heap', color: C.primary },
      { key: 'native', name: 'Native', color: C.secondary },
      { key: 'graphics', name: 'Graphics', color: C.violet },
      { key: 'code', name: 'Code', color: C.amber },
      { key: 'stack', name: 'Stack', color: C.blue },
      { key: 'other', name: 'Other', color: C.grey },
    ]
  }

  function makeMemPie(sess) {
    var chart = echarts.init(document.getElementById('memPie'))
    var mem = sess.summary.memAvg
    chart.setOption({
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
        text: sess.summary.ramMb ? fmtMb(sess.summary.ramMb.avg) : 'N/A',
        left: 'center',
        top: '40%',
        textStyle: { color: C.text, fontFamily: FONT_TITLE, fontWeight: 800, fontSize: 22 },
        subtext: 'avg PSS',
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
            return { name: m.name, value: mem[m.key] || 0, itemStyle: { color: m.color } }
          }),
        },
      ],
    })
    return chart
  }

  // ---------- correlación FPS ↔ GPU/CPU/temp (ticket 026) ----------
  // Dos grids con x + dataZoom compartidos: arriba FPS (eje izq) + frame-time p90
  // (eje der, ms); abajo GPU%/CPU% (eje izq 0-100) + temp (eje der °C). Los tramos
  // rojos (FPS bajo target, precalculados en verdict.redSpans) se sombrean en ambos.
  function makeCorrelation(sess) {
    var chart = echarts.init(document.getElementById('corrChart'))
    var V = sess.verdict || {}
    var target = sess.fpsTarget
    var pts = sess.series

    function dataOf(get) {
      return pts.map(function (s) {
        return [s.ts, get(s)]
      })
    }
    var maxFps = 0
    pts.forEach(function (s) {
      if (s.fps !== null && s.fps > maxFps) maxFps = s.fps
    })
    var fpsAxisMax = Math.ceil(Math.max(target * 1.2, maxFps * 1.05, 1) / 5) * 5

    var redFill = theme === 'dark' ? 'rgba(255,77,109,0.14)' : 'rgba(225,29,72,0.09)'
    // ± medio tick REAL para que un tramo de un solo tick tenga ancho visible.
    // El intervalo sale del samplingHz embebido en la sesión (gama baja samplea
    // a 0.5 Hz ⇒ tick de 2 s ⇒ ±1000 ms); 500 ms hardcodeado asumía tick de 1 s.
    var halfTickMs =
      sess.samplingHz && isFinite(sess.samplingHz) && sess.samplingHz > 0
        ? 500 / sess.samplingHz
        : 500
    var redAreas = (V.redSpans || []).map(function (sp) {
      return [{ xAxis: sp.startTs - halfTickMs }, { xAxis: sp.endTs + halfTickMs }]
    })
    function markRed(extra) {
      var m = { silent: true, itemStyle: { color: redFill }, data: redAreas }
      if (extra) for (var k in extra) m[k] = extra[k]
      return m
    }

    var fpsSeries = {
      name: 'FPS',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      smooth: 0.15,
      connectNulls: false,
      lineStyle: { width: 2.2, color: C.secondary },
      itemStyle: { color: C.secondary },
      emphasis: { disabled: true },
      data: dataOf(function (s) {
        return s.fps
      }),
      markLine: {
        silent: true,
        symbol: 'none',
        animation: false,
        lineStyle: { color: C.muted, type: 'dashed', width: 1 },
        label: {
          formatter: 'target ' + target,
          position: 'insideEndTop',
          color: C.muted,
          fontFamily: FONT_BODY,
          fontSize: 10,
        },
        data: [{ yAxis: Math.min(target, fpsAxisMax) }],
      },
      markArea: markRed(),
    }

    // HOOK (ticket 030): marcas puntuales de crashes/errores sobre el timeline.
    // Contrato: session.marks = [{ ts, label }] embebido en ReportData ⇒ acá se
    // pintan como líneas verticales en el grid de FPS, sin tocar el resto del chart.
    if (sess.marks && sess.marks.length) {
      fpsSeries.markLine.data = fpsSeries.markLine.data.concat(
        sess.marks.map(function (m) {
          return {
            xAxis: m.ts,
            lineStyle: { color: C.bad, type: 'solid', width: 1.5 },
            label: { formatter: m.label || '⚠', color: C.bad, fontSize: 10 },
          }
        }),
      )
    }

    function corrLine(name, xi, yi, color, get, dashed) {
      return {
        name: name,
        type: 'line',
        xAxisIndex: xi,
        yAxisIndex: yi,
        showSymbol: false,
        smooth: 0.15,
        connectNulls: false,
        lineStyle: { width: 1.8, color: color, type: dashed ? 'dashed' : 'solid' },
        itemStyle: { color: color },
        emphasis: { disabled: true },
        data: dataOf(get),
        markArea: xi === 1 ? markRed() : undefined,
      }
    }

    var UNITS = { FPS: ' fps', 'Frame p90': ' ms', 'GPU %': '%', 'CPU %': '%', Temp: ' °C' }
    var axisCommon = {
      type: 'time',
      axisLine: { lineStyle: { color: C.line } },
      splitLine: { show: false },
    }

    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: C.line } },
      legend: {
        top: 0,
        left: 4,
        icon: 'roundRect',
        itemWidth: 14,
        itemHeight: 5,
        textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 12 },
        inactiveColor: C.legendOff,
        data: ['FPS', 'Frame p90', 'GPU %', 'CPU %', 'Temp'],
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: C.card2,
        borderColor: C.line,
        textStyle: { color: C.text, fontFamily: FONT_BODY, fontSize: 12 },
        formatter: function (params) {
          if (!params.length) return ''
          var lines = [echarts.time.format(params[0].value[0], '{HH}:{mm}:{ss}', false)]
          params.forEach(function (p) {
            var v = p.value[1]
            lines.push(
              p.marker +
                ' ' +
                p.seriesName +
                ': <b>' +
                (v === null || v === undefined ? 'N/A' : nf(v, 1, UNITS[p.seriesName] || '')) +
                '</b>',
            )
          })
          return lines.join('<br/>')
        },
      },
      grid: [
        { left: 52, right: 52, top: 32, height: 180 },
        { left: 52, right: 52, top: 252, height: 130 },
      ],
      xAxis: [
        Object.assign(
          { gridIndex: 0, axisLabel: { show: false }, axisTick: { show: false } },
          axisCommon,
        ),
        Object.assign(
          {
            gridIndex: 1,
            axisLabel: {
              color: C.muted,
              fontFamily: FONT_BODY,
              fontSize: 10,
              formatter: '{HH}:{mm}:{ss}',
            },
          },
          axisCommon,
        ),
      ],
      yAxis: [
        {
          gridIndex: 0,
          type: 'value',
          min: 0,
          max: fpsAxisMax,
          name: 'FPS',
          nameTextStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          splitLine: { lineStyle: { color: C.split } },
        },
        {
          gridIndex: 0,
          type: 'value',
          min: 0,
          name: 'ms',
          position: 'right',
          nameTextStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          splitLine: { show: false },
        },
        {
          gridIndex: 1,
          type: 'value',
          min: 0,
          max: 100,
          name: '%',
          nameTextStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          splitLine: { lineStyle: { color: C.split } },
        },
        {
          gridIndex: 1,
          type: 'value',
          name: '°C',
          position: 'right',
          nameTextStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1] },
        {
          type: 'slider',
          xAxisIndex: [0, 1],
          bottom: 6,
          height: 16,
          borderColor: C.line,
          handleStyle: { color: C.card2, borderColor: C.muted },
          moveHandleStyle: { color: C.muted },
          fillerColor: theme === 'dark' ? 'rgba(0,230,218,0.10)' : 'rgba(0,158,150,0.08)',
          dataBackground: {
            lineStyle: { color: C.line },
            areaStyle: { color: C.split },
          },
          textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
        },
      ],
      series: [
        fpsSeries,
        corrLine(
          'Frame p90',
          0,
          1,
          C.violet,
          function (s) {
            return s.frameP90Ms
          },
          true,
        ),
        corrLine('GPU %', 1, 2, C.primary, function (s) {
          return s.gpu
        }),
        corrLine('CPU %', 1, 2, C.blue, function (s) {
          return s.cpu
        }),
        corrLine('Temp', 1, 3, C.amber, function (s) {
          return s.tempC
        }),
      ],
    })
    return chart
  }

  // ---------- timeline (normalizado 0-100, tooltip con valor real) ----------
  function tlMeta(sess) {
    var ramTotal = sess.device && sess.device.ramMb ? sess.device.ramMb : 4096
    // Auto-escala de la RAM de la app: normalizada a su propio rango de la sesión
    // (en % del device una app de 118 MB era una línea plana pegada al piso).
    var lo = Infinity
    var hi = -Infinity
    sess.series.forEach(function (s) {
      if (s.ramMb !== null && s.ramMb !== undefined) {
        if (s.ramMb < lo) lo = s.ramMb
        if (s.ramMb > hi) hi = s.ramMb
      }
    })
    var ramFloor = 0
    var ramSpan = ramTotal
    if (hi >= lo) {
      var pad = Math.max((hi - lo) * 0.15, hi * 0.02, 1)
      ramFloor = Math.max(0, lo - pad)
      ramSpan = hi + pad - ramFloor
    }
    return [
      {
        name: 'CPU %',
        color: C.primary,
        norm: function (s) {
          return s.cpu
        },
        real: function (s) {
          return nf(s.cpu, 0, ' %')
        },
      },
      {
        name: 'RAM',
        color: C.violet,
        norm: function (s) {
          return s.ramMb === null ? null : ((s.ramMb - ramFloor) / ramSpan) * 100
        },
        real: function (s) {
          return s.ramMb === null ? 'N/A' : fmtMb(s.ramMb)
        },
      },
      {
        name: 'FPS',
        color: C.secondary,
        norm: function (s) {
          return s.fps === null ? null : (s.fps / 60) * 100
        },
        real: function (s) {
          return nf(s.fps, 0, ' fps')
        },
      },
      {
        name: 'Temp',
        color: C.amber,
        norm: function (s) {
          return s.tempC === null ? null : ((s.tempC - 25) / 25) * 100
        },
        real: function (s) {
          return nf(s.tempC, 1, ' °C')
        },
      },
      {
        name: 'Battery',
        color: C.ok,
        norm: function (s) {
          return s.battery.level
        },
        real: function (s) {
          return nf(s.battery.level, 1, ' %')
        },
      },
      // Totales del DEVICE (punteados): misma escala 0-100 = % de la capacidad
      {
        name: 'CPU dev',
        color: C.primary,
        dim: true,
        norm: function (s) {
          return s.deviceCpu === null || s.deviceCpu === undefined ? null : s.deviceCpu
        },
        real: function (s) {
          return nf(s.deviceCpu, 0, ' %')
        },
      },
      {
        name: 'RAM dev',
        color: C.violet,
        dim: true,
        norm: function (s) {
          return s.deviceRamMb === null || s.deviceRamMb === undefined
            ? null
            : (s.deviceRamMb / ramTotal) * 100
        },
        real: function (s) {
          return s.deviceRamMb === null || s.deviceRamMb === undefined
            ? 'N/A'
            : fmtMb(s.deviceRamMb)
        },
      },
    ]
  }

  function makeTimeline(sess) {
    var chart = echarts.init(document.getElementById('timeline'))
    var M = tlMeta(sess)
    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 44, right: 16, top: 40, bottom: 30 },
      legend: {
        top: 2,
        left: 4,
        icon: 'roundRect',
        itemWidth: 14,
        itemHeight: 5,
        textStyle: { color: C.muted, fontFamily: FONT_BODY, fontSize: 12 },
        inactiveColor: C.legendOff,
        data: M.map(function (m) {
          return m.name
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
        axisLabel: {
          color: C.muted,
          fontFamily: FONT_BODY,
          fontSize: 10,
          formatter: '{HH}:{mm}:{ss}',
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { color: C.muted, fontFamily: FONT_BODY, fontSize: 10 },
        splitLine: { lineStyle: { color: C.split } },
      },
      series: M.map(function (m) {
        return {
          name: m.name,
          type: 'line',
          showSymbol: false,
          smooth: 0.2,
          connectNulls: false,
          lineStyle: {
            width: m.dim ? 1.5 : 2,
            color: m.color,
            type: m.dim ? 'dashed' : 'solid',
            opacity: m.dim ? 0.45 : 1,
          },
          itemStyle: { color: m.color, opacity: m.dim ? 0.45 : 1 },
          emphasis: { disabled: true },
          data: sess.series.map(function (s) {
            return { value: [s.ts, m.norm(s), m.real(s)] }
          }),
        }
      }),
    })
    return chart
  }

  function buildAll() {
    memPie = makeMemPie(SESSION)
    timeline = makeTimeline(SESSION)
    corr = makeCorrelation(SESSION)
  }
  function disposeAll() {
    if (memPie) memPie.dispose()
    if (timeline) timeline.dispose()
    if (corr) corr.dispose()
    memPie = timeline = corr = null
  }

  // ---------- theme toggle (local al reporte) ----------
  function syncThemeButton() {
    document.getElementById('themeIcon').textContent = theme === 'light' ? '🌙' : '☀️'
    document.getElementById('themeLabel').textContent = theme === 'light' ? 'Dark' : 'Light'
  }
  document.getElementById('themeToggle').addEventListener('click', function () {
    theme = theme === 'light' ? 'dark' : 'light'
    C = PALETTES[theme]
    document.body.setAttribute('data-theme', theme)
    syncThemeButton()
    disposeAll()
    buildAll()
  })

  // ---------- first paint ----------
  renderMeta(SESSION)
  renderVerdict(SESSION)
  renderCards(SESSION)
  buildAll()
  syncThemeButton()
  window.addEventListener('resize', function () {
    if (memPie) memPie.resize()
    if (timeline) timeline.resize()
    if (corr) corr.resize()
  })
})()
