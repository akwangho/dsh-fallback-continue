// dsh-fallback-continue — host controller.
//
// Owns the unattended 「繼續」 loop: failure detection, the escalating retry
// schedule, the 429 cooldown, the cap stop, and the RPC surface consumed by
// the Typert `fallbackContinue` service in index.js.
//
// Queued-prompt holding (v1.9.0)
// ------------------------------
// The host driver claims pending next-step input plus ONE queued prompt
// atomically at every turn boundary, and any waking send against an idle
// agent opens a turn immediately. So a prompt queued behind a failed turn
// used to start a fresh turn BEFORE the countdown fired — running ahead of
// 「繼續」 and starting new work while the failed task was still unfinished.
//
// While a failure streak is active (counting OR awaiting), the controller now
// stashes queued user prompts out of the agent inbox:
//   - `agent/inbox/inserted` holds each new source-less prompt the moment it
//     lands (typed user messages are a takeover instead — see below);
//   - `holdQueueFor()` sweeps anything already pending when the streak arms
//     and again right before the steer, as a safety net;
//   - held prompts go back (FIFO, one waking `followup`) the moment 「繼續」 is
//     steered — it is already ahead of them in next-step, so they resume their
//     original queue positions immediately rather than disappearing until the
//     streak ends — and also on any other exit from the loop (a completed
//     turn, cancel / user takeover / cap stop / disable), so user input is
//     never lost. Archived sessions keep them cancelled.
//
// A message the human TYPES during the streak is an explicit takeover: the
// streak stops (releasing everything held so far, FIFO) and the fresh message
// runs. The session log only records a typed message once the driver CLAIMS
// it, so holding a fresh one would make it vanish without a trace.
//
// A content-less completed turn boundary (no claimed prompt, no output, no
// usage) is treated as a scheduler artifact and does NOT reset the streak:
// boundary turns like that are exactly what the driver closes while queued
// input is being held, and counting one as success would release the held
// prompts while the task is still broken.

import {
  DEFAULTS, normalizeConfig, intervalFor, capStopText, rateLimitedText,
  overCap, remainingMs, errorTextOf, classifyStop, isRateLimited, boundaryHasContent, isUserAuthored,
} from './pure.js'

// Settings namespace + schema for persistence (via the `settings` service).
export const SETTINGS_NS = 'fallback-continue'

export function settingsSchema(z) {
  return z.object({
    enabled: z.boolean().required(),
    continueText: z.string().required(),
    retryIntervalsMinutes: z.array(z.number()).required(),
    capEnabled: z.boolean().required(),
    capHours: z.number().required(),
    cooldownMinutes: z.number().required(),
  })
}

// ---- controller: owns the in-memory config + per-session streak state ----
// `deps.z` is the schemastery module (for the settings schema) and
// `deps.version` the package version; both are injected by index.js so this
// module stays dependency-free and unit-testable.
export function createController(ctx, deps = {}) {
  const agents = ctx.agents
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const VERSION = String(deps.version || '0.0.0')

  let config = normalizeConfig(DEFAULTS)
  let sourceRef = () => DEFAULTS

  // B1 — persist settings through the `settings` service. The service may not
  // be mounted when `apply` first runs (it registers later in the same boot),
  // so installation is deferred through `ctx.inject(['settings'], …)`, which
  // re-runs the callback whenever the `settings` service (re)mounts — the same
  // pattern the sibling `dsh-subagent-cap` plugin uses. Without this, a
  // silently-skipped single `ctx.get('settings')` would leave the config
  // unregistered and every updateConfig() would fail to persist across restart.
  function installSettings(settingsCtx) {
    const settings = settingsCtx && settingsCtx.settings
    if (!settings || typeof settings.installSection !== 'function') return
    const z = deps.z
    if (!z) return
    try {
      settings.installSection(ctx, SETTINGS_NS, settingsSchema(z), DEFAULTS, {
        // `setSource` receives a thunk () => T (the live resolved value).
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
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], installSettings)
  } else {
    const settingsNow = ctx.get('settings')
    if (settingsNow && typeof settingsNow.installSection === 'function') {
      installSettings({ settings: settingsNow })
    }
  }

  // entry = { sessionId, failures, lastTurn, reason, text, paused, pausedRemainingMs,
  //           startedAt, failedAt, remainingMs, timerId, phase,
  //           holding, heldMessages }
  //   phase: 'counting' (timer armed) | 'awaiting' (sent, no timer)
  //   holding:    streak active — queued user prompts are stashed, not run
  //   heldMessages: stashed prompts, FIFO, re-queued on success/exit
  const sessions = new Map()

  // Ids of messages this controller restored from its own hold queue. Their
  // re-insert (and later claim) must NOT be read as fresh user input: putting
  // a held prompt back is queue maintenance, not a takeover. Without this,
  // `agent/inbox/inserted` fires synchronously inside `releaseHeld`'s
  // `followup` and the insert listener would kill the very streak whose queue
  // it is restoring. Bounded so a never-claimed restore cannot grow it.
  const restoredIds = new Set()
  const RESTORED_IDS_CAP = 256
  function markRestored(m) {
    if (!m || m.id == null) return
    const key = String(m.id)
    if (restoredIds.has(key)) return
    // Evict the OLDEST id first (Set preserves insertion order) rather than
    // clearing the whole set: a wholesale clear could forget an id whose
    // restored message is still pending in the inbox, and its later claim would
    // then be misread as a fresh user takeover.
    if (restoredIds.size >= RESTORED_IDS_CAP) restoredIds.delete(restoredIds.values().next().value)
    restoredIds.add(key)
  }
  function isRestored(m) {
    return !!(m && m.id != null && restoredIds.has(String(m.id)))
  }
  function consumeRestored(m) {
    if (!m || m.id == null) return false
    const key = String(m.id)
    if (!restoredIds.has(key)) return false
    restoredIds.delete(key)
    return true
  }

  const now = () => Date.now()

  // local alias bound to the current config's interval list
  const delayFor = (failureIndex) => intervalFor(config.retryIntervalsMinutes, failureIndex)

  function overCapAt(entry) {
    return overCap(entry.failedAt, config.capEnabled, config.capHours, now())
  }

  // Record a durable notice into the session transcript: the user must be able
  // to see WHY the unattended loop ended (cap stop, or rate-limit refusal).
  function recordNotice(sessionId, text) {
    try {
      const agent = agents.get(String(sessionId))
      const session = agent && agent.session
      if (session === undefined || typeof session.append !== 'function') return
      const id = 'fallback-continue-notice-' + now() + '-' + Math.floor(Math.random() * 1e9).toString(36)
      const message = {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-plugin-fallback-continue',
          form: 'notice',
          summary: text,
        },
      }
      session.append('user/message', message, { surfaceOp: 'append' })
    } catch (_) {}
  }

  function recordCapStop(entry) {
    recordNotice(entry.sessionId, capStopText(config.capHours))
  }

  // Cap stop: write the in-session record first, then drop the entry.
  function capStop(entry) {
    recordCapStop(entry)
    stopEntry(entry.sessionId, 'cap')
  }

  // Rate-limit (HTTP 429) cooldown: instead of stopping outright, arm the
  // continue loop on a long fixed interval (config.cooldownMinutes, default
  // 720) so requests stay sparse while the provider cools down. Consecutive
  // 429s keep this interval; a non-429 failure or success reverts to the
  // normal escalating schedule. A notice with the 429 time + next-attempt
  // time is written once, when the session enters cooldown.
  function onRateLimited(sessionId, turn) {
    const id = String(sessionId)
    if (isArchived(id)) return
    let entry = sessions.get(id)
    if (entry) {
      if (turn != null && entry.lastTurn === turn) return
      if (!entry.cooling) recordNotice(id, rateLimitedText(now(), config.cooldownMinutes, config.continueText))
      entry.cooling = true
      entry.failures += 1
      entry.lastTurn = turn != null ? turn : entry.lastTurn
      entry.reason = 'rate-limit (429)'
      entry.paused = false
      entry.pausedRemainingMs = null
      entry.phase = 'counting'
      entry.remainingMs = cooldownDelayMs()
      entry.startedAt = null
      clearTimer(entry)
      arm(entry)
      return
    }
    entry = {
      sessionId: id,
      failures: 0,
      lastTurn: turn != null ? turn : null,
      reason: 'rate-limit (429)',
      text: config.continueText,
      paused: false,
      pausedRemainingMs: null,
      startedAt: null,
      failedAt: now(),
      remainingMs: cooldownDelayMs(),
      timerId: null,
      stopped: false,
      stopReason: null,
      phase: 'counting',
      cooling: true,
      holding: false,
      heldMessages: [],
    }
    sessions.set(id, entry)
    recordNotice(id, rateLimitedText(now(), config.cooldownMinutes, config.continueText))
    arm(entry)
  }

  function cooldownDelayMs() {
    return Math.round(Number(config.cooldownMinutes > 0 ? config.cooldownMinutes : DEFAULTS.cooldownMinutes) * 60000)
  }

  // Effective next delay: cooldown interval while rate-limited, else the
  // escalating schedule slot for the current consecutive-failure count.
  function nextDelayFor(entry) {
    return entry.cooling ? cooldownDelayMs() : delayFor(entry.failures)
  }

  const remaining = (entry) => remainingMs(entry, now())

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
    // Never lose user prompts to the loop's bookkeeping: unless the session
    // itself is archived, put any held prompts back before dropping the entry
    // (for 'completed' this is the designed release point — the failed task
    // has been continued successfully, so queued work may finally run).
    if (why !== 'archived') releaseHeld(e)
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

  // ---------------- queued-prompt holding ----------------

  // Hold only real user prompts (and untyped messages). Plugin notices and
  // other plugins' internal injections keep their normal inbox semantics —
  // this also exempts this plugin's own 「繼續」 steer and transcript notices.
  function isHoldable(m) {
    const src = m && m.source
    if (src && src.kind !== 'user') return false
    return true
  }

  // Read `inbox.nextTurn` / `inbox.nextStep` whether they are methods or
  // array properties (defensive against interface drift).
  function pendingOf(inbox, key) {
    try {
      const v = inbox[key]
      if (typeof v === 'function') return v.call(inbox)
      if (Array.isArray(v)) return v
    } catch (_) {}
    return null
  }

  // Stash every pending user prompt out of the agent inbox while the streak is
  // active. Sweep `nextStep` BEFORE `nextTurn` so the hold list matches the
  // driver's claim priority (claim drains all of next-step, then one
  // next-turn); releaseHeld re-queues in hold order, so a mixed hold comes
  // back in its original claim order instead of inverted. Best-effort: if the
  // remove API is unavailable the prompt simply keeps the old behavior.
  function holdQueueFor(entry) {
    const agent = agents.get(entry.sessionId)
    const inbox = agent && agent.inbox
    if (!inbox) return
    try {
      for (const key of ['nextStep', 'nextTurn']) {
        const list = pendingOf(inbox, key)
        if (!Array.isArray(list)) continue
        // Iterate a snapshot: inbox.remove() splices the live array, and
        // mutating it mid-iteration would skip every second prompt.
        for (const m of list.slice()) {
          if (m == null || typeof m !== 'object' || !isHoldable(m)) continue
          if (typeof inbox.remove !== 'function') return
          // Honor a boolean result: if the inbox reports it did NOT remove the
          // message, do not stash a copy anyway — a message left pending AND
          // held would later fail its duplicate-id re-insert and be dropped.
          // (An older interface may return undefined; treat that as success.)
          const removed = inbox.remove(m.id)
          if (removed === false) continue
          entry.heldMessages.push(m)
        }
      }
    } catch (_) {}
  }

  // Put held prompts back (FIFO) and wake the driver. `followup` is the waking
  // next-turn send, so one call per message re-queues and wakes. Best-effort:
  // a disposed agent simply drops them. Each restored message is marked first:
  // the re-insert fires `agent/inbox/inserted` synchronously, and the restore
  // must not be mistaken for fresh input.
  //
  // A prompt whose re-insert FAILED is kept (at the FRONT, preserving FIFO) for
  // the next release point instead of vanishing from both the inbox and the
  // hold list — the loop must never lose user input to a transient send error.
  function releaseHeld(entry) {
    const held = Array.isArray(entry.heldMessages) ? entry.heldMessages.splice(0, entry.heldMessages.length) : []
    if (held.length === 0) return
    const agent = agents.get(entry.sessionId)
    if (agent === undefined) return
    const kept = []
    for (const m of held) {
      markRestored(m)
      let restored = false
      try {
        if (typeof agent.followup === 'function') { agent.followup(m); restored = true }
        else if (typeof agent.steer === 'function') { agent.steer(m); restored = true }
      } catch (_) {}
      if (!restored) kept.push(m)
    }
    if (kept.length > 0 && Array.isArray(entry.heldMessages)) entry.heldMessages.unshift(...kept)
  }

  // Hold source-less prompts the moment they land in an inbox whose session
  // has an active streak (counting OR awaiting) — otherwise they would be
  // claimed at the next turn boundary ahead of 「繼續」.
  //
  // EXCEPT messages the human typed just now (`source.kind === 'user'`, the
  // stamp the prompt RPC puts on every typed message): those are an explicit
  // takeover. The session transcript only records a typed message when the
  // driver CLAIMS it from the inbox, so stashing it would make it vanish
  // without a trace and the 'user/message' takeover stop could never fire.
  // Instead the streak stops (releasing everything held so far, FIFO) and the
  // fresh message stays in the inbox, claimed and run immediately.
  function onInboxInserted(payload) {
    if (!config.enabled) return
    const agent = payload && payload.agent
    const id = agent && agent.id
    if (!id) return
    const entry = sessions.get(String(id))
    if (!entry) return
    const m = payload.message
    if (m == null || typeof m !== 'object') return
    if (isRestored(m)) return // our own queue restore: neither hold nor takeover
    try {
      if (isUserAuthored(m)) { stopEntry(String(id), 'user-takeover'); return }
      if (!isHoldable(m)) return
      const inbox = agent.inbox
      if (inbox && typeof inbox.remove === 'function') {
        const removed = inbox.remove(m.id)
        if (removed === false) return
        entry.heldMessages.push(m)
      }
    } catch (_) {}
  }

  function arm(entry) {
    if (!config.enabled) { clearTimer(entry); return }
    if (entry.paused) { clearTimer(entry); return }
    if (entry.phase !== 'counting') return
    if (overCapAt(entry)) { capStop(entry); return }
    if (isArchived(entry.sessionId)) { stopEntry(entry.sessionId, 'archived'); return }
    // While armed, queued prompts must not run before 「繼續」: stash them.
    entry.holding = true
    holdQueueFor(entry)
    const delay = entry.remainingMs != null ? entry.remainingMs : nextDelayFor(entry)
    entry.remainingMs = delay
    entry.startedAt = now()
    clearTimer(entry)
    entry.timerId = setTimeout(() => fire(entry), delay)
  }

  function fire(entry) {
    if (entry.stopped || !sessions.has(entry.sessionId)) return
    if (entry.paused) return
    if (entry.phase !== 'counting') return
    if (overCapAt(entry)) { capStop(entry); return }
    if (isArchived(entry.sessionId)) { stopEntry(entry.sessionId, 'archived'); return }
    const agent = agents.get(entry.sessionId)
    if (agent === undefined || typeof agent.steer !== 'function') {
      stopEntry(entry.sessionId, 'gone')
      return
    }
    // Final sweep: catch anything that slipped past the inserted-event hold,
    // so the steer below is the only waking input the driver can claim.
    holdQueueFor(entry)
    const text = config.continueText || entry.text
    const message = makeUserMessage(text)
    try {
      // Use steering (next-step inbox) so 「繼續」 is treated as priority input:
      // an idle driver starts its turn with this steering, and — with every
      // queued prompt held back — nothing else can be claimed alongside it.
      agent.steer(message)
    } catch (err) {
      stopEntry(entry.sessionId, 'send-failed')
      return
    }
    // Sent: stop timing. Wait for the next failure (escalate) or success (reset).
    clearTimer(entry)
    entry.phase = 'awaiting'
    entry.startedAt = null
    entry.remainingMs = null
    // 「繼續」 is now in the inbox ahead of everything else: `claim()` drains the
    // whole next-step list before it touches next-turn, and the steer above put
    // 「繼續」 in next-step. So the queue held back during the countdown can
    // return to its ORIGINAL positions right now — behind 「繼續」, FIFO — instead
    // of staying invisible in memory until the streak ends (which is what made
    // queued work look like it had vanished).
    releaseHeld(entry)
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
      entry.cooling = false // a non-429 failure leaves cooldown: back to the normal schedule
      entry.failures += 1
      entry.lastTurn = turn != null ? turn : entry.lastTurn
      entry.reason = errorText || reason || entry.reason || 'error'
      entry.paused = false
      entry.pausedRemainingMs = null
      entry.phase = 'counting'
      entry.remainingMs = delayFor(entry.failures)
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
      remainingMs: delayFor(0),
      timerId: null,
      stopped: false,
      stopReason: null,
      phase: 'counting',
      cooling: false,
      holding: false,
      heldMessages: [],
    }
    sessions.set(id, entry)
    arm(entry)
  }

  // ---- events ----
  ctx.on('session/event', (session, event) => {
    if (!config.enabled) return
    if (!event || event.type !== 'turn/end') return
    const reason = event.data && event.data.reason
    const id = session && session.id
    if (!reason || !id) return
    const turn = event.data.turn
    const action = classifyStop(reason.kind)
    if (action === 'failure') {
      // API 429 (rate limit) switches the streak to cooldown mode: a long
      // fixed interval instead of the escalating schedule, so the provider
      // can cool down while the loop keeps making sparse progress.
      if (isRateLimited(reason.error)) {
        onRateLimited(id, turn)
        return
      }
      onFailure(id, turn, reason.kind, errorTextOf(reason.error || reason.kind))
    } else if (action === 'reset') {
      const entry = sessions.get(String(id))
      // Only 'completed' needs the empty-boundary guard: a content-less
      // completed boundary (nothing claimed, no output, no usage) is a
      // scheduler artifact, not a success, so keep waiting. An 'aborted'
      // turn is always a real cancellation — always stop, no guard.
      if (reason.kind === 'completed' && entry && entry.holding && !boundaryHasContent(event)) return
      stopEntry(String(id), reason.kind === 'completed' ? 'completed' : String(reason.kind))
    }
  })

  // A3 — "有輸出一律歸零": any assistant message (LLM output) resets the
  // streak, even if the surrounding turn later ends in error without output.
  ctx.on('session/event', (session, event) => {
    if (!config.enabled) return
    if (!event || event.type !== 'assistant/message') return
    const id = session && session.id
    if (id) stopEntry(String(id), 'output')
  })

  ctx.on('agent/error', (payload) => {
    if (!config.enabled) return
    const agent = payload && payload.agent
    const id = agent && agent.id
    if (!id) return
    if (isRateLimited(payload.error)) {
      onRateLimited(id, payload.turn)
      return
    }
    onFailure(id, payload.turn, 'error', errorTextOf(payload.error))
  })

  // Queue-hold: user prompts landing in a streak-active agent's inbox are
  // stashed immediately (see onInboxInserted above).
  ctx.on('agent/inbox/inserted', onInboxInserted)

  // A claimed user message ends the streak as a takeover — EXCEPT one we
  // restored from our own hold queue: running previously-queued work is not
  // the human taking the wheel. (Fresh typed prompts already stopped the
  // streak at insert time; this listener also catches messages that reach the
  // transcript without an inbox insert.)
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    const msg = event.data
    if (msg == null || typeof msg !== 'object') return
    // Consume the restore mark for EVERY claimed message, including source-less
    // ones: leaving it set would leak into the bounded id set and evict marks
    // for messages that are still pending.
    const restored = consumeRestored(msg)
    const src = msg.source
    if (src && src.kind === 'user') {
      const id = session && session.id
      if (!id) return
      if (restored) return
      stopEntry(String(id), 'user-takeover')
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
      cooling: !!e.cooling,
      heldCount: Array.isArray(e.heldMessages) ? e.heldMessages.length : 0,
    }
  }

  function snapshotConfig() {
    return {
      enabled: config.enabled,
      continueText: config.continueText,
      retryIntervalsMinutes: config.retryIntervalsMinutes.slice(),
      capEnabled: config.capEnabled,
      capHours: config.capHours,
      cooldownMinutes: config.cooldownMinutes,
    }
  }

  async function persist() {
    const settings = ctx.get('settings')
    if (settings && typeof settings.replace === 'function') {
      await settings.replace(SETTINGS_NS, {
        enabled: config.enabled,
        continueText: config.continueText,
        retryIntervalsMinutes: config.retryIntervalsMinutes.slice(),
        capEnabled: config.capEnabled,
        capHours: config.capHours,
        cooldownMinutes: config.cooldownMinutes,
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
      if (typeof p.cooldownMinutes === 'number' && p.cooldownMinutes > 0) next.cooldownMinutes = p.cooldownMinutes
      if (typeof p.retryIntervals === 'string') {
        const arr = p.retryIntervals.split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0)
        if (arr.length > 0) next.retryIntervalsMinutes = arr
      } else if (Array.isArray(p.retryIntervalsMinutes)) {
        // Coerce first: the RPC surface may deliver numbers as strings.
        const arr = p.retryIntervalsMinutes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        if (arr.length > 0) next.retryIntervalsMinutes = arr
      }
      config = normalizeConfig(next)
      await persist()
      if (config.enabled === false) {
        for (const id of Array.from(sessions.keys())) stopEntry(id, 'disabled')
      } else {
        for (const e of sessions.values()) {
          // A text/interval change applies to already-armed streaks too, so the
          // next send uses what the settings page currently shows.
          e.text = config.continueText
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
      e.remainingMs = e.pausedRemainingMs != null ? e.pausedRemainingMs : nextDelayFor(e)
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
