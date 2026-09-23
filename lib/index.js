// dsh-plugin-fallback-continue — host half.
//
// Watches session turns for failures and, in unattended operation, drives a
// "continue" fallback loop:
//   - A turn ending in `error` (the red "本輪運行失敗") starts or continues a streak.
//   - A countdown arms; when it expires it sends the configured text once and
//     then STOPS timing — it waits for the model's next outcome.
//   - If the next turn errors again, the streak escalates (next interval) and
//     arms a new countdown.
//   - If a turn completes, the streak resets to the beginning.
//   - While a streak is active, queued user prompts are HELD OUT of the agent
//     inbox so nothing runs ahead of 「繼續」; they go straight back (FIFO,
//     behind the priority-steered 「繼續」) the moment it is sent, and again on
//     any other exit from the loop (see lib/controller.js).
//   - A turn ending in `max-tokens` (answer truncated at the output-token
//     limit, orange banner in the UI) also arms the loop: the model still has
//     more to say, so 「繼續」 is sent on the same escalating schedule.
//   - When the elapsed time since the first failure exceeds the configured cap
//     (default 24h), the loop stops after writing a durable notice into the
//     session transcript, so the user can see why unattended progress ended.
//
// The controller (state machine + event wiring) lives in lib/controller.js;
// this file wires the Typert `fallbackContinue` Remote service around it.
//
// Settings persist through the `settings` service (namespace `fallback-continue`),
// so the enable toggle and intervals survive a `dsh web` restart.
//
// Client -> host calls ride the generic Connection RPC channel
// (`/api/fallbackContinue/*`), dispatched by the Typert gateway to the
// `fallbackContinue` Remote service below.

import { createRequire } from 'node:module'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { createController, SETTINGS_NS } from './controller.js'
import { DEFAULTS, normalizeConfig, intervalFor, capStopText, rateLimitedText, formatStopTime, overCap, remainingMs, errorTextOf, classifyStop, isRateLimited, boundaryHasContent, isUserAuthored } from './pure.js'

export { normalizeConfig, intervalFor, DEFAULTS, capStopText, rateLimitedText, formatStopTime, overCap, remainingMs, errorTextOf, classifyStop, isRateLimited, boundaryHasContent, isUserAuthored, SETTINGS_NS }

export const name = 'dsh-plugin-fallback-continue'
export const inject = ['agents']

// Single source of truth for the version: package.json.
const require = createRequire(import.meta.url)
const VERSION = require('../package.json').version

// index.js re-exports the pure helpers so callers import one place; the tests
// exercise ./pure.js and ./controller.js directly.

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

export function apply(ctx) {
  const ctrl = createController(ctx, { z, version: VERSION })
  // Constructing the service registers it on this fiber's context; the Typert
  // gateway discovers it through the cordis reflect tree and serves the
  // `fallbackContinue/*` endpoints to the browser half.
  new FallbackContinueService(ctx, ctrl)
}
