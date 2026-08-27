/**
 * Estado puro de la comparación dual. UMD para compartir exactamente las mismas reglas
 * entre el browser (live.js) y bun:test sin introducir un build step en la UI.
 */
var DualComparison = (function () {
  var IOS_NOTICE =
    'iOS provides fewer metrics. Frame-time jank, p90, p99, Network Data and Data Inspector are unavailable and hidden for this comparison.'

  function normalizePlatform(platform) {
    return platform === 'ios' ? 'ios' : platform === 'android' ? 'android' : null
  }

  /** El aviso y la reducción sólo se activan después de conocer AMBOS devices. */
  function stateFor(platforms) {
    var primary = normalizePlatform(platforms && platforms.primary)
    var secondary = normalizePlatform(platforms && platforms.secondary)
    var ready = primary !== null && secondary !== null
    var hasIos = ready && (primary === 'ios' || secondary === 'ios')
    return {
      ready: ready,
      hasIos: hasIos,
      frameTimesComparable: !hasIos,
      launchStatusComparable: !hasIos,
      notice: hasIos ? IOS_NOTICE : '',
    }
  }

  return { IOS_NOTICE: IOS_NOTICE, stateFor: stateFor }
})()

if (typeof module === 'object' && module.exports) module.exports = DualComparison
