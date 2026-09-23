// dsh-plugin-fallback-continue — controller unit tests (node:test).
//
// Covers the queued-prompt holding behavior:
//   - prompts already queued when the streak arms (or source-less ones
//     landing later) are stashed, never claimed ahead of 「繼續」;
//   - a message TYPED by the user during the streak is an explicit takeover:
//     the streak stops, held prompts are released, and the typed message
//     runs — it is never swallowed silently;
//   - 「繼續」 is steered with the queue empty, and nothing is released early;
//   - held prompts return FIFO only after a real completed turn (and never
//     after a content-less completed boundary);
//   - a blocked turn re-arms the streak (no wedge) and an aborted turn stops
//     the loop;
//   - any other exit (cancel, user takeover, disable, ...) still releases
//     them so user input is never lost, while archive keeps them dropped.

import test from 'node:test'
import assert from 'node:assert/strict'

import * as pure from '../lib/pure.js'
import { createController } from '../lib/controller.js'

// ---------------------------------------------------------------- harness

function makeMsg(text, kind = 'user') {
  return {
    id: 'm-' + text + '-' + Math.floor(Math.random() * 1e9).toString(36),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, plugin: kind === 'user' ? undefined : 'some-plugin' },
  }
}

// A message with no `source` at all (untyped/programmatic origin): the only
// kind the insert-time hold still stashes, since a typed user message is now
// treated as an explicit takeover.
function makeNoSourceMsg(text) {
  return {
    id: 'm0-' + text + '-' + Math.floor(Math.random() * 1e9).toString(36),
    role: 'user',
    content: [{ type: 'text', text }],
  }
}

// A minimal fake agent: an inbox with nextTurn/nextStep lists plus
// remove/append/steer/followup recording. When `ctx` is given, steer and
// followup publish `agent/inbox/inserted` synchronously — exactly like the
// real durable inbox, whose splice emits the event during the send itself.
function makeAgent(id, ctx) {
  const agent = {
    id,
    inbox: { nextTurn: [], nextStep: [] },
    session: { append(type, msg) { agent.appended.push({ type, msg }) } },
    appended: [],
    steered: [],
    followed: [],
  }
  agent.inbox.remove = (mid) => {
    for (const key of ['nextTurn', 'nextStep']) {
      const i = agent.inbox[key].findIndex((m) => m && m.id === mid)
      if (i >= 0) { agent.inbox[key].splice(i, 1); return }
    }
  }
  const publish = (m) => { if (ctx) ctx.emit('agent/inbox/inserted', { agent, message: m }) }
  agent.steer = (m) => { agent.inbox.nextStep.push(m); agent.steered.push(m); publish(m) }
  agent.followup = (m) => { agent.inbox.nextTurn.push(m); agent.followed.push(m); publish(m) }
  agent.session.id = id
  return agent
}

function makeCtx() {
  const listeners = new Map()
  const ctx = {
    agents: { get: (id) => ctx.agentMap.get(String(id)) },
    agentMap: new Map(),
    getters: {},
    get(key) { return ctx.getters[key] },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) || []) fn(...args)
    },
    inject() {},
    effect() { return () => {} },
  }
  return ctx
}

function makeCtrl({ enabled = true, intervals = [0.02], getters = {} } = {}) {
  const ctx = makeCtx()
  ctx.getters = getters
  const ctrl = createController(ctx, { version: 'test' })
  ctx.ctrl = ctrl
  ctx.updateConfig = (patch) => ctrl.updateConfig(patch)
  if (enabled) ctx.updateConfig({ enabled: true, retryIntervalsMinutes: intervals })
  return ctx
}

const turnEnd = (id, turn, kind, data = {}) => ({ type: 'turn/end', id, data: { turn, reason: { kind }, ...data } })

// ---------------------------------------------------------------- pure helper

test('boundaryHasContent: real work counts as content, empty boundary does not', () => {
  assert.equal(pure.boundaryHasContent(turnEnd('s', 1, 'completed', { messages: [makeMsg('x')] })), true)
  assert.equal(pure.boundaryHasContent(turnEnd('s', 1, 'completed', { steps: 2 })), true)
  assert.equal(pure.boundaryHasContent(turnEnd('s', 1, 'completed', { usage: { totalTokens: 12 } })), true)
  assert.equal(pure.boundaryHasContent(turnEnd('s', 1, 'completed', { hadStep: true })), true)
  assert.equal(pure.boundaryHasContent(turnEnd('s', 1, 'completed')), false)
  assert.equal(pure.boundaryHasContent(turnEnd('s', 1, 'completed', { messages: [] })), false)
  assert.equal(pure.boundaryHasContent(turnEnd('s', 1, 'completed', { usage: { totalTokens: 0 } })), false)
  // Unknown shapes are assumed to have content (over-inclusive on purpose).
  assert.equal(pure.boundaryHasContent(null), true)
  assert.equal(pure.boundaryHasContent({ data: 'weird' }), true)
})

// ---------------------------------------------------------------- holding

test('a message typed while counting takes over: streak stops, message runs', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)

  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error')) // arm streak
  // An untyped message arrived first and is held (kept out of the inbox).
  const old = makeNoSourceMsg('old queued')
  ctx.emit('agent/inbox/inserted', { agent, message: old })
  assert.equal(ctx.ctrl.getState().sessions[0].heldCount, 1)

  // The prompt RPC inserts the typed message into the inbox BEFORE the
  // inserted event fires — model it exactly like the real harness.
  const typed = makeMsg('I will take it from here')
  agent.inbox.nextTurn.push(typed)
  ctx.emit('agent/inbox/inserted', { agent, message: typed })

  assert.equal(ctx.ctrl.getState().sessions.length, 0, 'user takeover stops the streak')
  // The typed message stays claimable (runs first), and the previously held
  // prompt is re-queued behind it — never swallowed, never lost.
  assert.deepEqual(agent.inbox.nextTurn, [typed, old])
  assert.deepEqual(agent.followed, [old], 'held prompts are released on takeover')
  assert.equal(agent.steered.length, 0)
})

test('a message typed while paused also takes over (pause = manual mode)', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.ctrl.pause('s1')
  assert.equal(ctx.ctrl.getState().sessions[0].paused, true)

  const typed = makeMsg('manual control')
  agent.inbox.nextTurn.push(typed)
  ctx.emit('agent/inbox/inserted', { agent, message: typed })
  assert.equal(ctx.ctrl.getState().sessions.length, 0, 'paused streak ends on typed input')
  assert.deepEqual(agent.inbox.nextTurn, [typed])
})

test('non-user (plugin) messages are not held', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))

  // Insert first (like the real harness), then notify.
  const plug = makeMsg('internal', 'plugin')
  agent.inbox.nextTurn.push(plug)
  ctx.emit('agent/inbox/inserted', { agent, message: plug })
  assert.equal(agent.inbox.nextTurn.length, 1, 'plugin messages keep normal inbox semantics')
  assert.equal(ctx.ctrl.getState().sessions[0].heldCount, 0)
})

test('inserted hold does nothing without an active streak or when disabled', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)

  // No streak: prompt stays.
  agent.inbox.nextTurn.push(makeMsg('a'))
  ctx.emit('agent/inbox/inserted', { agent, message: agent.inbox.nextTurn[0] })
  assert.equal(agent.inbox.nextTurn.length, 1)

  // Streak, but plugin disabled: prompt stays.
  await ctx.updateConfig({ enabled: false })
  const b = makeMsg('b')
  agent.inbox.nextTurn.push(b)
  ctx.emit('agent/inbox/inserted', { agent, message: b })
  assert.equal(agent.inbox.nextTurn.length, 2)
})

test('arming the streak sweeps already-queued prompts out of the inbox', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  const q1 = makeMsg('queued 1')
  const q2 = makeMsg('queued 2')
  agent.inbox.nextTurn.push(q1, q2)

  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  assert.deepEqual(agent.inbox.nextTurn, [], 'queue must be swept when the streak arms')
  const st = ctx.ctrl.getState().sessions[0]
  assert.equal(st.heldCount, 2, 'both prompts held (snapshot iteration must not skip)')
})

// ---------------------------------------------------------------- firing

test('fire steers 「繼續」 first, then restores the queued tasks in order', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  const a = makeMsg('queued A')
  const b = makeMsg('queued B')
  agent.inbox.nextTurn.push(a, b)

  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  assert.equal(agent.inbox.nextTurn.length, 0, 'queue is held while the countdown runs')

  // Fire deterministically through the RPC surface instead of waiting out the
  // (short) configured countdown.
  ctx.ctrl.retryNow('s1')
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].content[0].text, '繼續')
  // 「繼續」 lives in next-step, which the driver claims BEFORE next-turn, so the
  // held tasks can go straight back to the queue behind it — in their original
  // order — instead of vanishing until the streak ends.
  assert.deepEqual(agent.inbox.nextStep, [agent.steered[0]], '「繼續」 is the priority input')
  assert.deepEqual(agent.inbox.nextTurn, [a, b], 'queued tasks restored FIFO behind 「繼續」')
  assert.deepEqual(agent.followed, [a, b], 'restored via followup, in order')
  assert.equal(ctx.ctrl.getState().sessions[0].phase, 'awaiting')
  assert.equal(ctx.ctrl.getState().sessions[0].heldCount, 0, 'nothing stays hidden in memory')
})

test('「繼續」 is claimed first and alone, then the restored tasks resume in order', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  agent.inbox.nextTurn.push(makeMsg('queued A'), makeMsg('queued B'))
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))

  // An idle driver wakes INSIDE steer() and synchronously claims at the turn
  // boundary (all of next-step, then one next-turn — harness claim() order)
  // BEFORE fire() restores the held queue. Capture what was claimable then.
  const steer = agent.steer
  let claimedAtSteer = null
  agent.steer = (m) => {
    steer(m)
    const step = agent.inbox.nextStep.splice(0, agent.inbox.nextStep.length)
    const turn = agent.inbox.nextTurn.splice(0, 1)
    claimedAtSteer = [...step, ...turn]
  }

  ctx.ctrl.retryNow('s1')

  // The held tasks were still out of the inbox when the driver woke, so
  // 「繼續」 was the only thing claimable — nothing rides along ahead of it.
  assert.deepEqual(claimedAtSteer.map((m) => m.content[0].text), ['繼續'])
  // …and they are back in the queue, in original order, for the turns after it.
  assert.deepEqual(agent.inbox.nextTurn.map((m) => m.content[0].text), ['queued A', 'queued B'])
  assert.equal(ctx.ctrl.getState().sessions[0].heldCount, 0, 'nothing stays hidden in memory')
})

test('restoring the queue after 「繼續」 is not a takeover (streak survives)', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  // A USER-typed task queued before the failure: releaseHeld re-inserts it
  // via followup, and the durable inbox publishes `agent/inbox/inserted`
  // synchronously. Without the restore guard that insert reads as a fresh
  // takeover and kills the streak right after every 「繼續」.
  const a = makeMsg('queued A')
  agent.inbox.nextTurn.push(a)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.ctrl.retryNow('s1')

  const st = ctx.ctrl.getState().sessions[0]
  assert.ok(st, 'the streak must survive restoring its own queue')
  assert.equal(st.phase, 'awaiting')
  assert.equal(st.heldCount, 0)
  assert.deepEqual(agent.inbox.nextTurn, [a], 'task is back in the queue, in order')
})

test('a restored task claimed later runs without killing the streak', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  const a = makeMsg('queued A')
  agent.inbox.nextTurn.push(a)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.ctrl.retryNow('s1') // 「繼續」 steered; A restored to next-turn

  // The driver claims A at a later turn boundary and appends it to the log.
  ctx.emit('session/event', agent.session, { type: 'user/message', data: a })
  assert.equal(ctx.ctrl.getState().sessions.length, 1, 'old queued work running is not a takeover')
  assert.equal(ctx.ctrl.getState().sessions[0].phase, 'awaiting')

  // Contrast: a genuinely fresh user message on the transcript still stops it.
  ctx.emit('session/event', agent.session, { type: 'user/message', data: { id: 'fresh', source: { kind: 'user' } } })
  assert.equal(ctx.ctrl.getState().sessions.length, 0, 'a fresh typed message is still a takeover')
})

test('failure while awaiting escalates and keeps holding', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.ctrl.retryNow('s1')

  const q = makeNoSourceMsg('still queued')
  ctx.emit('agent/inbox/inserted', { agent, message: q })
  assert.equal(agent.inbox.nextTurn.length, 0)

  ctx.emit('session/event', agent.session, turnEnd('s1', 2, 'error')) // turn 2 failed
  const st = ctx.ctrl.getState().sessions[0]
  assert.equal(st.failures, 1)
  assert.equal(st.phase, 'counting')
  assert.equal(st.heldCount, 1, 'prompt stays held across escalation')
})

// ---------------------------------------------------------------- release

test('a real completed turn releases held prompts FIFO via followup', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))

  const q1 = makeNoSourceMsg('first')
  const q2 = makeNoSourceMsg('second')
  ctx.emit('agent/inbox/inserted', { agent, message: q1 })
  ctx.emit('agent/inbox/inserted', { agent, message: q2 })

  ctx.emit('session/event', agent.session, turnEnd('s1', 2, 'completed', { usage: { totalTokens: 5 } }))
  const st = ctx.ctrl.getState()
  assert.equal(st.sessions.length, 0, 'streak resets')
  assert.deepEqual(agent.followed, [q1, q2], 'FIFO release, waking the driver once per message')
  assert.deepEqual(agent.inbox.nextTurn, [q1, q2])
})

test('a content-less completed boundary does NOT release held prompts', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeNoSourceMsg('held') })

  ctx.emit('session/event', agent.session, turnEnd('s1', 2, 'completed')) // empty boundary
  const st = ctx.ctrl.getState()
  assert.equal(st.sessions.length, 1, 'streak must stay armed')
  assert.equal(st.sessions[0].heldCount, 1)
  assert.equal(agent.followed.length, 0)
})

test('cancel / user takeover / disable release held prompts; archive drops them', async () => {
  // cancel
  let ctx = makeCtrl()
  let agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeNoSourceMsg('q') })
  ctx.ctrl.cancel('s1')
  assert.equal(agent.followed.length, 1, 'cancel re-queues the prompt')
  assert.equal(ctx.ctrl.getState().sessions.length, 0)

  // user takeover (a user message resets the loop)
  ctx = makeCtrl()
  agent = makeAgent('s2', ctx)
  ctx.agentMap.set('s2', agent)
  ctx.emit('session/event', agent.session, turnEnd('s2', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeNoSourceMsg('q') })
  ctx.emit('session/event', agent.session, { type: 'user/message', data: { id: 'u1', source: { kind: 'user' } } })
  assert.equal(agent.followed.length, 1)

  // disable from the settings page
  ctx = makeCtrl()
  agent = makeAgent('s3', ctx)
  ctx.agentMap.set('s3', agent)
  ctx.emit('session/event', agent.session, turnEnd('s3', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeNoSourceMsg('q') })
  await ctx.updateConfig({ enabled: false })
  assert.equal(agent.followed.length, 1)

  // archived: dropped, not released (registry present before controller creation)
  ctx = makeCtrl({ getters: { workspaceRegistry: { archivedSessionIds: ['s4'] } } })
  agent = makeAgent('s4', ctx)
  ctx.agentMap.set('s4', agent)
  ctx.emit('session/event', agent.session, turnEnd('s4', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeNoSourceMsg('q') })
  ctx.emit('domain/changed')
  assert.equal(ctx.ctrl.getState().sessions.length, 0)
  assert.equal(agent.followed.length, 0, 'archived sessions keep prompts cancelled')
})

test('assistant output while holding resets the streak and releases prompts (A3)', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeNoSourceMsg('q') })

  ctx.emit('session/event', agent.session, { type: 'assistant/message', data: {} })
  assert.equal(ctx.ctrl.getState().sessions.length, 0)
  assert.equal(agent.followed.length, 1, 'output means the model is producing again — queue may run')
})

test('max-tokens failures also hold the queue and steer on time', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'max-tokens'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeNoSourceMsg('q') })
  assert.equal(agent.inbox.nextTurn.length, 0)
  ctx.ctrl.retryNow('s1')
  assert.equal(agent.steered.length, 1)
})

test('an agent without inbox/remove falls back to old behavior without crashing', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  delete agent.inbox.remove
  ctx.agentMap.set('s1', agent)
  agent.inbox.nextTurn.push(makeMsg('q'))

  assert.doesNotThrow(() => ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error')))
  assert.equal(agent.inbox.nextTurn.length, 1, 'unholdable environment keeps the prompt pending')
  ctx.ctrl.retryNow('s1')
  assert.equal(agent.steered.length, 1, '「繼續」 still goes out')
})

test('an agent that disappears before firing stops cleanly', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.agentMap.delete('s1')
  ctx.ctrl.retryNow('s1')
  assert.equal(ctx.ctrl.getState().sessions.length, 0, 'entry removed with stop reason gone')
})

// ---------------------------------------------------------------- blocked / aborted

test('a blocked turn re-arms the streak instead of wedging in awaiting', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.ctrl.retryNow('s1') // 「繼續」 sent, phase 'awaiting'
  assert.equal(ctx.ctrl.getState().sessions[0].phase, 'awaiting')

  // A pre-step guard (capacity/rate limiter) rejects the claimed 「繼續」:
  // the turn ends 'blocked' with the input dropped. The streak must re-arm.
  ctx.emit('session/event', agent.session, turnEnd('s1', 2, 'blocked'))
  const st = ctx.ctrl.getState().sessions[0]
  assert.ok(st, 'streak must re-arm after a blocked turn — ignoring it would wedge awaiting forever')
  assert.equal(st.failures, 1)
  assert.equal(st.phase, 'counting')
})

test('an aborted turn stops the streak and releases held prompts', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1', ctx)
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeNoSourceMsg('q') })
  assert.equal(ctx.ctrl.getState().sessions[0].heldCount, 1)

  ctx.emit('session/event', agent.session, turnEnd('s1', 2, 'aborted'))
  assert.equal(ctx.ctrl.getState().sessions.length, 0, 'a cancelled turn ends the loop')
  assert.equal(agent.followed.length, 1, 'held prompts are released on abort')
})
