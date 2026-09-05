// dsh-fallback-continue — Host half (dynamic Cordis package body).
// Must be a plain-JS function body that RETURNS a Cordis Plugin object.
// No import/require/TS/JSX. Timers via the `timer` service (ctx.get('timer')).

const VERSION = '1.0.0'

const DEFAULTS = {
  enabled: false,
  continueText: '繼續',
  retryIntervalsMinutes: [5, 10, 15, 30, 60, 60, 60, 60],
  capEnabled: true,
  capHours: 24,
}

return {
  inject: ['timer'],

  apply(ctx) {
    const agents = ctx.get('agents')
    const timer = ctx.get('timer')
    if (agents === undefined) return
    if (timer === undefined) return

    // --- runtime config (volatile, in-memory) ---
    let config = {
      enabled: DEFAULTS.enabled,
      continueText: DEFAULTS.continueText,
      retryIntervalsMinutes: DEFAULTS.retryIntervalsMinutes.slice(),
      capEnabled: DEFAULTS.capEnabled,
      capHours: DEFAULTS.capHours,
    }

    // entry = { sessionId, attempts, reason, text, paused, pausedRemainingMs,
    //           startedAt, failedAt, remainingMs, timerDisposer }
    const sessions = new Map()

    const now = () => Date.now()

    function intervalFor(attemptIndex) {
      const list = config.retryIntervalsMinutes
      if (!list || list.length === 0) return 60000
      const idx = Math.min(attemptIndex, list.length - 1)
      let mins = Number(list[idx])
      if (!Number.isFinite(mins) || mins <= 0) mins = 60
      return Math.round(mins * 60000)
    }

    function overCap(entry) {
      if (!config.capEnabled) return false
      if (!config.capHours || config.capHours <= 0) return false
      const limit = config.capHours * 3600000
      return now() - entry.failedAt >= limit
    }

    function remaining(entry) {
      if (entry.paused) return entry.pausedRemainingMs != null ? entry.pausedRemainingMs : entry.remainingMs
      if (entry.startedAt == null) return entry.remainingMs
      const rem = entry.remainingMs - (now() - entry.startedAt)
      return rem < 0 ? 0 : rem
    }

    function stopEntry(sessionId, why) {
      const e = sessions.get(sessionId)
      if (!e) return
      if (e.timerDisposer) { try { e.timerDisposer() } catch (_) {} e.timerDisposer = null }
      e.stopped = true
      e.stopReason = why
      sessions.delete(sessionId)
    }

    function arm(entry) {
      if (!config.enabled) { entry.timerDisposer = null; return }
      if (entry.paused) { entry.timerDisposer = null; return }
      if (overCap(entry)) { stopEntry(entry.sessionId, 'cap'); return }
      const delay = entry.remainingMs != null ? entry.remainingMs : intervalFor(entry.attempts)
      entry.remainingMs = delay
      entry.startedAt = now()
      if (entry.timerDisposer) { try { entry.timerDisposer() } catch (_) {} }
      entry.timerDisposer = timer.timeout(() => fire(entry), delay)
    }

    function fire(entry) {
      if (entry.stopped || !sessions.has(entry.sessionId)) return
      if (entry.paused) return
      if (overCap(entry)) { stopEntry(entry.sessionId, 'cap'); return }
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
      entry.attempts += 1
      entry.remainingMs = intervalFor(entry.attempts)
      entry.startedAt = null
      arm(entry)
    }

    function makeUserMessage(text) {
      const id = 'fallback-continue-' + now() + '-' + Math.floor(Math.random() * 1e9).toString(36)
      return {
        id,
        role: 'user',
        content: [{ type: 'text', text: String(text) }],
        source: { kind: 'plugin', plugin: 'dsh-fallback-continue' },
      }
    }

    function startCountdown(sessionId, reason, text) {
      const id = String(sessionId)
      const existing = sessions.get(id)
      if (existing) {
        existing.reason = reason || existing.reason
        if (text) existing.text = text
        return
      }
      const entry = {
        sessionId: id,
        attempts: 0,
        reason: reason || 'error',
        text: text || config.continueText,
        paused: false,
        pausedRemainingMs: null,
        startedAt: null,
        failedAt: now(),
        remainingMs: null,
        timerDisposer: null,
        stopped: false,
        stopReason: null,
      }
      entry.remainingMs = intervalFor(0)
      sessions.set(id, entry)
      arm(entry)
    }

    // ---- failure detection ----
    const offErr = ctx.on('agent/error', (payload) => {
      if (!config.enabled) return
      const agent = payload && payload.agent
      const id = agent && agent.id
      if (!id) return
      startCountdown(id, 'error', config.continueText)
    })

    // turn/end with error or max-tokens
    const offTurnEnd = ctx.on('session/event', (session, event) => {
      if (!config.enabled) return
      if (!event || event.type !== 'turn/end') return
      const reason = event.data && event.data.reason
      if (!reason) return
      const id = session && session.id
      if (!id) return
      if (reason.kind === 'error') startCountdown(id, 'error', config.continueText)
      else if (reason.kind === 'max-tokens') startCountdown(id, 'max-tokens', config.continueText)
      else if (reason.kind === 'completed') stopEntry(String(id), 'completed')
    })

    // human take-over: durable user/message authored by a human
    const offUser = ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'user/message') return
      const msg = event.data
      const src = msg && msg.source
      if (!src) return
      if (src.kind === 'user') {
        const id = session && session.id
        if (id) stopEntry(String(id), 'user-takeover')
      }
    })

    const offDisposed = ctx.on('agent/disposed', (payload) => {
      const agent = payload && payload.agent
      const id = agent && agent.id
      if (id) stopEntry(String(id), 'disposed')
    })

    const offRemoved = ctx.on('api-session/removed', (sessionId) => {
      stopEntry(String(sessionId), 'removed')
    })

    // Own the in-flight timers: cleared when the plugin stops.
    ctx.effect(() => () => {
      for (const id of Array.from(sessions.keys())) stopEntry(id, 'unload')
    })

    // ---- RPC ----
    function publicEntry(e) {
      return {
        sessionId: e.sessionId,
        attempts: e.attempts,
        reason: e.reason,
        text: e.text,
        paused: !!e.paused,
        remainingMs: remaining(e),
        failedAt: e.failedAt,
      }
    }

    harness.handle('getState', () => {
      return {
        version: VERSION,
        config: {
          enabled: config.enabled,
          continueText: config.continueText,
          retryIntervalsMinutes: config.retryIntervalsMinutes.slice(),
          capEnabled: config.capEnabled,
          capHours: config.capHours,
        },
        sessions: Array.from(sessions.values()).map(publicEntry),
      }
    })

    harness.handle('updateConfig', (args) => {
      const patch = args || {}
      if (typeof patch.enabled === 'boolean') config.enabled = patch.enabled
      if (typeof patch.continueText === 'string' && patch.continueText.length > 0) config.continueText = patch.continueText
      if (typeof patch.capEnabled === 'boolean') config.capEnabled = patch.capEnabled
      if (typeof patch.capHours === 'number' && patch.capHours >= 0) config.capHours = patch.capHours
      if (typeof patch.retryIntervals === 'string') {
        const arr = patch.retryIntervals.split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0)
        if (arr.length > 0) config.retryIntervalsMinutes = arr
      } else if (Array.isArray(patch.retryIntervalsMinutes)) {
        const arr = patch.retryIntervalsMinutes.filter((n) => Number.isFinite(n) && n > 0)
        if (arr.length > 0) config.retryIntervalsMinutes = arr
      }
      if (config.enabled === false) {
        for (const id of Array.from(sessions.keys())) stopEntry(id, 'disabled')
      } else {
        for (const e of sessions.values()) {
          if (!e.paused) arm(e)
        }
      }
      return { ok: true, config: {
        enabled: config.enabled,
        continueText: config.continueText,
        retryIntervalsMinutes: config.retryIntervalsMinutes.slice(),
        capEnabled: config.capEnabled,
        capHours: config.capHours,
      } }
    })

    harness.handle('pause', (args) => {
      const id = String((args || {}).sessionId)
      const e = sessions.get(id)
      if (!e) return { ok: false, error: 'no-such-session' }
      if (e.paused) return { ok: true }
      if (e.timerDisposer) { try { e.timerDisposer() } catch (_) {} e.timerDisposer = null }
      e.pausedRemainingMs = remaining(e)
      e.paused = true
      return { ok: true }
    })

    harness.handle('resume', (args) => {
      const id = String((args || {}).sessionId)
      const e = sessions.get(id)
      if (!e) return { ok: false, error: 'no-such-session' }
      if (!e.paused) return { ok: true }
      e.paused = false
      e.remainingMs = e.pausedRemainingMs != null ? e.pausedRemainingMs : intervalFor(e.attempts)
      e.pausedRemainingMs = null
      e.startedAt = null
      arm(e)
      return { ok: true }
    })

    harness.handle('retryNow', (args) => {
      const id = String((args || {}).sessionId)
      const e = sessions.get(id)
      if (!e) return { ok: true }
      if (e.timerDisposer) { try { e.timerDisposer() } catch (_) {} e.timerDisposer = null }
      e.paused = false
      e.pausedRemainingMs = null
      e.startedAt = null
      fire(e)
      return { ok: true }
    })

    harness.handle('cancel', (args) => {
      const id = String((args || {}).sessionId)
      const e = sessions.get(id)
      if (!e) return { ok: true }
      stopEntry(id, 'cancelled')
      return { ok: true }
    })
  },
}