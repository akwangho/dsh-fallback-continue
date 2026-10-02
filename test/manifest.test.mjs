// dsh-plugin-fallback-continue — manifest compatibility tests.
//
// Why this file exists
// --------------------
// DSH runs a "compatibility preflight" before it mounts any profile plugin row
// (dsh-app-boot: `prepareProfileEntries` -> `evaluatePluginCompatibility`). It
// reads our `peerDependencies` WITHOUT importing any plugin code and checks
// every peer whose name is `@deepseek-ai/dsh` or starts with `@deepseek-ai/dsh-`
// against the running DSH version. A single non-matching range DISABLES the
// whole row, prints one stderr line, and the plugin silently disappears from
// the UI:
//
//   dsh: disabling profile plugin row "fallback-continue": Plugin
//   dsh-plugin-fallback-continue@1.9.4 is incompatible with dsh 0.2.0-rc.2: ...
//
// That is exactly what happened on the 0.1 -> 0.2 upgrade, because the peers
// were pinned `^0.1.0-rc.6` and a caret on a 0.x version only admits 0.1.x.
//
// The preflight is DSH-side code we cannot import here, so these tests encode
// the same rule directly against our own package.json: a small comparator for
// the range forms we are allowed to use, plus the exact versions the plugin
// must keep working on.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// DSH runtimes this plugin must keep loading on. 0.1.x is where the plugin
// originated, 0.2.x is the version that exposed the bug, and 0.9.x stands in
// for "any later 0.x" — the reason the ranges must span the whole 0.x line.
const SUPPORTED_DSH = ['0.1.0-rc.6', '0.1.0-rc.8', '0.2.0-rc.2', '0.2.0', '0.3.0-rc.1', '0.9.9']
// A 1.0 DSH is a real breaking release; a plugin must NOT silently claim it.
const UNSUPPORTED_DSH = ['1.0.0', '2.0.0']

// ------------------------------------------------------------------ comparator

// Minimal semver range check for the two shapes the peers are allowed to use:
// `*`, and a comparator set of `>=X` / `<X` clauses. Enough to prove the
// property that matters without pulling a semver dependency into a package
// that ships no runtime dependencies.
const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  assert.ok(m, `test bug: unparseable version ${JSON.stringify(v)}`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] }
}

const compare = (a, b) => {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1
  }
  // A prerelease sorts BELOW its release, matching semver.
  if (x.pre === undefined && y.pre === undefined) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  return x.pre < y.pre ? -1 : x.pre > y.pre ? 1 : 0
}

const satisfies = (version, range) => {
  const r = String(range).trim()
  if (r === '' || r === '*') return true
  for (const clause of r.split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?\s*(\S+)$/.exec(clause)
    assert.ok(m, `test bug: unparseable range clause ${JSON.stringify(clause)} in ${JSON.stringify(range)}`)
    const [, op, target] = m
    const cmp = compare(version, target)
    if (op === '>=' && !(cmp >= 0)) return false
    if (op === '>' && !(cmp > 0)) return false
    if (op === '<=' && !(cmp <= 0)) return false
    if (op === '<' && !(cmp < 0)) return false
    if ((op === '=' || op === undefined) && cmp !== 0) return false
  }
  return true
}

// ------------------------------------------------------------- the DSH rule

// Mirrors evaluatePluginCompatibility's filter: only these peer names are
// checked against the runtime, so only these can disable the row.
const isCheckedPeer = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

const dshPeers = Object.entries(manifest.peerDependencies || {}).filter(([name]) => isCheckedPeer(name))

// --------------------------------------------------------------------- tests

test('the manifest declares DSH peer dependencies for the preflight to check', () => {
  // If this ever goes empty the preflight has nothing to validate, which would
  // silently change the meaning of the tests below.
  assert.ok(dshPeers.length > 0, 'no @deepseek-ai/dsh-* peerDependencies found')
  for (const [name, range] of dshPeers) {
    assert.equal(typeof range, 'string', `${name} range must be a string`)
  }
})

test('every DSH peer range accepts every supported dsh runtime', () => {
  for (const [name, range] of dshPeers) {
    for (const runtime of SUPPORTED_DSH) {
      assert.equal(
        satisfies(runtime, range), true,
        `${name}@${range} would DISABLE this plugin on dsh ${runtime}`,
      )
    }
  }
})

test('DSH peer ranges do not silently claim dsh 1.x', () => {
  for (const [name, range] of dshPeers) {
    for (const runtime of UNSUPPORTED_DSH) {
      assert.equal(
        satisfies(runtime, range), false,
        `${name}@${range} claims dsh ${runtime}; a 1.x DSH needs an explicit audit`,
      )
    }
  }
})

test('no DSH peer uses a caret/tilde pin, which breaks on the next 0.x minor', () => {
  // The original bug: `^0.1.0-rc.6` admits only 0.1.x, so upgrading DSH to
  // 0.2.x disabled the row. Any caret/tilde on a 0.x version has this shape.
  for (const [name, range] of dshPeers) {
    assert.doesNotMatch(
      range, /[\^~]/,
      `${name}@${range} pins a single 0.x minor; use an explicit range such as ">=0.1.0-rc.6 <1.0.0" instead`,
    )
  }
})

test('the manifest version and the package-lock version agree', () => {
  let lock
  try {
    lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
  } catch {
    return // no lock file committed; nothing to cross-check
  }
  assert.equal(lock.version, manifest.version, 'package-lock.json is out of sync with package.json')
  assert.equal(lock.packages[''].version, manifest.version, 'package-lock.json root version is out of sync')
})

test('engines.dsh agrees with the DSH peer floor', () => {
  assert.equal(typeof manifest.engines.dsh, 'string', 'engines.dsh should document the supported DSH line')
  for (const [name, range] of dshPeers) {
    const floor = />=\s*(\S+)/.exec(range)
    assert.ok(floor, `${name}@${range} should declare an explicit lower bound`)
    assert.equal(
      satisfies(floor[1], manifest.engines.dsh), true,
      `engines.dsh ${manifest.engines.dsh} excludes this plugin's own floor ${floor[1]} (${name})`,
    )
  }
})

// ------------------------------------------------- client manifest declaration

test('dsh.client.inject names only packages that still exist in DSH', () => {
  // `@deepseek-ai/dsh-client-runtime` was removed in the 0.2 line. Naming a
  // package that cannot be resolved makes the boot graph carry a dead edge.
  const inject = (manifest.dsh && manifest.dsh.client && manifest.dsh.client.inject) || []
  assert.ok(Array.isArray(inject), 'dsh.client.inject must be an array')
  assert.deepEqual(
    inject.filter((name) => name === '@deepseek-ai/dsh-client-runtime'),
    [],
    '@deepseek-ai/dsh-client-runtime no longer exists; drop it from dsh.client.inject',
  )
  for (const name of inject) {
    assert.equal(typeof name, 'string')
  }
})

test('dsh.client declares the web platform and a ./client export', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
})

// ------------------------------------------------------- display metadata

test('locale/en.json exists and is exported, so the Plugins list can name it', () => {
  // readPluginMeta resolves `<pkg>/locale/en.json` through the package
  // `exports` map. Without the `./locale/*` export entry the subpath is
  // blocked and the plugin falls back to showing its raw npm name.
  assert.equal(manifest.exports['./locale/*'], './locale/*', 'exports must expose ./locale/* for readPluginMeta')
  assert.ok(manifest.files.includes('locale'), 'files must ship locale/')

  const en = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
  assert.equal(typeof en.meta.title, 'string')
  assert.ok(en.meta.title.length > 0, 'meta.title must be a non-empty string')
  assert.equal(typeof en.meta.description, 'string')
  assert.ok(en.meta.description.length > 0, 'meta.description must be a non-empty string')

  const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
  assert.equal(typeof zh.meta.title, 'string')
  assert.ok(zh.meta.title.length > 0)
})

// ------------------------------------------------- volatile Config declaration

test('the host half exports a Config whose fields are all volatile', async () => {
  // DSH's settings service projects ONLY volatile fields into an editable form
  // (dsh-settings `volatileForm`). A non-volatile field would be validated and
  // persisted but could not be edited from this plugin's settings page, and an
  // ordinary field change would remount the plugin — discarding in-flight
  // countdowns and held prompt queues.
  const [{ configSchema }, z] = await Promise.all([
    import('../lib/config.js'),
    import('@deepseek-ai/schemastery'),
  ])
  const { CONFIG_FIELDS } = await import('../lib/config.js')
  const json = configSchema(z.default ?? z).toJSON()
  // Schemastery serializes to a ref table: the root object ref carries a `dict`
  // mapping each field name to its own ref id.
  const dict = json.refs[json.uid].dict
  assert.deepEqual(Object.keys(dict), CONFIG_FIELDS, 'Config fields drifted from CONFIG_FIELDS')
  for (const field of CONFIG_FIELDS) {
    const ref = json.refs[dict[field]]
    assert.ok(ref, `Config is missing the ${field} field`)
    assert.equal(ref.meta.volatile, true, `Config.${field} must be .volatile() to be editable and live`)
    assert.ok(ref.meta.default !== undefined, `Config.${field} must declare a default`)
  }
})

test('Config defaults match the pure DEFAULTS, so the schema cannot drift', async () => {
  const [{ configSchema }, pure, z] = await Promise.all([
    import('../lib/config.js'),
    import('../lib/pure.js'),
    import('@deepseek-ai/schemastery'),
  ])
  const json = configSchema(z.default ?? z).toJSON()
  const dict = json.refs[json.uid].dict
  const read = (field) => json.refs[dict[field]].meta.default
  assert.equal(read('enabled'), pure.DEFAULTS.enabled)
  assert.equal(read('continueText'), pure.DEFAULTS.continueText)
  assert.deepEqual(read('retryIntervalsMinutes'), pure.DEFAULTS.retryIntervalsMinutes)
  assert.equal(read('capEnabled'), pure.DEFAULTS.capEnabled)
  assert.equal(read('capHours'), pure.DEFAULTS.capHours)
  assert.equal(read('cooldownMinutes'), pure.DEFAULTS.cooldownMinutes)
})

test('the settings namespace matches the documented profile entry id', async () => {
  // DSH keys every settings form by the profile entry id, and the browser half
  // addresses the same string. Both must agree with what the README tells users
  // to put in cordis.patch.yml.
  const { SETTINGS_NS } = await import('../lib/config.js')
  assert.equal(SETTINGS_NS, 'fallback-continue')

  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const match = /const SETTINGS_NS = '([^']+)'/.exec(clientSrc)
  assert.ok(match, 'lib/client.js must declare SETTINGS_NS')
  assert.equal(match[1], SETTINGS_NS, 'client and host namespaces must match')
})

test('the removed settings API is not referenced any more', () => {
  // `settings.installSection` and `settings.replace` no longer exist in DSH 0.2;
  // calling them silently disabled persistence. Config now flows through the
  // volatile Config schema and the settings service. Comments are stripped so
  // the prose that explains this removal does not trip the check.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const file of ['lib/index.js', 'lib/controller.js', 'lib/client.js']) {
    const src = stripComments(readFileSync(join(ROOT, file), 'utf8'))
    assert.doesNotMatch(src, /installSection/, `${file} still calls the removed settings.installSection`)
    assert.doesNotMatch(src, /settings\.replace\(/, `${file} still calls the removed settings.replace`)
  }
})
