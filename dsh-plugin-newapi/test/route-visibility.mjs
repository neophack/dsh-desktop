/**
 * Chat model selector visibility test: the menu is driven by the llm-pi-ai
 * settings document, and the plugin must keep it honest about the chat API
 * key — models without a usable key must never show. Drives the REAL built
 * Host bundle (lib/index.js, app-only imports swapped for doubles) with no
 * network and asserts:
 *  - startup with a stored route but no key removes (and stashes) the route,
 *  - the credential event for another reference is ignored,
 *  - the key returning (credentials/reference-updated, the same event the
 *    selector's catalog refreshes on) restores the stashed route verbatim,
 *  - the key leaving again hides the route once more (live, no restart),
 *  - models.sync without a key fails and never writes a key-less route,
 *  - models.sync with a key re-adds the route from the persisted snapshot
 *    cache and clears the stash.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { patchHostBundle } from './login-flow-stubs.mjs'

let failures = 0
const check = (name, condition) => {
  if (condition) console.log(`  ok: ${name}`)
  else { failures += 1; console.error(`  FAIL: ${name}`) }
}

// A dead port: every path that would hit the network must instead be served
// from the persisted snapshot cache seeded below (or fail fast).
const BASE_URL = 'http://127.0.0.1:9'

// Seed the persisted snapshot cache so models.sync can rebuild the route
// offline (stale-serve path; the background refresh fails harmlessly).
const cacheDir = mkdtempSync(join(tmpdir(), 'newapi-route-visibility-'))
process.env.DSH_NEWAPI_CACHE_DIR = cacheDir
mkdirSync(cacheDir, { recursive: true })
const snapshotPayload = {
  baseUrl: BASE_URL,
  server: { systemName: 'AI', version: 'v1.0.0-rc.test', quotaPerUnit: 500_000, usdExchangeRate: 7.3, passwordLogin: false, oauthProviders: [] },
  user: { id: 1, username: 'root' },
  tokens: [],
  models: [{ id: 'gpt-x' }, { id: 'gpt-y' }],
  usage: {},
}
writeFileSync(join(cacheDir, 'newapi-snapshots.json'), JSON.stringify({ [BASE_URL]: { payload: snapshotPayload, at: Date.now() - 60_000 } }), 'utf8')

/** Cordis-shaped stub: settings stores, credential store whose writes fan out the reference-updated event like the real service. */
function makeStubContext(newapiStore, llmStore, credentialsStore) {
  const listeners = []
  const fire = (name) => {
    for (const listener of [...listeners]) listener(name)
  }
  const scope = {
    get: () => ({ ...newapiStore }),
    update: async (patch) => { Object.assign(newapiStore, patch) },
    replace: async (next) => { for (const key of Object.keys(newapiStore)) delete newapiStore[key]; Object.assign(newapiStore, next) },
  }
  let handler
  const ctx = {
    logger: { info: () => {}, warn: (message) => { console.error(`  warn: ${String(message)}`) }, debug: () => {} },
    effect: () => () => {},
    on: (event, listener) => {
      if (event === 'credentials/reference-updated') listeners.push(listener)
      return () => {}
    },
    settings: {
      register: (_ns, _schema, _options) => scope,
      get: (ns) => (ns === 'llm-pi-ai' ? llmStore : undefined),
      update: async (ns, patch) => {
        if (ns !== 'llm-pi-ai') throw new Error(`unexpected settings namespace ${ns}`)
        // Sparse-patch semantics: a providers.<route> object replaces that
        // route wholesale and leaves sibling providers alone.
        if (patch.providers !== undefined) {
          llmStore.providers = { ...llmStore.providers, ...patch.providers }
        }
      },
      mutate: async (ns, ops) => {
        if (ns !== 'llm-pi-ai') throw new Error(`unexpected settings namespace ${ns}`)
        for (const op of ops) {
          const parent = op.path.slice(0, -1).reduce((node, key) => node?.[key], llmStore)
          if (op.op === 'unset') { if (parent !== undefined) delete parent[op.path[op.path.length - 1]] }
        }
      },
    },
    credentials: {
      resolve: async (ref) => (credentialsStore.has(ref.name) ? { value: credentialsStore.get(ref.name) } : undefined),
      set: async (ref, value) => { credentialsStore.set(ref.name, value); fire(ref.name) },
      unset: async (ref) => { credentialsStore.delete(ref.name); fire(ref.name) },
      describe: async (ref) => ({ configured: credentialsStore.has(ref.name) }),
    },
    connection: { rpc: { handle: (_channel, h) => { handler = h } } },
  }
  return { ctx, fire, call: (endpoint, payload) => handler(endpoint, payload, undefined) }
}

const hostBundle = join(cacheDir, 'index.mjs')
writeFileSync(hostBundle, patchHostBundle((await import('node:fs')).readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')), 'utf8')
const { apply } = await import(pathToFileURL(hostBundle).href)

// Explicit limits/input keep the startup limit-heal a no-op, so the stash
// round-trip below compares against exactly this profile.
const routeProfile = {
  displayName: 'NewAPI',
  apiKeyEnv: 'NEWAPI_API_KEY',
  api: 'openai-completions',
  baseURL: `${BASE_URL}/v1`,
  models: [
    { id: 'gpt-a', contextWindow: 131_072, input: ['text', 'image'] },
    { id: 'gpt-b', contextWindow: 65_536, input: ['text'] },
  ],
}

const newapiStore = {}
const llmStore = { providers: { newapi: structuredClone(routeProfile), other: { models: [{ id: 'keep' }] } } }
const credentialsStore = new Map()
const { ctx, fire, call } = makeStubContext(newapiStore, llmStore, credentialsStore)
await apply(ctx, { baseUrl: BASE_URL })
await sleep(300)

// 1. Startup, key missing: the route leaves the catalog (menu shows no NewAPI
//    models) and its profile is stashed for a zero-network restore.
check('startup hides the key-less route', llmStore.providers.newapi === undefined)
check('sibling providers survive', llmStore.providers.other?.models?.[0]?.id === 'keep')
const stash = newapiStore.stashedRoute
check('route profile stashed while hidden', typeof stash === 'string' && JSON.parse(stash) !== null
  && JSON.stringify(JSON.parse(stash)) === JSON.stringify(routeProfile))

// 2. Credential events for other references are ignored.
fire('NEWAPI_SESSION')
await sleep(150)
check('unrelated credential event leaves the route hidden', llmStore.providers.newapi === undefined)

// 3. The key returns: the event (the same one the selector's catalog refresh
//    listens to) restores the stashed route verbatim and clears the stash.
credentialsStore.set('NEWAPI_API_KEY', 'sk-back')
fire('NEWAPI_API_KEY')
await sleep(150)
check('key returning restores the route', JSON.stringify(llmStore.providers.newapi) === JSON.stringify(routeProfile))
check('restore clears the stash', newapiStore.stashedRoute === '')

// 4. The key leaves again at runtime: the route hides once more, no restart.
credentialsStore.delete('NEWAPI_API_KEY')
fire('NEWAPI_API_KEY')
await sleep(150)
check('key leaving re-hides the route live', llmStore.providers.newapi === undefined)
check('re-hide re-stashes the profile', newapiStore.stashedRoute === stash)

// 5. models.sync without a key fails typed and writes nothing.
const keylessSync = await call('models.sync', {})
check('models.sync without a key fails', keylessSync.ok === false && keylessSync.error.details?.code === 'not-configured')
check('failed sync leaves the route hidden', llmStore.providers.newapi === undefined)

// 6. With the key back, models.sync rebuilds the route from the persisted
//    snapshot cache and clears the stash. Only models the user selected ride
//    the route, so select both cached models first.
credentialsStore.set('NEWAPI_API_KEY', 'sk-live')
fire('NEWAPI_API_KEY')
await sleep(150)
check('models.setSelected persists and re-syncs', (await call('models.setSelected', { id: 'gpt-x', selected: true })).ok === true
  && (await call('models.setSelected', { id: 'gpt-y', selected: true })).ok === true)
const synced = await call('models.sync', {})
check('models.sync with a key succeeds offline from the cache', synced.ok === true && synced.value.count === 2)
const syncedRoute = llmStore.providers.newapi
check('synced route carries the cached models', syncedRoute !== undefined
  && syncedRoute.baseURL === `${BASE_URL}/v1`
  && syncedRoute.models.map((m) => m.id).join(',') === 'gpt-x,gpt-y')
check('successful sync clears the stash', newapiStore.stashedRoute === '')
check('sibling providers still survive', llmStore.providers.other?.models?.[0]?.id === 'keep')

if (failures > 0) {
  console.error(`route-visibility: ${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('route-visibility: all checks passed')
