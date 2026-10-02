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
// this file declares the plugin's Config schema and wires the Typert
// `fallbackContinue` Remote service around it.
//
// Configuration (v1.11.0)
// ------------------------
// Settings are ordinary DSH plugin Config declared as VOLATILE fields, so DSH
// owns them end to end:
//   - `Config` below is the single schema. The `settings` service projects its
//     volatile fields into a form, and the browser half edits them through
//     `ctx.configForms.get(SETTINGS_NS)`.
//   - Writes land in the profile's `cordis.patch.yml` and are committed into the
//     running references by the Loader, so a change takes effect WITHOUT
//     remounting this plugin — in-flight countdowns and held queues survive an
//     edit from the settings page.
//   - `SETTINGS_NS` must equal this plugin's profile entry id in
//     `cordis.patch.yml` (`id: fallback-continue`); that id is the namespace
//     both the settings service and `configForms` address.
//   - `settings.configure({ auto: false }, ctx.fiber)` marks that this plugin
//     ships its own settings page, so DSH does not also auto-generate one.
//
// Client -> host session calls ride the generic Connection RPC channel
// (`/api/fallbackContinue/*`), dispatched by the Typert gateway to the
// `fallbackContinue` Remote service below. Configuration no longer travels this
// path; it rides the settings service.

import { createRequire } from 'node:module'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { createController } from './controller.js'
import { configSchema, CONFIG_FIELDS, SETTINGS_NS } from './config.js'
import { DEFAULTS, normalizeConfig, intervalFor, capStopText, rateLimitedText, formatStopTime, overCap, remainingMs, errorTextOf, classifyStop, isRateLimited, boundaryHasContent, isUserAuthored } from './pure.js'

export { normalizeConfig, intervalFor, DEFAULTS, capStopText, rateLimitedText, formatStopTime, overCap, remainingMs, errorTextOf, classifyStop, isRateLimited, boundaryHasContent, isUserAuthored, SETTINGS_NS, CONFIG_FIELDS }

export const name = 'dsh-plugin-fallback-continue'
export const inject = ['agents']

// Single source of truth for the version: package.json.
const require = createRequire(import.meta.url)
const VERSION = require('../package.json').version

/**
 * Live plugin configuration.
 *
 * The schema itself lives in lib/config.js (dependency-free, unit-tested); see
 * there for why every field is volatile and what that buys.
 */
export const Config = configSchema(z)

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
  pause(sessionId) { return this.ctrl.pause(sessionId) }
  resume(sessionId) { return this.ctrl.resume(sessionId) }
  retryNow(sessionId) { return this.ctrl.retryNow(sessionId) }
  cancel(sessionId) { return this.ctrl.cancel(sessionId) }
}

export function apply(ctx, config) {
  // Configuration arrives as the Loader-parsed Config: one reference per
  // declared field, read with `.get()`. The controller re-reads it whenever the
  // Loader commits a volatile change, so the running loop always matches the
  // page.
  //
  // `config` is the documented channel (see dsh-client-ui-theme, which reads
  // `config.preference.get()` the same way), but fall back to a context-exposed
  // `ctx.config` when a loader passes it there instead, and finally to nothing
  // — the controller then normalizes DEFAULTS rather than throwing, so an
  // unexpected loader shape degrades to "disabled with defaults" instead of
  // taking the plugin down.
  const refs = config !== undefined && config !== null
    ? config
    : (ctx && ctx.config !== undefined ? ctx.config : undefined)
  const ctrl = createController(ctx, { config: refs, version: VERSION })
  // Constructing the service registers it on this fiber's context; the Typert
  // gateway discovers it through the cordis reflect tree and serves the
  // `fallbackContinue/*` endpoints to the browser half.
  new FallbackContinueService(ctx, ctrl)
}
