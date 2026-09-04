/**
 * Model selection regression test: NO model is added to the chat selector by
 * default; models the user adds ride the llm-pi-ai route (and only those),
 * and removing one — or the last one — drops it from the selector live.
 * Drives the REAL built Host bundle (lib/index.js, app-only imports swapped
 * for doubles) with no network; the snapshot cache serves the model list.
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

const cacheDir = mkdtempSync(join(tmpdir(), 'newapi-model-selection-'))
process.env.DSH_NEWAPI_CACHE_DIR = cacheDir
mkdirSync(cacheDir, { recursive: true })
const snapshotPayload = {
  baseUrl: BASE_URL,
  server: { systemName: 'AI', version: 'v1.0.0-rc.test', quotaPerUnit: 500_000, usdExchangeRate: 7.3, passwordLogin: false, oauthProviders: [] },
  user: { id: 1, username: 'root' },
  tokens: [],
  models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'gpt-x' }],
  usage: {},
}
writeFileSync(join(cacheDir, 'newapi-snapshots.json'), JSON.stringify({ [BASE_URL]: { payload: snapshotPayload, at: Date.now() - 60_000 } }), 'utf8')

/** Cordis-shaped stub: settings stores plus a pre-configured chat API key. */
function makeStubContext(newapiStore, llmStore) {
  let handler
  const scope = {
    get: () => ({ ...newapiStore }),
    update: async (patch) => { Object.assign(newapiStore, patch) },
    replace: async (next) => { for (const key of Object.keys(newapiStore)) delete newapiStore[key]; Object.assign(newapiStore, next) },
  }
  const credentialsStore = new Map([['NEWAPI_API_KEY', 'sk-present']])
  const ctx = {
    logger: { info: () => {}, warn: (message) => { console.error(`  warn: ${String(message)}`) }, debug: () => {} },
    effect: () => () => {},
    on: () => () => {},
    settings: {
      register: (_ns, _schema, _options) => scope,
      get: (ns) => (ns === 'llm-pi-ai' ? llmStore : undefined),
      update: async (ns, patch) => {
        if (ns !== 'llm-pi-ai') throw new Error(`unexpected settings namespace ${ns}`)
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
      set: async (ref, value) => { credentialsStore.set(ref.name, value) },
      unset: async (ref) => { credentialsStore.delete(ref.name) },
      describe: async (ref) => ({ configured: credentialsStore.has(ref.name) }),
    },
    connection: { rpc: { handle: (_channel, h) => { handler = h } } },
  }
  return { ctx, call: (endpoint, payload) => handler(endpoint, payload, undefined) }
}

const hostBundle = join(cacheDir, 'index.mjs')
writeFileSync(hostBundle, patchHostBundle((await import('node:fs')).readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')), 'utf8')
const { apply } = await import(pathToFileURL(hostBundle).href)

// Start with a pre-selection full route (what an older version sync wrote).
const newapiStore = {}
const llmStore = { providers: { newapi: { displayName: 'NewAPI', models: [{ id: 'stale-model' }] } } }
const { ctx, call } = makeStubContext(newapiStore, llmStore)
await apply(ctx, { baseUrl: BASE_URL })
await sleep(300)

// 1. Default: nothing selected, so a sync offers nothing and removes any
//    route an earlier full sync wrote — the selector shows no NewAPI models.
const empty = await call('models.sync', {})
check('sync with no selection succeeds with count 0', empty.ok === true && empty.value.count === 0)
check('sync with no selection removes the existing route', llmStore.providers.newapi === undefined)
check('config.get exposes the empty default selection', (await call('config.get', {})).value.selectedModels.length === 0)

// 2. Adding a model persists the selection and writes exactly that model.
check('add deepseek-chat', (await call('models.setSelected', { id: 'deepseek-chat', selected: true })).ok === true)
check('added model rides the route alone', llmStore.providers.newapi?.models?.map((m) => m.id).join(',') === 'deepseek-chat')

// 3. A second add grows the selector set; nothing unselected sneaks in.
check('add deepseek-reasoner', (await call('models.setSelected', { id: 'deepseek-reasoner', selected: true })).ok === true)
check('both added models ride the route', llmStore.providers.newapi?.models?.map((m) => m.id).join(',') === 'deepseek-chat,deepseek-reasoner')

// 4. Removing one model drops it from the selector live; the other stays.
check('remove deepseek-chat', (await call('models.setSelected', { id: 'deepseek-chat', selected: false })).ok === true)
check('removed model left the route', llmStore.providers.newapi?.models?.map((m) => m.id).join(',') === 'deepseek-reasoner')
check('selection persisted without the removed id', JSON.parse(newapiStore.selectedModels).join(',') === 'deepseek-reasoner')

// 5. Removing the last model unsets the route entirely.
check('remove deepseek-reasoner', (await call('models.setSelected', { id: 'deepseek-reasoner', selected: false })).ok === true)
check('empty selection unsets the route', llmStore.providers.newapi === undefined)
check('config.get reflects the emptied selection', (await call('config.get', {})).value.selectedModels.length === 0)

if (failures > 0) {
  console.error(`model-selection: ${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('model-selection: all checks passed')
