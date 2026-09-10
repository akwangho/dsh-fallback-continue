// dsh-plugin-fallback-continue — host unit tests (node:test).
// Covers the dependency-free helpers in pure.js: config normalization, retry
// interval math, the time cap predicate, countdown remainder, error-text
// derivation, stop-reason classification, and the cap-stop session notice.

import test from 'node:test'
import assert from 'node:assert/strict'

import * as pure from '../lib/pure.js'

// ---------------------------------------------------------------- module shape

test('pure module exposes every exported helper', () => {
  for (const k of ['normalizeConfig', 'intervalFor', 'overCap', 'remainingMs', 'errorTextOf', 'classifyStop', 'capStopText', 'isRateLimited', 'rateLimitedText']) {
    assert.equal(typeof pure[k], 'function', `missing ${k}`)
  }
  assert.equal(typeof pure.DEFAULTS, 'object')
})

// ---------------------------------------------------------------- intervalFor

test('intervalFor maps a consecutive-failure index to the configured delay', () => {
  const list = [5, 10, 15, 30, 60, 60, 60, 60]
  assert.equal(pure.intervalFor(list, 0), 5 * 60000)
  assert.equal(pure.intervalFor(list, 1), 10 * 60000)
  assert.equal(pure.intervalFor(list, 3), 30 * 60000)
  assert.equal(pure.intervalFor(list, 7), 60 * 60000)
})

test('intervalFor clamps past-the-end indexes to the last value', () => {
  const list = [5, 10, 15]
  assert.equal(pure.intervalFor(list, 100), 15 * 60000)
  assert.equal(pure.intervalFor(list, Infinity), 15 * 60000)
})

test('intervalFor treats negative indexes as the first slot', () => {
  const list = [5, 10, 15]
  assert.equal(pure.intervalFor(list, -1), 5 * 60000)
  assert.equal(pure.intervalFor(list, -100), 5 * 60000)
})

test('intervalFor coerces fractional/string/non-numeric indexes safely', () => {
  const list = [5, 10, 15, 30]
  // Fractional index previously indexed list[0.5] === undefined -> 60m fallback.
  assert.equal(pure.intervalFor(list, 2.9), 15 * 60000)
  assert.equal(pure.intervalFor(list, '2'), 15 * 60000)
  // NaN index clamps to the first slot rather than the 60m fallback.
  assert.equal(pure.intervalFor(list, NaN), 5 * 60000)
})

test('intervalFor falls back to 60 minutes for invalid entries / empty input', () => {
  assert.equal(pure.intervalFor([0, -3, 7], 0), 60 * 60000)
  assert.equal(pure.intervalFor([0, -3, 7], 1), 60 * 60000)
  assert.equal(pure.intervalFor([0, -3, 7], 2), 7 * 60000)
  assert.equal(pure.intervalFor([], 5), 60 * 60000)
  assert.equal(pure.intervalFor(null, 0), 60 * 60000)
  assert.equal(pure.intervalFor('not-an-array', 0), 60 * 60000)
})

test('intervalFor handles fractional-minute values with rounding', () => {
  // normalizeConfig admits fractional minutes; the delay must round to ms.
  assert.equal(pure.intervalFor([0.5], 0), Math.round(0.5 * 60000))
})

// ---------------------------------------------------------------- normalizeConfig

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

test('normalizeConfig drops invalid interval entries and defaults when none survive', () => {
  assert.deepEqual(pure.normalizeConfig({ retryIntervalsMinutes: [-1, 0, 'x'] }).retryIntervalsMinutes, [5, 10, 15, 30, 60, 60, 60, 60])
  assert.deepEqual(pure.normalizeConfig({ retryIntervalsMinutes: [2, 'x', 9] }).retryIntervalsMinutes, [2, 9])
  // null input still normalizes.
  assert.equal(pure.normalizeConfig(null).continueText, '繼續')
  assert.equal(pure.normalizeConfig(undefined).enabled, false)
})

test('normalizeConfig is not affected by mutating its defaults afterward', () => {
  const a = pure.normalizeConfig({ retryIntervalsMinutes: [1, 2] })
  a.retryIntervalsMinutes.push(99)
  const b = pure.normalizeConfig({})
  assert.deepEqual(b.retryIntervalsMinutes, [5, 10, 15, 30, 60, 60, 60, 60])
})

// ---------------------------------------------------------------- overCap

test('overCap respects enabled/hours gating', () => {
  const t = 1_000_000
  // cap disabled -> never over
  assert.equal(pure.overCap(0, false, 24, t), false)
  // capHours <= 0 or non-numeric -> treated as no cap
  assert.equal(pure.overCap(0, true, 0, t), false)
  assert.equal(pure.overCap(0, true, -5, t), false)
  assert.equal(pure.overCap(0, true, NaN, t), false)
})

test('overCap computes elapsed time against the cap', () => {
  // below cap
  assert.equal(pure.overCap(0, true, 24, 23 * 3600000), false)
  // exactly at cap
  assert.equal(pure.overCap(0, true, 24, 24 * 3600000), true)
  // well past cap
  assert.equal(pure.overCap(0, true, 24, 25 * 3600000), true)
  // non-zero failedAt offset
  assert.equal(pure.overCap(10 * 3600000, true, 24, 34 * 3600000), true)
  assert.equal(pure.overCap(10 * 3600000, true, 24, 33.9 * 3600000), false)
})

// ---------------------------------------------------------------- remainingMs

test('remainingMs is null while awaiting', () => {
  assert.equal(pure.remainingMs({ phase: 'awaiting', remainingMs: 5000, startedAt: 0 }, 0), null)
})

test('remainingMs freezes the paused remainder', () => {
  assert.equal(pure.remainingMs({ phase: 'counting', paused: true, pausedRemainingMs: 123, remainingMs: 999 }, 1000), 123)
  // paused without a captured remainder falls back to the whole delay
  assert.equal(pure.remainingMs({ phase: 'counting', paused: true, pausedRemainingMs: null, remainingMs: 999 }, 1000), 999)
})

test('remainingMs returns the full delay before the timer starts', () => {
  assert.equal(pure.remainingMs({ phase: 'counting', paused: false, remainingMs: 60000, startedAt: null }, 5000), 60000)
})

test('remainingMs counts down and floors at zero', () => {
  const at = 10_000
  assert.equal(pure.remainingMs({ phase: 'counting', paused: false, remainingMs: 60000, startedAt: 5000 }, at), 55000)
  assert.equal(pure.remainingMs({ phase: 'counting', paused: false, remainingMs: 60000, startedAt: at }, at), 60000)
  assert.equal(pure.remainingMs({ phase: 'counting', paused: false, remainingMs: 60000, startedAt: 0 }, 70_000), 0)
})

test('remainingMs is null for a missing total and for null entry', () => {
  assert.equal(pure.remainingMs(null, 0), null)
  assert.equal(pure.remainingMs({ phase: 'counting', paused: false, remainingMs: null, startedAt: 100 }, 1000), null)
})

// ---------------------------------------------------------------- errorTextOf

test('errorTextOf derives a readable reason from assorted shapes', () => {
  assert.equal(pure.errorTextOf(null), 'error')
  assert.equal(pure.errorTextOf(undefined), 'error')
  assert.equal(pure.errorTextOf('boom'), 'boom')
  assert.equal(pure.errorTextOf({ message: 'Boom' }), 'Boom')
  assert.equal(pure.errorTextOf(new Error('E')), 'E')
  assert.equal(pure.errorTextOf({ code: 'ECONN' }), 'ECONN')
  assert.equal(pure.errorTextOf({}), 'error')
})

// ---------------------------------------------------------------- classifyStop

test('classifyStop maps stop-reason kinds to actions', () => {
  assert.equal(pure.classifyStop('error'), 'failure')
  assert.equal(pure.classifyStop('max-tokens'), 'failure')
  assert.equal(pure.classifyStop('completed'), 'reset')
  assert.equal(pure.classifyStop('cancelled'), 'ignore')
  assert.equal(pure.classifyStop(undefined), 'ignore')
  assert.equal(pure.classifyStop('anything-else'), 'ignore')
})

// ---------------------------------------------------------------- capStopText

test('capStopText embeds the configured hour cap', () => {
  const t = pure.capStopText(48)
  assert.match(t, /48/)
  assert.match(t, /自動繼續已停止/)
  assert.match(t, /此會話將不再自動送出/)
})

test('capStopText falls back to 24 for invalid/zero/negative hours', () => {
  assert.match(pure.capStopText(0), /24/)
  assert.match(pure.capStopText(-1), /24/)
  assert.match(pure.capStopText(NaN), /24/)
  assert.match(pure.capStopText('x'), /24/)
  assert.match(pure.capStopText(undefined), /24/)
})

test('capStopText keeps fractional hours as written', () => {
  assert.match(pure.capStopText(0.5), /0\.5/)
})

// ---------------------------------------------------------------- isRateLimited

test('isRateLimited detects a live RATE_LIMIT error', () => {
  assert.equal(pure.isRateLimited({ code: 'RATE_LIMIT' }), true)
  assert.equal(pure.isRateLimited({ code: 'RATE_LIMIT', status: 429, failure: { code: 'RATE_LIMIT', status: 429 } }), true)
})

test('isRateLimited detects the retained HTTP status', () => {
  assert.equal(pure.isRateLimited({ status: 429 }), true)
  assert.equal(pure.isRateLimited({ code: 'SERVER', status: 500 }), false)
})

test('isRateLimited detects the serialized failure facts object', () => {
  assert.equal(pure.isRateLimited({ failure: { code: 'RATE_LIMIT', status: 429, message: 'x' } }), true)
  assert.equal(pure.isRateLimited({ failure: { status: 429 } }), true)
  assert.equal(pure.isRateLimited({ failure: { code: 'SERVER', status: 500 } }), false)
})

test('isRateLimited falls back to message/string matching', () => {
  assert.equal(pure.isRateLimited('DeepSeek API error (HTTP 429)'), true)
  assert.equal(pure.isRateLimited('rate limit exceeded'), true)
  assert.equal(pure.isRateLimited('too many requests'), true)
  assert.equal(pure.isRateLimited({ message: 'DeepSeek API error (HTTP 429) too many requests' }), true)
  assert.equal(pure.isRateLimited({ message: 'connection reset' }), false)
  assert.equal(pure.isRateLimited('something else'), false)
})

test('isRateLimited is false for non-429 / null errors', () => {
  assert.equal(pure.isRateLimited(null), false)
  assert.equal(pure.isRateLimited(undefined), false)
  assert.equal(pure.isRateLimited({}), false)
  assert.equal(pure.isRateLimited({ code: 'AUTH' }), false)
  assert.equal(pure.isRateLimited({ status: 503 }), false)
})

// ---------------------------------------------------------------- rateLimitedText

test('rateLimitedText explains why the loop did not fire', () => {
  const s = pure.rateLimitedText()
  assert.match(s, /429/)
  assert.match(s, /自動繼續未觸發/)
  assert.match(s, /不再自動送出/)
})