// dsh-plugin-fallback-continue — controller unit tests (node:test).
//
// Covers the queued-prompt holding behavior:
//   - prompts landing in the inbox while the streak is active are stashed,
//     never claimed ahead of 「繼續」;
//   - 「繼續」 is steered with the queue empty, and nothing is released early;
//   - held prompts return FIFO only after a real completed turn (and never
//     after a content-less completed boundary);
//   - any other exit (cancel, user takeover, disable, ...) still releases them
//     so user input is never lost, while archive keeps them dropped.

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

// A minimal fake agent: an inbox with nextTurn/nextStep lists plus
// remove/append/steer/followup recording.
function makeAgent(id) {
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
  agent.steer = (m) => { agent.inbox.nextStep.push(m); agent.steered.push(m) }
  agent.followup = (m) => { agent.inbox.nextTurn.push(m); agent.followed.push(m) }
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

test('a prompt inserted while counting is held, not left in the inbox', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)

  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error')) // arm streak
  const q = makeMsg('fix the tests')
  ctx.emit('agent/inbox/inserted', { agent, message: q })

  assert.deepEqual(agent.inbox.nextTurn, [], 'prompt must be removed from the inbox')
  assert.equal(agent.steered.length, 0)
  const st = ctx.ctrl.getState()
  assert.equal(st.sessions[0].heldCount, 1)
})

test('non-user (plugin) messages are not held', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1')
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
  const agent = makeAgent('s1')
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
  const agent = makeAgent('s1')
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

test('fire steers 「繼續」 with the queue held empty (no prompt runs ahead)', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)
  agent.inbox.nextTurn.push(makeMsg('queued early'))

  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  assert.equal(agent.inbox.nextTurn.length, 0)

  // Fire deterministically through the RPC surface instead of waiting out the
  // (short) configured countdown.
  ctx.ctrl.retryNow('s1')
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].content[0].text, '繼續')
  assert.equal(agent.inbox.nextTurn.length, 0, 'held prompts must NOT have been released by the steer')
  assert.equal(ctx.ctrl.getState().sessions[0].phase, 'awaiting')
})

test('failure while awaiting escalates and keeps holding', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.ctrl.retryNow('s1')

  const q = makeMsg('still queued')
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
  const agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))

  const q1 = makeMsg('first')
  const q2 = makeMsg('second')
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
  const agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeMsg('held') })

  ctx.emit('session/event', agent.session, turnEnd('s1', 2, 'completed')) // empty boundary
  const st = ctx.ctrl.getState()
  assert.equal(st.sessions.length, 1, 'streak must stay armed')
  assert.equal(st.sessions[0].heldCount, 1)
  assert.equal(agent.followed.length, 0)
})

test('cancel / user takeover / disable release held prompts; archive drops them', async () => {
  // cancel
  let ctx = makeCtrl()
  let agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeMsg('q') })
  ctx.ctrl.cancel('s1')
  assert.equal(agent.followed.length, 1, 'cancel re-queues the prompt')
  assert.equal(ctx.ctrl.getState().sessions.length, 0)

  // user takeover (a user message resets the loop)
  ctx = makeCtrl()
  agent = makeAgent('s2')
  ctx.agentMap.set('s2', agent)
  ctx.emit('session/event', agent.session, turnEnd('s2', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeMsg('q') })
  ctx.emit('session/event', agent.session, { type: 'user/message', data: { id: 'u1', source: { kind: 'user' } } })
  assert.equal(agent.followed.length, 1)

  // disable from the settings page
  ctx = makeCtrl()
  agent = makeAgent('s3')
  ctx.agentMap.set('s3', agent)
  ctx.emit('session/event', agent.session, turnEnd('s3', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeMsg('q') })
  await ctx.updateConfig({ enabled: false })
  assert.equal(agent.followed.length, 1)

  // archived: dropped, not released (registry present before controller creation)
  ctx = makeCtrl({ getters: { workspaceRegistry: { archivedSessionIds: ['s4'] } } })
  agent = makeAgent('s4')
  ctx.agentMap.set('s4', agent)
  ctx.emit('session/event', agent.session, turnEnd('s4', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeMsg('q') })
  ctx.emit('domain/changed')
  assert.equal(ctx.ctrl.getState().sessions.length, 0)
  assert.equal(agent.followed.length, 0, 'archived sessions keep prompts cancelled')
})

test('assistant output while holding resets the streak and releases prompts (A3)', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeMsg('q') })

  ctx.emit('session/event', agent.session, { type: 'assistant/message', data: {} })
  assert.equal(ctx.ctrl.getState().sessions.length, 0)
  assert.equal(agent.followed.length, 1, 'output means the model is producing again — queue may run')
})

test('max-tokens failures also hold the queue and steer on time', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'max-tokens'))
  ctx.emit('agent/inbox/inserted', { agent, message: makeMsg('q') })
  assert.equal(agent.inbox.nextTurn.length, 0)
  ctx.ctrl.retryNow('s1')
  assert.equal(agent.steered.length, 1)
})

test('an agent without inbox/remove falls back to old behavior without crashing', async () => {
  const ctx = makeCtrl()
  const agent = makeAgent('s1')
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
  const agent = makeAgent('s1')
  ctx.agentMap.set('s1', agent)
  ctx.emit('session/event', agent.session, turnEnd('s1', 1, 'error'))
  ctx.agentMap.delete('s1')
  ctx.ctrl.retryNow('s1')
  assert.equal(ctx.ctrl.getState().sessions.length, 0, 'entry removed with stop reason gone')
})
