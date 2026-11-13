/**
 * Runtime contract test: load the host half into a REAL cordis tree.
 *
 * `test/host-apply.mjs` drives the plugin through a hand-written ctx. That is
 * the right tool for route behaviour, but it cannot catch a plugin calling an
 * API cordis does not have, and it cannot catch a listener that outlives the
 * plugin: the mock accepts whatever the plugin asks for and never models fiber
 * scoping.
 *
 * Two real defects shipped that way, both silent because the code used optional
 * access or plain assignment:
 *
 *   1. `ctx.off(...)` for teardown, when cordis' event mixin is
 *      on/once/parallel/emit/serial/bail/waterfall — there is no `off` at all.
 *   2. Subscribing through `webServer.ctx` instead of the plugin's own context.
 *      cordis scopes a listener to the fiber of the context it is registered on,
 *      so a listener on the service's context belongs to the webserver's fiber
 *      and survives the plugin's disposal. Combined with (1), every reload left
 *      one more dead listener injecting a stale token.
 *
 * Both only show up against the real runtime in the real topology, which is what
 * this file builds.
 *
 * Needs `@deepseek-ai/cordis` resolvable from here: set DSH_CORDIS_ROOT to a
 * directory whose node_modules holds it, or rely on a checkout that ships one.
 * Exits 0 with a notice when none is resolvable, so a bare tree still tests.
 *
 * Run: node test/runtime.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))

let passed = 0
const check = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/** Resolve @deepseek-ai/cordis from DSH_CORDIS_ROOT, else from this package. */
function locateCordis() {
  const roots = [process.env.DSH_CORDIS_ROOT, join(here, '..'), here].filter(Boolean)
  for (const root of roots) {
    const probe = join(root, 'node_modules', '@deepseek-ai', 'cordis', 'package.json')
    if (existsSync(probe)) return probe
  }
  const require = createRequire(join(here, '..', 'package.json'))
  try {
    return require.resolve('@deepseek-ai/cordis/package.json')
  } catch {
    return undefined
  }
}

const cordisManifest = locateCordis()
if (cordisManifest === undefined) {
  console.log('\nruntime: @deepseek-ai/cordis is not resolvable here; skipping')
  console.log('  (set DSH_CORDIS_ROOT to a directory containing node_modules/@deepseek-ai/cordis)\n')
  process.exit(0)
}

const cordisEntry = join(dirname(cordisManifest), 'lib', 'index.js')
const { Context, Service } = await import(pathToFileURL(cordisEntry).href)
const { apply: bridgeApply, inject, name } = await import('../lib/index.js')

console.log(`\nruntime: ${cordisEntry}`)

// ---------------------------------------------------------------------------
// A stand-in for @deepseek-ai/dsh-host-webserver that keeps its real contract:
// duplicate paths throw, registration returns a disposer, and index injection
// is emitted with the 0.2.2 signature (table, peer).
// ---------------------------------------------------------------------------
class WebServerLike extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = new Map()
  }
  register(route) {
    const store = route.kind === 'exact' ? (this.exact ??= new Map()) : (this.prefix ??= new Map())
    if (store.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    store.set(route.path, route)
    this.routes.set(route.path, route)
    return () => {
      store.delete(route.path)
      this.routes.delete(route.path)
    }
  }
  collectIndexInjections(peer) {
    const table = []
    this.ctx.emit('webserver/index-inject', table, peer)
    return table
  }
}

const root = new Context()
// The service must own its own fiber, as it does in a real DSH tree; that is the
// precondition for a listener registered on `webServer.ctx` to outlive a plugin.
const serverFork = await root.plugin(WebServerLike)
const serverCtx = root.webServer.ctx

const fork = await root.plugin({ name, inject, apply: bridgeApply })

await check('the webServer context is distinct from a plugin context', () => {
  // If these were the same context, a listener on the service's ctx would be
  // scoped to the plugin anyway and nothing below could distinguish the bug.
  const probeFork = root.plugin({
    name: 'probe',
    apply(ctx) {
      assert.notEqual(ctx, serverCtx, 'test topology is degenerate: service ctx === plugin ctx')
    },
  })
  return probeFork
})

await check('declares only the webServer service', () => {
  assert.deepEqual(inject, ['webServer'])
})

await check('registers exactly the three bridge routes', () => {
  assert.deepEqual([...root.webServer.routes.keys()].sort(), [
    '/__dsh-desktop-bridge/health',
    '/__dsh-desktop-bridge/ingest',
    '/__dsh-desktop-bridge/probe',
  ])
})

await check('publishes the token row through the (table, peer) signature', () => {
  const table = root.webServer.collectIndexInjections({ id: 'peer-1' })
  const row = table.find((r) => r.kind === 'global')
  assert.ok(row, 'no global row was injected')
  assert.equal(row.name, '__DSH_DESKTOP_BRIDGE__')
  assert.equal(row.value.protocol, 1)
  assert.deepEqual(row.value.kinds, ['waiting', 'done', 'failed'])
  assert.match(row.value.token, /^[0-9a-f]{48}$/)
})

await check('the injected row survives the desktop shell IPC hop', () => {
  const row = root.webServer.collectIndexInjections(undefined).find((r) => r.kind === 'global')
  const round = JSON.parse(JSON.stringify(row.value))
  assert.equal(round.token, row.value.token, 'a token that cannot be JSON-encoded never reaches the page')
  assert.deepEqual(round.kinds, row.value.kinds)
})

await fork.dispose()

await check('dispose withdraws every route', () => {
  assert.deepEqual([...root.webServer.routes.keys()], [])
})

// The regressions these checks exist for.
//
// `ctx.off` does not exist on cordis 4.1, so the old teardown call did nothing.
// The hook still disappeared, because cordis scopes every listener to a fiber
// effect internally — measured 0 -> 1 -> 0 across apply/dispose. So the defect
// was a silently dead teardown path rather than an observable leak, and no
// behavioural test can distinguish them today. These checks pin the behaviour a
// future host change could break, and `apply() never calls a method cordis does
// not provide` pins the actual defect.
await check('dispose withdraws the index-inject listener', () => {
  const after = root.webServer.collectIndexInjections(undefined)
  assert.deepEqual(after, [], 'a disposed plugin must not inject anything')
})

await check('repeated mount/unmount does not accumulate listeners', () => {
  // Counts hooks directly rather than inferring from injected rows, so a
  // regression that adds a listener without injecting anything still shows.
  const hooks = () => (root.events._hooks['webserver/index-inject'] ?? []).length
  const baseline = hooks()
  return (async () => {
    for (let i = 0; i < 3; i += 1) {
      const f = await root.plugin({ name, inject, apply: bridgeApply })
      await f.dispose()
    }
    assert.equal(hooks(), baseline, 'listeners accumulated across mount cycles')
  })()
})

await check('apply() never calls a method cordis does not provide', () => {
  // Reaching the end at all proves it: `ctx.off` or `ctx.logger.log` would have
  // thrown a TypeError on this real context during apply() or dispose().
  assert.equal(typeof root.on, 'function')
  assert.equal(root.off, undefined, 'cordis still has no ctx.off, which is why the teardown must use the disposer')
})

// Tear the service down last: disposing it clears the context the checks above
// read through.
await serverFork.dispose()

console.log(`\n${passed} checks passed\n`)
