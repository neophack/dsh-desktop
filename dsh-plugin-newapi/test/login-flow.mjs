/**
 * Host login-flow regression test: drives the REAL built Host bundle
 * (lib/index.js, with its app-only imports swapped for the doubles from
 * login-flow-stubs.mjs) through its /newapi RPC channel against a mock NewAPI
 * server.
 *
 * Regression covered (the "click login and it never finishes / disappears"
 * bug): a settled login attempt must stay observable through
 * `login.native.status` until the client acks with `login.native.cancel`.
 * Previously settleNativeLogin dropped the reference immediately, so the
 * terminal ok/error was unobservable and the login UI hung forever. Also
 * pins the cookie-watch cadence (the ticker once ran at ~1ms) and the
 * top-level login-window lifecycle (open on start, close on capture/cancel).
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { electronState as electron, patchHostBundle } from './login-flow-stubs.mjs'

const USER = { id: 42, username: 'root', display_name: 'Root', email: 'root@example.com', quota: -1, used_quota: 0, request_count: 5 }
/** Valid `new_api_refresh` cookie values (rc.2x wire shape). */
const VALID_SESSIONS = new Set(['nar-signin.a.b', 'nar-stale.a.b'])
const mintedBearers = new Set()

const server = createServer((req, res) => {
  const send = (data, extraHeaders = {}) => {
    res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders })
    res.end(JSON.stringify({ success: true, data }))
  }
  const deny = (message, status = 401) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: false, message }))
  }
  const refreshCookie = (req.headers.cookie ?? '').match(/(?:^|;\s*)new_api_refresh=([^;]+)/)?.[1]
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')

  if (req.method === 'GET' && req.url === '/api/status') {
    send({
      system_name: 'AI', version: 'v1.0.0-rc.test', quota_per_unit: 500_000, usd_exchange_rate: 7.3,
      password_login_enabled: false,
      custom_oauth_providers: [{ id: 1, name: 'Feishu', slug: 'feishu', client_id: 'cli_test', authorization_endpoint: 'https://accounts.example/open-apis/authen/v1/authorize', scopes: 'contact:user.id' }],
    })
    return
  }
  if (req.method === 'POST' && req.url === '/api/oauth/state') {
    send('st1')
    return
  }
  if (req.method === 'POST' && req.url === '/api/user/auth/refresh') {
    if (refreshCookie === undefined || !VALID_SESSIONS.has(refreshCookie)) { deny('not logged in'); return }
    const token = `bearer.${String(mintedBearers.size + 1)}.sig`
    mintedBearers.add(token)
    // rc.2x servers rotate the refresh cookie on every exchange.
    send({ access_token: token, token_type: 'Bearer', access_expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER },
      { 'set-cookie': `new_api_refresh=${refreshCookie}; Path=/api/user/auth; HttpOnly; SameSite=Strict` })
    return
  }
  if (!mintedBearers.has(bearer)) { deny('not logged in'); return }
  if (req.method === 'GET' && req.url === '/api/user/self') { send(USER); return }
  if (req.method === 'GET' && req.url?.startsWith('/api/token/?')) {
    send({ items: [{ id: 1, name: 'default', key: 'sk-tail', quota: -1, used_quota: 0, models: '-1', expired_time: -1 }] })
    return
  }
  if (req.method === 'POST' && req.url === '/api/token/1/key') { send({ key: 'sk-full-key' }); return }
  if (req.method === 'GET' && req.url === '/api/user/models') { send(['gpt-x', 'gpt-y']); return }
  if (req.method === 'GET' && req.url === '/api/pricing') { send({ data: [{ model_name: 'gpt-x', model_price: 1, model_out_price: 2 }] }); return }
  deny('not found', 404)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${String(server.address().port)}`

// --- Cordis-shaped stubs -------------------------------------------------------
const settingsStore = {}
const scope = {
  get: () => ({ ...settingsStore }),
  update: async (patch) => { Object.assign(settingsStore, patch) },
  replace: async (next) => { for (const key of Object.keys(settingsStore)) delete settingsStore[key]; Object.assign(settingsStore, next) },
}
/** llm-pi-ai namespace store, so persistLogin's auto model sync has an adapter to write. */
const llmSettings = {}
const credentialsStore = new Map()
const disposers = []
const warns = []
let handler
const ctx = {
  logger: { info: () => {}, warn: (message) => { warns.push(String(message)) }, debug: () => {} },
  effect: (fn) => { const dispose = fn(); disposers.push(dispose); return () => {} },
  settings: {
    register: (_ns, _schema, _options) => scope,
    get: (ns) => (ns === 'llm-pi-ai' ? llmSettings : undefined),
    update: async (ns, patch) => {
      if (ns !== 'llm-pi-ai') throw new Error(`unexpected settings namespace ${ns}`)
      Object.assign(llmSettings, patch)
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

const hostBundle = join(mkdtempSync(join(tmpdir(), 'newapi-login-flow-')), 'index.mjs')
writeFileSync(hostBundle, patchHostBundle(readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')), 'utf8')
const { apply } = await import(pathToFileURL(hostBundle).href)
apply(ctx, { baseUrl: base })
if (handler === undefined) throw new Error('rpc handler was not registered')
const call = (endpoint, payload) => handler(endpoint, payload, undefined)

let failures = 0
const check = (name, condition) => {
  if (condition) console.log(`  ok: ${name}`)
  else { failures += 1; console.error(`  FAIL: ${name}`) }
}
const status = async () => (await call('login.native.status')).value

try {
  // 1. Start: window opens on the provider authorize URL, status observable as pending.
  const started = await call('login.native.start', { baseUrl: base })
  check('start ok', started.ok === true)
  check('login window opened', electron.windows.length === 1)
  const win = electron.windows[0]
  check('window loads the provider authorize URL', win.url.startsWith('https://accounts.example/open-apis/authen/v1/authorize')
    && win.url.includes('client_id=cli_test') && win.url.includes('redirect_uri=') && win.url.includes('state=st1'))
  check('status pending observable', (await status()).status === 'pending')

  // 2. Pending phase: cookie watch ticks at ~1s (not a flood).
  const getsBefore = electron.jarGets
  await sleep(2200)
  const ticks = electron.jarGets - getsBefore
  check(`cookie watch cadence ~1s (${String(ticks)} reads in 2.2s)`, ticks >= 1 && ticks <= 4)
  check('still pending without a cookie', (await status()).status === 'pending')

  // 3. Sign-in lands in the default session (top-level window): cookie verify + persist.
  //    rc.2x scopes the refresh cookie to /api/user/auth (path-match matters).
  electron.jar.set(new URL(base).origin, [{ name: 'new_api_refresh', value: 'nar-signin.a.b', path: '/api/user/auth' }])
  // Verification + persistence are request-throttled (429 safety), so the ok
  // status can take a few seconds to settle.
  await sleep(4000)
  const okStatus = await status()
  check('status ok observable (regression: settle kept the result)', okStatus.status === 'ok')
  check('ok carries the user', okStatus.user?.username === 'root')
  check('login window closed on capture', win.destroyed === true)
  check('session credential persisted', credentialsStore.get('NEWAPI_SESSION') !== undefined)
  check('chat api key persisted', credentialsStore.get('NEWAPI_API_KEY') === 'sk-full-key')
  const autoSynced = llmSettings.providers?.newapi
  check('login auto-synced models to the chat catalog', autoSynced !== undefined
    && autoSynced.baseURL === `${base}/v1`
    && Array.isArray(autoSynced.models) && autoSynced.models.length === 2
    && autoSynced.models.every((m) => typeof m.id === 'string'))
  const stillOk = await status()
  check('ok STAYS observable until ack (regression)', stillOk.status === 'ok')

  // 4. Client ack clears the attempt.
  check('cancel ok', (await call('login.native.cancel')).ok === true)
  check('status idle after ack', (await status()).status === 'idle')
  const config = await call('config.get')
  check('config.get reports tokenConfigured', config.ok === true && config.value.tokenConfigured === true)

  // 5. Second flow: user closing the login window surfaces a cancel error.
  await call('login.native.start', { baseUrl: base })
  check('second window opened', electron.windows.length === 2)
  const win2 = electron.windows[1]
  win2.close()
  const closedStatus = await status()
  check('window close settles as observable error', closedStatus.status === 'error' && closedStatus.error === 'canceled')
  await call('login.native.cancel')
  check('idle again after ack', (await status()).status === 'idle')

  // 6. Dispose: no throw, pending window force-closed.
  await call('login.native.start', { baseUrl: base })
  const win3 = electron.windows[2]
  for (const dispose of disposers) dispose()
  check('dispose closes the pending window', win3.destroyed === true)
  check('no host warnings', warns.length === 0)
} finally {
  await new Promise((resolve) => server.close(resolve))
}

if (failures > 0) {
  console.error(`login-flow: ${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('login-flow: all checks passed')
