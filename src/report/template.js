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

  // ---------- cards ----------
  function metricCardDefs(sess) {
    var S = sess.summary
    var B = S.battery
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
            '%'
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
        big: S.ramMb ? gb(S.ramMb.avg) : 'N/A',
        unit: S.ramMb ? 'GB' : '',
        sub: S.ramMb
          ? '<span class="hi">peak ' +
            gb(S.ramMb.peak) +
            ' GB</span> · min ' +
            gb(S.ramMb.min) +
            ' GB'
          : 'sin datos',
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
  var memPie, timeline

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
        text: sess.summary.ramMb ? gb(sess.summary.ramMb.avg) + ' GB' : 'N/A',
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

  // ---------- timeline (normalizado 0-100, tooltip con valor real) ----------
  function tlMeta(sess) {
    var ramTotal = sess.device && sess.device.ramMb ? sess.device.ramMb : 4096
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
          return s.ramMb === null ? null : (s.ramMb / ramTotal) * 100
        },
        real: function (s) {
          return s.ramMb === null ? 'N/A' : gb(s.ramMb) + ' GB'
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
          lineStyle: { width: 2, color: m.color },
          itemStyle: { color: m.color },
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
  }
  function disposeAll() {
    if (memPie) memPie.dispose()
    if (timeline) timeline.dispose()
    memPie = timeline = null
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
  renderCards(SESSION)
  buildAll()
  syncThemeButton()
  window.addEventListener('resize', function () {
    if (memPie) memPie.resize()
    if (timeline) timeline.resize()
  })
})()
