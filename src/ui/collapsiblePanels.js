/**
 * Makes the dashboard metric panels collapsible while keeping them expanded
 * on first load. The script transforms their existing headings into buttons,
 * so a panel's title remains visible when its content is collapsed.
 */
;(function () {
  'use strict'

  var panels = [
    { panel: '.fps-tile', heading: '.tile-label', label: 'FPS' },
    { panel: '.gpu-tile', heading: '.tile-label', label: 'GPU' },
    { panel: '.tl-card', heading: '.panel-head', label: 'Live timeline' },
    { panel: '.mem-card', heading: '.panel-head', label: 'Memory' },
    { panel: '.sys-card', heading: '.panel-head', label: 'System' },
    { panel: '.net', heading: '.panel-head', label: 'Network', extras: ['#inspector'] },
  ]

  function makeCollapsible(definition, index) {
    var panel = document.querySelector(definition.panel)
    if (!panel) return
    var heading = panel.querySelector(':scope > ' + definition.heading)
    if (!heading) return

    var content = document.createElement('div')
    content.className = 'collapsible-content'
    content.id = 'collapsible-panel-' + index
    while (heading.nextSibling) content.appendChild(heading.nextSibling)

    var toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'collapse-toggle ' + heading.className
    toggle.setAttribute('aria-expanded', 'true')
    toggle.setAttribute('aria-controls', content.id)
    toggle.title = 'Collapse ' + definition.label
    while (heading.firstChild) toggle.appendChild(heading.firstChild)

    var caret = document.createElement('span')
    caret.className = 'caret'
    caret.setAttribute('aria-hidden', 'true')
    caret.textContent = '▲'
    toggle.appendChild(caret)

    toggle.addEventListener('click', function () {
      var expanded = toggle.getAttribute('aria-expanded') === 'true'
      content.hidden = expanded
      toggle.setAttribute('aria-expanded', String(!expanded))
      toggle.title = (expanded ? 'Expand ' : 'Collapse ') + definition.label
      caret.textContent = expanded ? '▼' : '▲'
      window.dispatchEvent(new Event('resize'))
    })

    panel.replaceChild(toggle, heading)
    panel.appendChild(content)
    ;(definition.extras || []).forEach(function (selector) {
      var extra = document.querySelector(selector)
      if (extra) content.appendChild(extra)
    })
  }

  panels.forEach(makeCollapsible)
})()
