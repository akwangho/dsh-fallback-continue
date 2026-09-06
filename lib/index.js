// dsh-plugin-fallback-continue — host half.
//
// Watches session turns for failures and, in unattended operation, drives a
// "continue" fallback loop:
//   - A turn ending in `error` (the red "本輪運行失敗") starts or continues a streak.
//   - A countdown arms; when it expires it sends the configured text once and
//     then STOPS timing — it waits for the model's next outcome.
//   - If the next turn errors again, the streak escalates (next interval) and
//     arms a new countdown.
//   - If a turn completes (or max-tokens, i.e. the model produced output), the
//     streak resets to the beginning.
//
// Settings persist through the `settings` service (namespace `fallback-continue`),
// so the enable toggle and intervals survive a `dsh web` restart.
//
// Client -> host calls ride the generic Connection RPC channel
// (`/api/fallbackContinue/*`), dispatched by the Typert gateway to the
// `fallbackContinue` Remote service below.

import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-plugin-fallback-continue'
export const inject = ['agents']

const VERSION = '1.2.0'

const DEFAULTS = {
  enabled: false,
  continueText: '繼續',
  retryIntervalsMinutes: [5, 10, 15, 30, 60, 60, 60, 60],
  capEnabled: true,
  capHours: 24,
}

// Settings namespace + schema for persistence (via the `settings` service).
const SETTINGS_NS = 'fallback-continue'
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().required(),
  continueText: z.string().required(),
  retryIntervalsMinutes: z.array(z.number()).required(),
  capEnabled: z.boolean().required(),
  capHours: z.number().required(),
})

function normalizeConfig(c) {
  c = c || {}
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULTS.enabled,
    continueText: typeof c.continueText === 'string' && c.continueText.length > 0 ? c.continueText : DEFAULTS.continueText,
    retryIntervalsMinutes: Array.isArray(c.retryIntervalsMinutes) && c.retryIntervalsMinutes.length > 0
      ? c.retryIntervalsMinutes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
      : DEFAULTS.retryIntervalsMinutes.slice(),
    capEnabled: typeof c.capEnabled === 'boolean' ? c.capEnabled : true,
    capHours: typeof c.capHours === 'number' && c.capHours >= 0 ? c.capHours : 24,
  }
}

// ---- Remote marker bookkeeping (hand-written `@Remote` decorator runtime) ----
const remoteInitializers = []
function declareRemote(method) {
  const context = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: {},
    addInitializer(fn) {
      remoteInitializers.push(fn)
    },
  }
  Remote(method)(undefined, context)
}
declareRemote('getState')
declareRemote('updateConfig')
declareRemote('pause')
declareRemote('resume')
declareRemote('retryNow')
declareRemote('cancel')

class FallbackContinueService extends TypertRemoteService {
  constructor(ctx, ctrl) {
    super(ctx, 'fallbackContinue')
    this.ctrl = ctrl
    for (const fn of remoteInitializers) fn.call(this)
  }

  getState() { return this.ctrl.getState() }
  updateConfig(patch) { return this.ctrl.updateConfig(patch) }
  pause(sessionId) { return this.ctrl.pause(sessionId) }
  resume(sessionId) { return this.ctrl.resume(sessionId) }
  retryNow(sessionId) { return this.ctrl.retryNow(sessionId) }
  cancel(sessionId) { return this.ctrl.cancel(sessionId) }
}

// ---- controller: owns the in-memory config + per-session streak state ----
function createController(ctx) {
  const agents = ctx.agents
  const settings = ctx.get('settings')
  const workspaceRegistry = ctx.get('workspaceRegistry')

  let config = normalizeConfig(DEFAULTS)
  let sourceRef = () => DEFAULTS

  // B1 — persist settings through the `settings` service when it is mounted.
  // `setSource` receives a thunk () => T (the live resolved value), so call it.
  if (settings && typeof settings.installSection === 'function') {
    try {
      settings.installSection(ctx, SETTINGS_NS, SETTINGS_SCHEMA, DEFAULTS, {
        setSource: (current) => {
          sourceRef = current
          config = normalizeConfig(current())
        },
        onChange: () => {
          config = normalizeConfig(sourceRef())
        },
      })
    } catch (err) {
      console.error('fallback-continue: settings persistence unavailable:', String(err))
    }
  }

  // entry = { sessionId, failures, lastTurn, reason, text, paused, pausedRemainingMs,
  //           startedAt, failedAt, remainingMs, timerId, phase }
  //   phase: 'counting' (timer armed) | 'awaiting' (sent, no timer)
  const sessions = new Map()

  const now = () => Date.now()

  function intervalFor(failureIndex) {
    const list = config.retryIntervalsMinutes
    if (!list || list.length === 0) return 60000
    const idx = Math.min(failureIndex, list.length - 1)
    let mins = Number(list[idx])
    if (!Number.isFinite(mins) || mins <= 0) mins = 60
    return Math.round(mins * 60000)
  }

  function overCap(entry) {
    if (!config.capEnabled) return false
    if (!config.capHours || config.capHours <= 0) return false
    return now() - entry.failedAt >= config.capHours * 3600000
  }

  function remaining(entry) {
    if (entry.phase === 'awaiting') return null
    if (entry.paused) return entry.pausedRemainingMs != null ? entry.pausedRemainingMs : entry.remainingMs
    if (entry.startedAt == null) return entry.remainingMs
    const rem = entry.remainingMs - (now() - entry.startedAt)
    return rem < 0 ? 0 : rem
  }

  function clearTimer(entry) {
    if (entry.timerId != null) {
      clearTimeout(entry.timerId)
      entry.timerId = null
    }
  }

  function stopEntry(sessionId, why) {
    const e = sessions.get(sessionId)
    if (!e) return
    clearTimer(e)
    e.stopped = true
    e.stopReason = why
    sessions.delete(sessionId)
  }

  // A1 — a session hidden by "archive" must stop its streak.
  function isArchived(id) {
    if (!workspaceRegistry) return false
    try {
      const set = workspaceRegistry.archivedSessionIds
      return Array.isArray(set) && set.some((x) => String(x) === id)
    } catch (_) {
      return false
    }
  }

  function arm(entry) {
    if (!config.enabled) { clearTimer(entry); return }
    if (entry.paused) { clearTimer(entry); return }
    if (entry.phase !== 'counting') return
    if (overCap(entry)) { stopEntry(entry.sessionId, 'cap'); return }
    if (isArchived(entry.sessionId)) { stopEntry(entry.sessionId, 'archived'); return }
    const delay = entry.remainingMs != null ? entry.remainingMs : intervalFor(entry.failures)
    entry.remainingMs = delay
    entry.startedAt = now()
    clearTimer(entry)
    entry.timerId = setTimeout(() => fire(entry), delay)
  }

  function fire(entry) {
    if (entry.stopped || !sessions.has(entry.sessionId)) return
    if (entry.paused) return
    if (entry.phase !== 'counting') return
    if (overCap(entry)) { stopEntry(entry.sessionId, 'cap'); return }
    if (isArchived(entry.sessionId)) { stopEntry(entry.sessionId, 'archived'); return }
    const agent = agents.get(entry.sessionId)
    if (agent === undefined || typeof agent.followup !== 'function') {
      stopEntry(entry.sessionId, 'gone')
      return
    }
    const text = entry.text || config.continueText
    const message = makeUserMessage(text)
    try {
      agent.followup(message)
    } catch (err) {
      stopEntry(entry.sessionId, 'send-failed')
      return
    }
    // Sent: stop timing. Wait for the next failure (escalate) or success (reset).
    clearTimer(entry)
    entry.phase = 'awaiting'
    entry.startedAt = null
    entry.remainingMs = null
  }

  function makeUserMessage(text) {
    const id = 'fallback-continue-' + now() + '-' + Math.floor(Math.random() * 1e9).toString(36)
    return {
      id,
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-fallback-continue' },
    }
  }

  // failure signals dedup by turn number: `agent/error` fires mid-turn and
  // `turn/end` fires at its close, both carrying the same `turn`.
  function onFailure(sessionId, turn, reason, errorText) {
    const id = String(sessionId)
    if (isArchived(id)) return
    let entry = sessions.get(id)
    if (entry) {
      if (turn != null && entry.lastTurn === turn) return
      entry.failures += 1
      entry.lastTurn = turn != null ? turn : entry.lastTurn
      entry.reason = errorText || reason || entry.reason || 'error'
      entry.paused = false
      entry.pausedRemainingMs = null
      entry.phase = 'counting'
      entry.remainingMs = intervalFor(entry.failures)
      entry.startedAt = null
      clearTimer(entry)
      arm(entry)
      return
    }
    entry = {
      sessionId: id,
      failures: 0,
      lastTurn: turn != null ? turn : null,
      reason: errorText || reason || 'error',
      text: config.continueText,
      paused: false,
      pausedRemainingMs: null,
      startedAt: null,
      failedAt: now(),
      remainingMs: intervalFor(0),
      timerId: null,
      stopped: false,
      stopReason: null,
      phase: 'counting',
    }
    sessions.set(id, entry)
    arm(entry)
  }

  function errorTextOf(error) {
    if (error == null) return 'error'
    if (typeof error === 'string') return error
    if (error.message) return String(error.message)
    if (error.code) return String(error.code)
    return 'error'
  }

  // ---- events ----
  ctx.on('session/event', (session, event) => {
    if (!config.enabled) return
    if (!event || event.type !== 'turn/end') return
    const reason = event.data && event.data.reason
    const id = session && session.id
    if (!reason || !id) return
    const turn = event.data.turn
    if (reason.kind === 'error') {
      onFailure(id, turn, 'error', errorTextOf(reason.error))
    } else if (reason.kind === 'completed' || reason.kind === 'max-tokens') {
      stopEntry(String(id), 'completed')
    }
  })

  ctx.on('agent/error', (payload) => {
    if (!config.enabled) return
    const agent = payload && payload.agent
    const id = agent && agent.id
    if (!id) return
    onFailure(id, payload.turn, 'error', errorTextOf(payload.error))
  })

  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    const msg = event.data
    const src = msg && msg.source
    if (!src) return
    if (src.kind === 'user') {
      const id = session && session.id
      if (id) stopEntry(String(id), 'user-takeover')
    }
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    const id = agent && agent.id
    if (id) stopEntry(String(id), 'disposed')
  })

  ctx.on('api-session/removed', (sessionId) => {
    stopEntry(String(sessionId), 'removed')
  })

  // A1 — clear streaks for sessions that became archived (workspace write).
  if (workspaceRegistry) {
    ctx.on('domain/changed', () => {
      for (const id of Array.from(sessions.keys())) {
        if (isArchived(id)) stopEntry(id, 'archived')
      }
    })
  }

  // Own the in-flight timers: cleared when the plugin stops.
  ctx.effect(() => () => {
    for (const id of Array.from(sessions.keys())) stopEntry(id, 'unload')
  })

  // ---- RPC surface ----
  function publicEntry(e) {
    return {
      sessionId: e.sessionId,
      failures: e.failures,
      reason: e.reason,
      text: e.text,
      paused: !!e.paused,
      phase: e.phase,
      remainingMs: remaining(e),
      failedAt: e.failedAt,
    }
  }

  function snapshotConfig() {
    return {
      enabled: config.enabled,
      continueText: config.continueText,
      retryIntervalsMinutes: config.retryIntervalsMinutes.slice(),
      capEnabled: config.capEnabled,
      capHours: config.capHours,
    }
  }

  async function persist() {
    if (settings && typeof settings.replace === 'function') {
      await settings.replace(SETTINGS_NS, {
        enabled: config.enabled,
        continueText: config.continueText,
        retryIntervalsMinutes: config.retryIntervalsMinutes.slice(),
        capEnabled: config.capEnabled,
        capHours: config.capHours,
      }).catch(() => {})
    }
  }

  function snapshot() {
    return { version: VERSION, config: snapshotConfig(), sessions: Array.from(sessions.values()).map(publicEntry) }
  }

  return {
    getState() {
      return snapshot()
    },
    async updateConfig(rawPatch) {
      const p = rawPatch || {}
      let next = { ...config }
      if (typeof p.enabled === 'boolean') next.enabled = p.enabled
      if (typeof p.continueText === 'string' && p.continueText.length > 0) next.continueText = p.continueText
      if (typeof p.capEnabled === 'boolean') next.capEnabled = p.capEnabled
      if (typeof p.capHours === 'number' && p.capHours >= 0) next.capHours = p.capHours
      if (typeof p.retryIntervals === 'string') {
        const arr = p.retryIntervals.split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0)
        if (arr.length > 0) next.retryIntervalsMinutes = arr
      } else if (Array.isArray(p.retryIntervalsMinutes)) {
        const arr = p.retryIntervalsMinutes.filter((n) => Number.isFinite(n) && n > 0)
        if (arr.length > 0) next.retryIntervalsMinutes = arr
      }
      config = normalizeConfig(next)
      await persist()
      if (config.enabled === false) {
        for (const id of Array.from(sessions.keys())) stopEntry(id, 'disabled')
      } else {
        for (const e of sessions.values()) {
          if (!e.paused && e.phase === 'counting') arm(e)
        }
      }
      return { ok: true, config: snapshotConfig() }
    },
    pause(sessionId) {
      const id = String(sessionId)
      const e = sessions.get(id)
      if (!e) return { ok: true }
      if (e.paused) return { ok: true }
      if (e.phase !== 'counting') return { ok: true }
      clearTimer(e)
      e.pausedRemainingMs = remaining(e)
      e.paused = true
      return { ok: true }
    },
    resume(sessionId) {
      const id = String(sessionId)
      const e = sessions.get(id)
      if (!e) return { ok: true }
      if (!e.paused) return { ok: true }
      e.paused = false
      e.remainingMs = e.pausedRemainingMs != null ? e.pausedRemainingMs : intervalFor(e.failures)
      e.pausedRemainingMs = null
      e.startedAt = null
      e.phase = 'counting'
      arm(e)
      return { ok: true }
    },
    retryNow(sessionId) {
      const id = String(sessionId)
      const e = sessions.get(id)
      if (!e) return { ok: true }
      if (e.phase !== 'counting') return { ok: true }
      clearTimer(e)
      e.paused = false
      e.pausedRemainingMs = null
      e.startedAt = null
      fire(e)
      return { ok: true }
    },
    cancel(sessionId) {
      const id = String(sessionId)
      const e = sessions.get(id)
      if (!e) return { ok: true }
      stopEntry(id, 'cancelled')
      return { ok: true }
    },
  }
}

export function apply(ctx) {
  const ctrl = createController(ctx)
  // Constructing the service registers it on this fiber's context; the Typert
  // gateway discovers it through the cordis reflect tree and serves the
  // `fallbackContinue/*` endpoints to the browser half.
  new FallbackContinueService(ctx, ctrl)
}