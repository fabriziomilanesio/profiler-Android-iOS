const { describe, expect, test } = require('bun:test')
const { readFileSync } = require('node:fs')
new Function(readFileSync(new URL('./dualComparison.js', import.meta.url), 'utf8'))()
const { IOS_NOTICE, stateFor } = globalThis.DualComparison

describe('dual comparison UI state', () => {
  test('waits until both devices have reported their platform', () => {
    expect(stateFor({ primary: 'ios', secondary: null })).toEqual({
      ready: false,
      hasIos: false,
      frameTimesComparable: true,
      launchStatusComparable: true,
      notice: '',
    })
  })

  test('keeps frame-time metrics for Android vs Android', () => {
    expect(stateFor({ primary: 'android', secondary: 'android' }).frameTimesComparable).toBe(true)
  })

  test.each([
    ['android', 'ios'],
    ['ios', 'android'],
    ['ios', 'ios'],
  ])('reduces metrics once %s and %s are both selected', (primary, secondary) => {
    const state = stateFor({ primary, secondary })
    expect(state.ready).toBe(true)
    expect(state.hasIos).toBe(true)
    expect(state.frameTimesComparable).toBe(false)
    expect(state.launchStatusComparable).toBe(false)
    expect(state.notice).toBe(IOS_NOTICE)
  })
})
