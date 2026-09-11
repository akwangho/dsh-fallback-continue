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
  // Rate-limit cooldown: the fixed interval used after a 429 instead of
  // stopping outright — keeps requests sparse so the provider can cool down.
  cooldownMinutes: 720,
}

/**
 * Explain, in the session transcript, why the unattended loop stopped:
 * the elapsed time since the first failure exceeded the configured cap.
 * Kept in the pure module so the session-visible wording is testable and
 * consistent across host/client revisions.
 */
export function capStopText(capHours) {
  const h = Number(capHours)
  const hLabel = Number.isFinite(h) && h > 0 ? String(h) : '24'
  return '⛔ 自動繼續已停止：自第一次失敗起已超過上限（' + hLabel + ' 小時），此會話將不再自動送出「繼續」。若任務尚未完成，請手動送出訊息接手。'
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
    capEnabled: typeof c.capEnabled === 'boolean' ? c.capEnabled : DEFAULTS.capEnabled,
    capHours: typeof c.capHours === 'number' && c.capHours >= 0 ? c.capHours : DEFAULTS.capHours,
    cooldownMinutes: typeof c.cooldownMinutes === 'number' && c.cooldownMinutes > 0 ? c.cooldownMinutes : DEFAULTS.cooldownMinutes,
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
  // Coerce the index to a non-negative integer first: fractional indexes used
  // to index an array as-is (list[0.5] === undefined) and silently fell back
  // to 60 minutes. +Infinity clamps to the LAST slot (matches the previous
  // `Math.min(Infinity, len-1)` behaviour), while negative/NaN use the first.
  const raw = Number(failureIndex)
  const base = !Number.isFinite(raw)
    ? (raw > 0 ? list.length - 1 : 0) // +Infinity -> last; -Infinity/NaN -> first
    : (raw < 0 ? 0 : Math.floor(raw))
  const idx = Math.min(base, list.length - 1)
  let mins = Number(list[idx])
  if (!Number.isFinite(mins) || mins <= 0) mins = 60
  return Math.round(mins * 60000)
}

/**
 * Whether the unattended loop has exceeded the configured time cap, given the
 * first-failure timestamp and the current time. `capHours <= 0` or
 * `capEnabled === false` means "no cap".
 */
export function overCap(failedAt, capEnabled, capHours, at) {
  if (capEnabled !== true) return false
  const hours = Number(capHours)
  if (!Number.isFinite(hours) || hours <= 0) return false
  const since = (Number(at) || Date.now()) - (Number(failedAt) || 0)
  return since >= hours * 3600000
}

/**
 * Compute the ms remaining on a counting countdown at time `at`, mirroring the
 * controller's `remaining()`. Returns `null` when the entry is `awaiting`
 * (already sent), the frozen paused remainder when paused, the whole delay
 * when the timer has not started, and 0 once the delay has elapsed.
 */
export function remainingMs(entry, at) {
  if (entry == null) return null
  if (entry.phase === 'awaiting') return null
  if (entry.paused) return entry.pausedRemainingMs != null ? entry.pausedRemainingMs : entry.remainingMs
  if (entry.startedAt == null) return entry.remainingMs
  if (entry.remainingMs == null) return null // no countdown total recorded
  const total = Number(entry.remainingMs)
  if (!Number.isFinite(total)) return null
  const rem = total - ((Number(at) || Date.now()) - entry.startedAt)
  return rem < 0 ? 0 : rem
}

/**
 * Derive the human-facing failure reason string from an error payload:
 * string, Error-like (`.message`), or `.code`, defaulting to "error".
 */
export function errorTextOf(error) {
  if (error == null) return 'error'
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  if (error.code) return String(error.code)
  return 'error'
}

/**
 * Whether an error payload represents an API rate-limit (HTTP 429) failure.
 * Detects the machine code (`RATE_LIMIT`), the retained HTTP status, the
 * serialized `failure` facts object, or the message text — so it works whether
 * the failure arrives as a live `LlmError`/`HarnessError` or a plain object.
 */
export function isRateLimited(error) {
  if (error == null) return false
  if (typeof error === 'string') return /429|\brate.?limit\b|too many requests/i.test(error)
  if (error.code === 'RATE_LIMIT') return true
  if (error.status === 429) return true
  const f = error.failure
  if (f && (f.code === 'RATE_LIMIT' || f.status === 429)) return true
  if (typeof error.message === 'string' && /429|\brate.?limit\b|too many requests/i.test(error.message)) return true
  return false
}

/**
 * Format a stop timestamp as local `YYYY-MM-DD HH:mm:ss` so the user can see
 * exactly when the unattended loop stopped (e.g. a 429 halt) and judge how
 * long has passed before manually continuing.
 */
export function formatStopTime(at) {
  const ms = Number(at)
  const d = Number.isFinite(ms) ? new Date(ms) : new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

/**
 * In-session notice explaining that the unattended loop switched into
 * rate-limit cooldown instead of stopping: the last failure was an API 429, so
 * "繼續" is sent on a long fixed interval until the provider recovers, then
 * the loop returns to the configured escalating schedule. Includes the time
 * the 429 occurred and the expected next-attempt time, so the user knows when
 * the 429 happened and when to expect progress.
 */
export function rateLimitedText(at = Date.now(), cooldownMinutes = DEFAULTS.cooldownMinutes, continueText = DEFAULTS.continueText) {
  const mins = Number(cooldownMinutes)
  const ok = Number.isFinite(mins) && mins > 0
  const minsLabel = ok ? String(mins) : String(DEFAULTS.cooldownMinutes)
  const delayMs = (ok ? mins : DEFAULTS.cooldownMinutes) * 60000
  const text = typeof continueText === 'string' && continueText.length > 0 ? continueText : DEFAULTS.continueText
  return '⚠️ 429 限流冷卻中：本次 429 發生於 ' + formatStopTime(at) + '。' +
    '為減少請求量，已改為每 ' + minsLabel + ' 分鐘自動送出「' + text + '」，' +
    '預計下次送出時間：' + formatStopTime(at + delayMs) + '。' +
    '若仍是 429 會繼續維持此間隔；回復正常後自動切回原設定的重試間隔。'
}

/**
 * Classify a `turn/end` stop-reason `kind` into an action for the loop:
 *   - 'error' | 'max-tokens'  -> 'failure' (arm/continue the streak)
 *   - 'completed'             -> 'reset'   (streak resets)
 *   - anything else           -> 'ignore'
 */
export function classifyStop(kind) {
  if (kind === 'error' || kind === 'max-tokens') return 'failure'
  if (kind === 'completed') return 'reset'
  return 'ignore'
}