// dsh-plugin-fallback-continue — client half smoke/regression tests.
//
// The browser half is a `window.__ModuleLoader__` bundle with no bundler, so it
// cannot be imported as a module. This harness evaluates the real source with a
// stub `window` + `require('react')`, drives `apply()` against a fake slots
// service, and renders the REAL registered Pill component. It locks in the
// DSH 0.2 sessions-store contract: `SessionListState` has no `current` field,
// the active conversation is the row retained by `mainView`. When the pill
// resolved `s.current` it rendered nothing, so retry pause/cancel was only
// reachable from the settings page.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT_SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(init) { return [init, () => {}] },
    // Effects run synchronously so one render is enough to wire the poll.
    useEffect(effect) { effect(); return undefined },
    useRef(value) { return { current: value } },
    useMemo(factory) { return factory() },
    useLayoutEffect() {},
  }
}

// Load the real bundle and capture its factory definition.
function loadBundle() {
  let definition = null
  const window = { __ModuleLoader__: { load(def) { definition = def } } }
  const React = makeReact()
  const require = (name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', CLIENT_SRC)(window)
  assert.ok(definition, 'the bundle must call window.__ModuleLoader__.load')
  return { exports: definition.factory(require), React }
}

// Minimal host services `apply()` injects, capturing slot registrations.
function makeCtx({ getState }) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'connection') return { rpc: { call: async () => ({ ok: true, value: getState() }) } }
      if (name === 'configForms') return {
        get: () => ({
          subscribe() {},
          getSnapshot: () => ({
            status: 'ready',
            value: { enabled: true, continueText: '繼續', retryIntervalsMinutes: [5], capEnabled: true, capHours: 24, cooldownMinutes: 720 },
            writable: true,
          }),
        }),
      }
      if (name === 'slots') return {
        inject(slot, callback) { callback() },
        register(options, component) { registered.push({ options, component }) },
      }
      return undefined
    },
    effect(fn) { return fn() },
    on() {},
  }
  return { ctx, registered }
}

const TICK = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the floating pill renders for the main-view session in DSH 0.2', async (t) => {
  // subscribePoll arms a real interval; stub it so the test process can exit.
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  t.after(() => {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  })

  const { exports, React } = loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'connection', 'remote', 'configForms'])

  const { ctx, registered } = makeCtx({
    getState: () => ({
      version: 'test',
      config: { enabled: true, continueText: '繼續', retryIntervalsMinutes: [5], capEnabled: true, capHours: 24, cooldownMinutes: 720 },
      sessions: [{ sessionId: 's1', failures: 0, phase: 'counting', remainingMs: 65000, paused: false, heldCount: 0, text: '繼續' }],
    }),
  })
  exports.apply(ctx)

  const pill = registered.find((r) => r.options.id === 'fallback-continue-pill')
  assert.ok(pill, 'the pill must register into shell.overlay')

  // DSH 0.2 session-list snapshot: NO `current`; the open session is the row
  // retained by the main view.
  const listState = {
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1', displayTitle: 'open', blank: false, retainedBy: { mainView: 1 } },
      s2: { id: 's2', displayTitle: 'other', blank: false, retainedBy: {} },
    },
  }
  const useSessions = (selector) => selector(listState)

  // First render wires the poll; the RPC resolves on the next tick.
  pill.component({ useSessions })
  await TICK()
  await TICK()
  const tree = pill.component({ useSessions })

  assert.ok(tree, 'the pill must render while its session retries')
  assert.match(JSON.stringify(tree), /fbc-pill/)
  assert.match(JSON.stringify(tree.children), /⏳/)
  assert.match(JSON.stringify(tree.children), /繼續/)
})

test('the current-session selector prefers the legacy `current` field when present', async (t) => {
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  t.after(() => { globalThis.setInterval = realSetInterval })

  const { exports } = loadBundle()
  const { ctx, registered } = makeCtx({
    getState: () => ({
      version: 'test',
      sessions: [{ sessionId: 's9', failures: 0, phase: 'awaiting', remainingMs: null, paused: false, heldCount: 0, text: '繼續' }],
    }),
  })
  exports.apply(ctx)
  const pill = registered.find((r) => r.options.id === 'fallback-continue-pill')

  // Legacy host shape: `current` is a plain id.
  const useSessions = (selector) => selector({ current: 's9', byId: { s9: { id: 's9', retainedBy: {} } } })
  pill.component({ useSessions })
  await TICK()
  await TICK()
  const tree = pill.component({ useSessions })
  assert.ok(tree, 'legacy current still resolves the session')
  assert.match(JSON.stringify(tree.children), /已送出/)
})
