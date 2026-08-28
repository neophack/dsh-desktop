/**
 * Startup route-heal regression test: drives the REAL built Host bundle
 * (lib/index.js, app-only imports swapped for doubles) through apply() with a
 * stored llm-pi-ai route and no network, and asserts the startup heal:
 *  - models synced before the conservative default existed get the default
 *    context window stamped on (llm-pi-ai would otherwise assume 256k and let
 *    sessions run into the corrupted-tool-call band before compaction),
 *  - an entry that already declares its own contextWindow is never touched,
 *  - a per-model limit stored via models.setLimit wins over the default,
 *  - models synced before explicit input modalities existed get `input`
 *    stamped on — ['text', 'image'] by default, ['text'] when the stored
 *    per-model settings opt out with image: false — so read_image works,
 *  - the rest of the route profile survives the rewrite,
 *  - the heal is idempotent across Host restarts,
 *  - defaultContextWindow: 0 disables the context heal exactly as it disables
 *    the sync-time default, while the deterministic input stamp still runs.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
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

/** Cordis-shaped settings stub: 'newapi' scope store + 'llm-pi-ai' store with per-route merge. */
function makeStubContext(newapiStore, llmStore) {
  let llmUpdates = 0
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
        llmUpdates += 1
        // Sparse-patch semantics: a providers.<route> object replaces that
        // route wholesale and leaves sibling providers alone.
        if (patch.providers !== undefined) {
          llmStore.providers = { ...llmStore.providers, ...patch.providers }
        }
        for (const [key, value] of Object.entries(patch)) {
          if (key !== 'providers') llmStore[key] = value
        }
      },
      mutate: async () => { throw new Error('unexpected settings mutate') },
    },
    credentials: {
      resolve: async (ref) => (credentialsStore.has(ref.name) ? { value: credentialsStore.get(ref.name) } : undefined),
      set: async (ref, value) => { credentialsStore.set(ref.name, value) },
      unset: async (ref) => { credentialsStore.delete(ref.name) },
      describe: async (ref) => ({ configured: credentialsStore.has(ref.name) }),
    },
    connection: { rpc: { handle: () => {} } },
  }
  return { ctx, llmUpdates: () => llmUpdates }
}

const hostBundle = join(mkdtempSync(join(tmpdir(), 'newapi-route-heal-')), 'index.mjs')
writeFileSync(hostBundle, patchHostBundle(readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')), 'utf8')
const { apply } = await import(pathToFileURL(hostBundle).href)

const originalRoute = {
  displayName: 'NewAPI',
  apiKeyEnv: 'NEWAPI_API_KEY',
  api: 'openai-completions',
  baseURL: 'http://gateway.example/v1',
  models: [
    { id: 'gpt-a' },
    { id: 'gpt-big', contextWindow: 204_800 },
    { id: 'gpt-lim' },
    { id: 'gpt-noimg' },
  ],
}

// 1. Plain startup heal: default stamped on missing limits, input stamped on all.
{
  const newapiStore = { modelLimits: JSON.stringify({
    'gpt-lim': { contextWindow: 65_536 },
    'gpt-noimg': { image: false },
  }) }
  const llmStore = { providers: { newapi: structuredClone(originalRoute), other: { models: [{ id: 'keep' }] } } }
  const { ctx } = makeStubContext(newapiStore, llmStore)
  await apply(ctx, { baseUrl: 'http://127.0.0.1:9' })
  await sleep(300)
  const models = llmStore.providers.newapi.models
  check('missing limit stamped with the default', models.find((m) => m.id === 'gpt-a')?.contextWindow === 131_072)
  check('existing explicit limit untouched', models.find((m) => m.id === 'gpt-big')?.contextWindow === 204_800)
  check('per-model limit wins over the default', models.find((m) => m.id === 'gpt-lim')?.contextWindow === 65_536)
  check('missing input stamped with text+image by default', models.find((m) => m.id === 'gpt-a')?.input?.join(',') === 'text,image')
  check('stored image opt-out stamps text-only input', models.find((m) => m.id === 'gpt-noimg')?.input?.join(',') === 'text')
  const route = llmStore.providers.newapi
  check('route profile fields survive the heal', route.displayName === 'NewAPI'
    && route.apiKeyEnv === 'NEWAPI_API_KEY' && route.api === 'openai-completions'
    && route.baseURL === 'http://gateway.example/v1')
  check('sibling providers survive the heal', llmStore.providers.other?.models?.[0]?.id === 'keep')

  // 2. Restart: the healed route is already complete, so nothing is written.
  const second = makeStubContext(newapiStore, llmStore)
  await apply(second.ctx, { baseUrl: 'http://127.0.0.1:9' })
  await sleep(300)
  check('heal is idempotent across restarts', second.llmUpdates() === 0)
}

// 3. defaultContextWindow: 0 disables the context heal, not the input stamp.
{
  const newapiStore = { defaultContextWindow: 0 }
  const llmStore = { providers: { newapi: structuredClone(originalRoute) } }
  const { ctx, llmUpdates } = makeStubContext(newapiStore, llmStore)
  await apply(ctx, { baseUrl: 'http://127.0.0.1:9' })
  await sleep(300)
  check('default 0 leaves stored context windows untouched', llmStore.providers.newapi.models.every((m) => m.id === 'gpt-big' || m.contextWindow === undefined))
  check('default 0 still stamps input modalities', llmStore.providers.newapi.models.every((m) => Array.isArray(m.input)))
  check('default 0 writes exactly one input-only heal', llmUpdates() === 1)
}

if (failures > 0) {
  console.error(`route-heal: ${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('route-heal: all checks passed')
