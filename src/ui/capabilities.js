/**
 * Aplica las capacidades del device al DOM (ticket 040).
 *
 * Regla, decidida con el usuario el 2026-08-10:
 *   - Lo que NO EXISTE en la plataforma se **oculta**. Es permanente; un tile que nunca
 *     se va a llenar sólo genera la pregunta "¿está roto?".
 *   - Lo que existe pero falló en este tick se muestra en **N/A**. Es transitorio y es
 *     información: la métrica existe y ahora mismo no se pudo leer. De eso ya se encarga
 *     la convención de `null` por campo que el schema tiene desde el ticket 021.
 *
 * El marcado declara su dependencia con `data-cap="<capability>"`; acá sólo se togglea.
 * Así agregar un tile nuevo no obliga a tocar este archivo.
 *
 * UMD como logsCore.js: el browser lo carga por <script> y bun:test lo importa.
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.Capabilities = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Muestra u oculta cada `[data-cap]` según las capacidades recibidas.
   *
   * Sin capacidades (server viejo, o el mensaje todavía no llegó) NO se esconde nada: el
   * comportamiento por defecto es el de siempre, que es el de Android.
   */
  function apply(rootEl, capabilities) {
    if (!rootEl || !rootEl.querySelectorAll) return 0
    var nodes = rootEl.querySelectorAll('[data-cap]')
    var hidden = 0
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var key = el.getAttribute('data-cap')
      var supported = !capabilities || capabilities[key] !== false
      el.hidden = !supported
      if (!supported) hidden++
    }
    return hidden
  }

  /**
   * Etiqueta del total de memoria según la plataforma.
   *
   * No es cosmética: en Android el número es PSS (prorratea memoria compartida) y en iOS
   * es physFootprint (no prorratea, incluye páginas comprimidas). Mostrar "PSS" sobre un
   * footprint sería exactamente el bug silencioso que el schema evita separando los
   * campos — la UI no puede volver a juntarlos con una etiqueta equivocada.
   */
  function memoryLabel(platform) {
    return platform === 'ios' ? 'Footprint' : 'PSS'
  }

  /** Etiqueta de la versión del SO: el campo del schema es uno solo para las dos. */
  function osLabel(platform) {
    return platform === 'ios' ? 'iOS' : 'Android'
  }

  /**
   * Nombre comercial de un ProductType de Apple ("iPhone15,3" → "iPhone 14 Pro Max").
   *
   * Apple no expone el nombre comercial por ningún servicio: sólo el identificador
   * interno. La tabla es chica y envejece con cada modelo nuevo — por eso el fallback
   * devuelve el identificador CRUDO en vez de inventar algo. Un id que el usuario puede
   * googlear es mejor que un nombre equivocado.
   *
   * En Android este problema no existe: `ro.product.model` ya es legible (SM-A155M).
   */
  var APPLE_MODELS = {
    'iPhone14,6': 'iPhone SE (3ra gen)',
    'iPhone14,7': 'iPhone 14',
    'iPhone14,8': 'iPhone 14 Plus',
    'iPhone15,2': 'iPhone 14 Pro',
    'iPhone15,3': 'iPhone 14 Pro Max',
    'iPhone15,4': 'iPhone 15',
    'iPhone15,5': 'iPhone 15 Plus',
    'iPhone16,1': 'iPhone 15 Pro',
    'iPhone16,2': 'iPhone 15 Pro Max',
    'iPhone17,1': 'iPhone 16 Pro',
    'iPhone17,2': 'iPhone 16 Pro Max',
    'iPhone17,3': 'iPhone 16',
    'iPhone17,4': 'iPhone 16 Plus',
    'iPhone17,5': 'iPhone 16e',
    'iPad13,4': 'iPad Pro 11 (3ra gen)',
    'iPad14,3': 'iPad Pro 11 (4ta gen)',
    'iPad16,3': 'iPad Pro 11 (M4)',
  }

  function modelName(productType) {
    if (!productType) return productType
    return APPLE_MODELS[productType] || productType
  }

  return {
    apply: apply,
    memoryLabel: memoryLabel,
    osLabel: osLabel,
    modelName: modelName,
  }
})
