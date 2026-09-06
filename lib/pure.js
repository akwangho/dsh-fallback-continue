// dsh-plugin-fallback-continue — pure, dependency-free helpers.
//
// Extracted so unit tests can exercise the state-machine math without pulling
// in the heavy runtime deps (@deepseek-ai/dsh-typert-protocol, schemastery).

export const DEFAULTS = {
  enabled: false,
  continueText: '繼續',
  retryIntervalsMinutes: [5, 10, 15, 30, 60, 60, 60, 60],
  capEnabled: true,
  capHours: 24,
}

/** Normalize a (possibly partial/typed-wrong) config value against defaults. */
export function normalizeConfig(c) {
  c = c || {}
  const rawIntervals = Array.isArray(c.retryIntervalsMinutes) && c.retryIntervalsMinutes.length > 0
    ? c.retryIntervalsMinutes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : []
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULTS.enabled,
    continueText: typeof c.continueText === 'string' && c.continueText.length > 0 ? c.continueText : DEFAULTS.continueText,
    retryIntervalsMinutes: rawIntervals.length > 0 ? rawIntervals : DEFAULTS.retryIntervalsMinutes.slice(),
    capEnabled: typeof c.capEnabled === 'boolean' ? c.capEnabled : true,
    capHours: typeof c.capHours === 'number' && c.capHours >= 0 ? c.capHours : 24,
  }
}

/**
 * Resolve the retry delay (ms) for a consecutive-failure index against an
 * interval list; invalid/empty entries fall back to 60 minutes, and the index
 * clamps to the last configured value.
 */
export function intervalFor(list, failureIndex) {
  const FALLBACK = 60 * 60000 // 60 minutes, mirrors the trailing default interval
  if (!Array.isArray(list) || list.length === 0) return FALLBACK
  const idx = Math.min(failureIndex < 0 ? 0 : failureIndex, list.length - 1)
  let mins = Number(list[idx])
  if (!Number.isFinite(mins) || mins <= 0) mins = 60
  return Math.round(mins * 60000)
}