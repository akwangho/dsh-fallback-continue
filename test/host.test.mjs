// dsh-plugin-fallback-continue — host unit tests (node:test).
// Covers the pure exported helpers and the module's public shape.

import test from 'node:test'
import assert from 'node:assert/strict'

import * as pure from '../lib/pure.js'

test('pure module exposes the exported helpers', () => {
  assert.equal(typeof pure.normalizeConfig, 'function')
  assert.equal(typeof pure.intervalFor, 'function')
  assert.equal(typeof pure.DEFAULTS, 'object')
})

test('intervalFor clamps to the last list value', () => {
  const list = [5, 10, 15, 30, 60, 60, 60, 60]
  assert.equal(pure.intervalFor(list, 0), 5 * 60000)
  assert.equal(pure.intervalFor(list, 3), 30 * 60000)
  assert.equal(pure.intervalFor(list, 100), 60 * 60000)
})

test('intervalFor falls back to 60 minutes for invalid/empty input', () => {
  assert.equal(pure.intervalFor([0, -3, 7], 0), 60 * 60000)
  assert.equal(pure.intervalFor([0, -3, 7], 1), 60 * 60000)
  assert.equal(pure.intervalFor([0, -3, 7], 2), 7 * 60000)
  assert.equal(pure.intervalFor([], 5), 60 * 60000)
  assert.equal(pure.intervalFor(null, 0), 60 * 60000)
})

test('normalizeConfig coerces invalid fields to defaults', () => {
  const d = pure.normalizeConfig({})
  assert.equal(d.enabled, false)
  assert.equal(d.continueText, '繼續')
  assert.deepEqual(d.retryIntervalsMinutes, [5, 10, 15, 30, 60, 60, 60, 60])
  assert.equal(d.capEnabled, true)
  assert.equal(d.capHours, 24)

  const bad = pure.normalizeConfig({
    enabled: 'yes',
    continueText: '',
    retryIntervalsMinutes: [-1, 'x', 10],
    capEnabled: 'nope',
    capHours: -5,
  })
  assert.equal(bad.enabled, false)
  assert.equal(bad.continueText, '繼續')
  assert.deepEqual(bad.retryIntervalsMinutes, [10])
  assert.equal(bad.capEnabled, true)
  assert.equal(bad.capHours, 24)
})

test('normalizeConfig preserves valid values', () => {
  const good = pure.normalizeConfig({
    enabled: true,
    continueText: 'go on',
    retryIntervalsMinutes: [1, 2, 3],
    capEnabled: false,
    capHours: 0,
  })
  assert.equal(good.enabled, true)
  assert.equal(good.continueText, 'go on')
  assert.deepEqual(good.retryIntervalsMinutes, [1, 2, 3])
  assert.equal(good.capEnabled, false)
  assert.equal(good.capHours, 0)
})