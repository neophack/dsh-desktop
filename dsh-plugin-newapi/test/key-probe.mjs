/**
 * Dead-chat-key probe regression test: the credential store only knows the
 * chat API key EXISTS, so a key deleted on the NewAPI web console used to
 * keep every synced model on the chat selector while each request failed 401.
 * The plugin now probes the key against the gateway's `/v1/models` (startup,
 * plus a live spot-check behind each fresh snapshot fetch — same function,
 * not re-tested here) and drops it only on a clean 401/403; the unset fires
 * reference-updated and the route hides through the normal reconcile path.
 *
 * Drives the REAL built Host bundle (lib/index.js, app-only imports swapped
 * for doubles) against a stub HTTP server and asserts:
 *  - startup with a server-rejected key drops the credential and hides (and
 *    stashes) the route,
 *  - a live key survives the probe and the route stays,
 *  - an unreachable server is NOT proof of a dead key: credential and route
 *    survive untouched,
 *  - re-keying after the drop restores the stashed route.
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

// Only /v1/models is exercised: with authKind 'token' and a configured chat
// key, startup maintenance reaches nothing but the probe.
const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    if (req.headers.authorization === 'Bearer sk-live') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[]}')
    } else {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"invalid api key"}}')
    }
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
const LIVE_BASE_URL = `http://127.0.0.1:${String(address.port)}`
const DEAD_BASE_URL = 'http://127.0.0.1:9'

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
    connection: { rpc: { handle: () => {} } },
  }
  return { ctx, fire }
}

const workDir = mkdtempSync(join(tmpdir(), 'newapi-key-probe-'))
process.env.DSH_NEWAPI_CACHE_DIR = join(workDir, 'cache')
const hostBundle = join(workDir, 'index.mjs')
writeFileSync(hostBundle, patchHostBundle(readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')), 'utf8')
const { apply } = await import(pathToFileURL(hostBundle).href)

// Explicit limits/input keep the startup limit-heal a no-op on this profile.
const routeProfile = {
  displayName: 'NewAPI',
  apiKeyEnv: 'NEWAPI_API_KEY',
  api: 'openai-completions',
  baseURL: `${LIVE_BASE_URL}/v1`,
  models: [{ id: 'gpt-a', contextWindow: 131_072, input: ['text', 'image'] }],
}

async function boot(baseUrl, key) {
  const newapiStore = { authKind: 'token' }
  const profile = { ...routeProfile, baseURL: `${baseUrl}/v1` }
  const llmStore = { providers: { newapi: structuredClone(profile), other: { models: [{ id: 'keep' }] } } }
  const credentialsStore = new Map([['NEWAPI_SESSION', 'pat-x.system-access'], ['NEWAPI_API_KEY', key]])
  const { ctx, fire } = makeStubContext(newapiStore, llmStore, credentialsStore)
  await apply(ctx, { baseUrl })
  await sleep(500)
  return { newapiStore, llmStore, credentialsStore, fire, profile }
}

// 1. Dead key at startup: the probe gets a clean 401, the credential is
//    dropped, and the route leaves the catalog with its profile stashed.
const dead = await boot(LIVE_BASE_URL, 'sk-dead')
check('server-rejected chat key is dropped at startup', !dead.credentialsStore.has('NEWAPI_API_KEY'))
check('route hidden for the dropped key', dead.llmStore.providers.newapi === undefined)
check('route profile stashed while hidden', typeof dead.newapiStore.stashedRoute === 'string' && dead.newapiStore.stashedRoute !== '')
check('sibling providers survive the drop', dead.llmStore.providers.other?.models?.[0]?.id === 'keep')
check('management credential untouched', dead.credentialsStore.get('NEWAPI_SESSION') === 'pat-x.system-access')

// 2. Re-keying after the drop restores the stashed route verbatim.
dead.credentialsStore.set('NEWAPI_API_KEY', 'sk-live')
dead.fire('NEWAPI_API_KEY')
await sleep(200)
check('re-keying restores the stashed route', JSON.stringify(dead.llmStore.providers.newapi) === JSON.stringify(dead.profile))

// 3. Live key at startup: probe passes, credential and route stay.
const live = await boot(LIVE_BASE_URL, 'sk-live')
check('live chat key survives the probe', live.credentialsStore.get('NEWAPI_API_KEY') === 'sk-live')
check('route stays for the live key', live.llmStore.providers.newapi !== undefined)

// 4. Unreachable server: a network error is not proof of a dead key.
const offline = await boot(DEAD_BASE_URL, 'sk-dead')
check('unreachable server keeps the key', offline.credentialsStore.get('NEWAPI_API_KEY') === 'sk-dead')
check('unreachable server keeps the route', offline.llmStore.providers.newapi !== undefined)

server.close()
if (failures > 0) {
  console.error(`key-probe: ${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('key-probe: all checks passed')
