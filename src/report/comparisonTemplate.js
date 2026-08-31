;(function () {
  'use strict'
  var report = window.ComparisonReportData.report
  var charts = []
  var palette = {
    light: { text: '#1c1c28', muted: '#66667a', line: '#e2e2ec', a: '#eb008b', b: '#009e96' },
    dark: { text: '#f2f2f6', muted: '#9b9bab', line: '#2a2a38', a: '#eb008b', b: '#00e6da' },
  }

  function theme() {
    return document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  }
  function duration(seconds) {
    var minutes = Math.floor(seconds / 60)
    var rest = Math.round(seconds % 60)
    return minutes ? minutes + 'm ' + rest + 's' : rest + 's'
  }
  function number(value, unit) {
    if (value === null || value === undefined || !isFinite(value)) return 'N/A'
    var abs = Math.abs(value)
    var digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
    return value.toFixed(digits) + (unit ? ' ' + unit : '')
  }
  function date(iso) {
    return new Date(iso).toLocaleString(undefined, { hour12: false })
  }
  function node(tag, className, text) {
    var element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  function renderLane(lane, color) {
    var card = node('article', 'lane card')
    card.style.setProperty('--lane', color)
    card.appendChild(node('div', 'lane-tag', lane.label))
    card.appendChild(node('div', 'device', lane.device.name))
    card.appendChild(node('div', 'app', lane.packageName))
    var facts = node('div', 'facts')
    ;[
      lane.platform.toUpperCase() + ' · ' + lane.device.os,
      lane.sampleCount + ' samples',
      lane.samplingHz + ' Hz',
      lane.device.serial,
      lane.trimmed ? 'window trimmed after switch' : null,
    ]
      .filter(Boolean)
      .forEach(function (fact) {
        facts.appendChild(node('span', 'fact', fact))
      })
    card.appendChild(facts)
    return card
  }

  function renderMeta() {
    var lanes = document.getElementById('lanes')
    lanes.appendChild(renderLane(report.primary, 'var(--a)'))
    lanes.appendChild(renderLane(report.secondary, 'var(--b)'))
    document.getElementById('scopeText').textContent =
      date(report.overlap.startedAt) +
      ' → ' +
      date(report.overlap.endedAt) +
      ' (' +
      duration(report.overlap.durationS) +
      '). Timelines share this clock. Metrics are included only when both platforms expose the same measurement definition and both devices produced data. Results are direct observations, not normalized for different workloads or hardware.'
  }

  function renderMetrics() {
    var root = document.getElementById('metrics')
    if (!report.metrics.length) {
      root.appendChild(
        node('div', 'card empty', 'No compatible metrics contain data in this window.'),
      )
      return
    }
    report.metrics.forEach(function (metric) {
      var card = node('article', 'metric card')
      var head = node('div', 'metric-head')
      var title = node('div')
      title.appendChild(node('div', 'metric-name', metric.label))
      title.appendChild(node('div', 'metric-desc', metric.description))
      head.appendChild(title)
      var winner = 'Similar'
      if (metric.winner !== 'tie') {
        winner =
          (metric.winner === 'primary' ? 'A' : 'B') +
          (metric.direction === 'higher' ? ' higher' : ' lower')
      }
      head.appendChild(node('span', 'winner', winner))
      card.appendChild(head)
      var values = node('div', 'values')
      ;[
        { name: 'Device A', data: metric.primary, color: 'var(--a)' },
        { name: 'Device B', data: metric.secondary, color: 'var(--b)' },
      ].forEach(function (lane) {
        var value = node('div', 'value')
        value.style.setProperty('--lane', lane.color)
        value.appendChild(node('div', 'value-label', lane.name))
        value.appendChild(node('div', 'value-number', number(lane.data.value, metric.unit)))
        value.appendChild(
          node(
            'div',
            'value-sub',
            (metric.valueKind === 'final' ? 'final' : 'average') +
              ' · ' +
              Math.round(lane.data.coverage * 100) +
              '% coverage',
          ),
        )
        values.appendChild(value)
      })
      card.appendChild(values)
      var relative =
        metric.deltaPct === null
          ? ''
          : ' · ' +
            (metric.deltaPct * 100 >= 0 ? '+' : '') +
            (metric.deltaPct * 100).toFixed(1) +
            '%'
      card.appendChild(
        node('div', 'delta', 'B − A: ' + number(metric.delta, metric.unit) + relative),
      )
      root.appendChild(card)
    })
  }

  function chartOption(metric) {
    var colors = palette[theme()]
    return {
      animation: false,
      color: [colors.a, colors.b],
      textStyle: { color: colors.text, fontFamily: 'Inter, system-ui, sans-serif' },
      tooltip: {
        trigger: 'axis',
        valueFormatter: function (v) {
          return number(v, metric.unit)
        },
      },
      legend: { top: 2, right: 2, textStyle: { color: colors.muted } },
      grid: { left: 48, right: 18, top: 38, bottom: 42 },
      xAxis: {
        type: 'value',
        name: 'elapsed s',
        nameTextStyle: { color: colors.muted },
        axisLabel: { color: colors.muted },
        axisLine: { lineStyle: { color: colors.line } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: metric.unit,
        nameTextStyle: { color: colors.muted },
        axisLabel: { color: colors.muted },
        splitLine: { lineStyle: { color: colors.line } },
      },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 5 }],
      series: [
        {
          name: 'Device A',
          type: 'line',
          showSymbol: false,
          connectNulls: false,
          data: metric.primary.series.map(function (p) {
            return [p.elapsedS, p.value]
          }),
        },
        {
          name: 'Device B',
          type: 'line',
          showSymbol: false,
          connectNulls: false,
          data: metric.secondary.series.map(function (p) {
            return [p.elapsedS, p.value]
          }),
        },
      ],
    }
  }

  function renderCharts() {
    var root = document.getElementById('charts')
    if (!report.metrics.length) {
      root.appendChild(node('div', 'card empty', 'No shared timelines available.'))
      return
    }
    report.metrics.forEach(function (metric) {
      var card = node('article', 'chart-card card')
      card.appendChild(node('div', 'chart-title', metric.label + ' · ' + metric.description))
      var target = node('div', 'chart')
      card.appendChild(target)
      root.appendChild(card)
      var chart = echarts.init(target)
      charts.push({ chart: chart, metric: metric })
      chart.setOption(chartOption(metric))
    })
  }

  function renderExcluded() {
    var root = document.getElementById('excluded')
    if (!report.excluded.length) {
      root.appendChild(node('div', 'empty', 'No metrics were excluded.'))
      return
    }
    report.excluded.forEach(function (metric) {
      var row = node('div', 'excluded-row')
      var name = node('div', 'excluded-name', metric.label)
      name.appendChild(node('span', 'reason', metric.reason.replace('-', ' ')))
      row.appendChild(name)
      row.appendChild(node('div', 'excluded-detail', metric.detail))
      root.appendChild(row)
    })
  }

  document.getElementById('themeToggle').addEventListener('click', function () {
    document.body.setAttribute('data-theme', theme() === 'dark' ? 'light' : 'dark')
    charts.forEach(function (entry) {
      entry.chart.setOption(chartOption(entry.metric), true)
    })
  })
  window.addEventListener('resize', function () {
    charts.forEach(function (entry) {
      entry.chart.resize()
    })
  })
  renderMeta()
  renderMetrics()
  renderCharts()
  renderExcluded()
})()
