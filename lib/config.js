// dsh-plugin-fallback-continue — the plugin's live Config schema.
//
// Split out of lib/index.js so it can be unit-tested without the Host-only
// dependencies (`@deepseek-ai/dsh-typert-protocol`), and so there is exactly one
// definition of the settings surface: lib/index.js turns it into the exported
// `Config`, and lib/client.js renders those same field names.
//
// Why volatile
// ------------
// Every field is `.volatile()`. DSH's `settings` service projects ONLY volatile
// fields into an editable form (`volatileForm` in @deepseek-ai/dsh-settings), and
// the Loader commits a volatile change into the running references
// (`loader/volatile-update`) instead of remounting the plugin. That combination
// is what lets the settings page edit the toggle and the schedule while the
// unattended loop keeps its in-flight countdowns and held prompt queues.
//
// On an older Loader that does not know `volatile`, the flag is simply ignored:
// the same schema still validates and still applies, only the form projection is
// a 0.2+ feature.
//
// Defaults come from pure.js's DEFAULTS so the schema, the pure normalizer, and
// the tests cannot drift apart.

import { DEFAULTS } from './pure.js'

/**
 * Build the plugin's Config schema.
 * @param {*} z - the schemastery module, injected so this file stays free of
 *   runtime dependencies and directly unit-testable.
 * @returns The Config schema object.
 */
export function configSchema(z) {
  return z.object({
    enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
    continueText: z.string().default(DEFAULTS.continueText).volatile(),
    retryIntervalsMinutes: z.array(z.number()).default(DEFAULTS.retryIntervalsMinutes.slice()).volatile(),
    capEnabled: z.boolean().default(DEFAULTS.capEnabled).volatile(),
    capHours: z.number().default(DEFAULTS.capHours).volatile(),
    cooldownMinutes: z.number().default(DEFAULTS.cooldownMinutes).volatile(),
  })
}

/**
 * The Config field names, in schema order. The client half mirrors this list in
 * its form, and the tests assert the two stay in step.
 */
export const CONFIG_FIELDS = [
  'enabled',
  'continueText',
  'retryIntervalsMinutes',
  'capEnabled',
  'capHours',
  'cooldownMinutes',
]

/**
 * Settings namespace. MUST equal this plugin's profile entry id in
 * `cordis.patch.yml` (`id: fallback-continue`): DSH keys every settings form by
 * that entry id, and the browser half addresses the same string through
 * `ctx.configForms.get(...)`.
 */
export const SETTINGS_NS = 'fallback-continue'
