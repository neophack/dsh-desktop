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
 * Plus the access-token credential flow: login mints the long-lived system
 * access token (GET /api/user/token) once and caches it (authKind 'token'),
 * every later usage snapshot authenticates with that Bearer (zero further
 * /api/user/auth/refresh exchanges), and when the token is replaced
 * server-side the plugin SIGNS OUT instead of fighting for it — automatic
 * re-mints from several logged-in clients would rotate the single token
 * endlessly and 429 the server. A deliberate re-login fetches the fresh
 * token.
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
/** The account's CURRENT system access token (ensure semantics: one at a time). */
let currentAccessToken = ''
const accessTokens = new Set()
let refreshExchanges = 0
let accessTokensMinted = 0
let sawSelfOverAccessToken = false

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
    refreshExchanges += 1
    const token = `bearer.${String(mintedBearers.size + 1)}.sig`
    mintedBearers.add(token)
    // rc.2x servers rotate the refresh cookie on every exchange.
    send({ access_token: token, token_type: 'Bearer', access_expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER },
      { 'set-cookie': `new_api_refresh=${refreshCookie}; Path=/api/user/auth; HttpOnly; SameSite=Strict` })
    return
  }
  if (!mintedBearers.has(bearer) && !accessTokens.has(bearer)) { deny('not logged in'); return }
  if (req.method === 'GET' && req.url === '/api/user/self') {
    if (accessTokens.has(bearer)) sawSelfOverAccessToken = true
    send(USER); return
  }
  if (req.method === 'GET' && req.url === '/api/user/token') {
    // GenerateAccessToken (this deployment): ensure semantics — return the
    // account's CURRENT token, minting one only when none exists.
    if (currentAccessToken === '') {
      accessTokensMinted += 1
      currentAccessToken = `pat-${String(accessTokensMinted)}.system-access`
      accessTokens.add(currentAccessToken)
    }
    send(currentAccessToken)
    return
  }
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
  on: () => () => {},
  settings: {
    register: (_ns, _schema, _options) => scope,
    get: (ns) => (ns === 'llm-pi-ai' ? llmSettings : undefined),
    update: async (ns, patch) => {
      if (ns !== 'llm-pi-ai') throw new Error(`unexpected settings namespace ${ns}`)
      Object.assign(llmSettings, patch)
    },
    mutate: async (ns, ops) => {
      if (ns !== 'llm-pi-ai') throw new Error(`unexpected settings namespace ${ns}`)
      for (const op of ops) {
        const parent = op.path.slice(0, -1).reduce((node, key) => node?.[key], llmSettings)
        if (op.op === 'unset') { if (parent !== undefined) delete parent[op.path[op.path.length - 1]] }
        else if (parent !== undefined) parent[op.path[op.path.length - 1]] = {}
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
  const storedCredential = credentialsStore.get('NEWAPI_SESSION')
  check('access token persisted (not the cookie value)', typeof storedCredential === 'string' && storedCredential.startsWith('pat-')
    && storedCredential !== 'nar-signin.a.b')
  check('authKind stored as token', settingsStore.authKind === 'token')
  check('exactly one access-token generation for the login', accessTokensMinted === 1)
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
  check('config.get exposes the access token masked (head+tail only)',
    config.value.accessTokenMasked === 'pat-****cess'
      && config.value.accessTokenMasked !== storedCredential
      && !config.value.accessTokenMasked.includes(storedCredential.slice(4, -4)))

  // 4a. Post-login reads (usage snapshot) authenticate with the cached access
  //     token: no cookie construction, no /api/user/auth/refresh exchange.
  const refreshBefore = refreshExchanges
  const snapshot = await call('snapshot.get', { force: true })
  check('snapshot ok over the access token', snapshot.ok === true && snapshot.value.user?.username === 'root')
  check('usage reads spend zero refresh exchanges', refreshExchanges === refreshBefore)
  check('reads carried the access token bearer', sawSelfOverAccessToken === true)

  // 4b. Web-console regeneration replaces the account's only token; the
  //     plugin must NOT fight back — automatic re-mints from several
  //     logged-in clients rotate the token endlessly and 429 the server.
  //     The next snapshot signs out: credential cleared, chat key kept.
  accessTokens.delete(storedCredential)
  currentAccessToken = 'pat-web.regenerated'
  accessTokens.add(currentAccessToken)
  const dead = await call('snapshot.get', { force: true })
  check('dead token surfaces a sign-out error, not a retry storm', dead.ok === false
    && dead.error.message.includes('signed out'))
  check('sign-out cleared the console credential', credentialsStore.has('NEWAPI_SESSION') === false)
  check('sign-out kept the chat api key (independent of the token)', credentialsStore.get('NEWAPI_API_KEY') === 'sk-full-key')
  check('authKind reset by the sign-out', settingsStore.authKind === '')

  // 4c. The user signs in again: one deliberate login, the server's CURRENT
  //     token (ensure semantics) lands in the store, snapshot works again.
  const relogin = await call('login.native.start', { baseUrl: base })
  check('re-login window opened', relogin.ok === true && electron.windows.length === 2)
  await sleep(5000)
  const relogged = await status()
  check('re-login captures and stores the fresh token', relogged.status === 'ok'
    && credentialsStore.get('NEWAPI_SESSION') === 'pat-web.regenerated')
  await call('login.native.cancel')
  const revived = await call('snapshot.get', { force: true })
  check('snapshot works again over the fresh token', revived.ok === true && revived.value.user?.username === 'root')

  // 4b. Signing out hides the models: config.clear also removes the key-less
  //     route from the llm-pi-ai catalog so the chat selector stops offering it.
  check('config.clear ok', (await call('config.clear')).ok === true)
  check('config.clear removed the key-less route from the catalog', llmSettings.providers?.newapi === undefined)

  // 4c. Startup guard: a fresh Host boot with a leftover synced route but no
  //     credentials removes the route again (key-less models stay hidden).
  {
    const freshLlm = { providers: { newapi: { displayName: 'NewAPI', baseURL: `${base}/v1`, models: [{ id: 'gpt-x' }] }, other: {} } }
    const ctx2 = {
      ...ctx,
      settings: {
        ...ctx.settings,
        get: (ns) => (ns === 'llm-pi-ai' ? freshLlm : undefined),
        update: async (ns, patch) => { if (ns !== 'llm-pi-ai') throw new Error(`unexpected namespace ${ns}`); Object.assign(freshLlm, patch) },
        mutate: async (ns, ops) => {
          for (const op of ops) {
            const parent = op.path.slice(0, -1).reduce((node, key) => node?.[key], freshLlm)
            if (op.op === 'unset') { if (parent !== undefined) delete parent[op.path[op.path.length - 1]] }
          }
        },
      },
      credentials: {
        ...ctx.credentials,
        resolve: async () => undefined,
        describe: async () => ({ configured: false }),
      },
      effect: (fn) => { const dispose = fn(); disposers.push(dispose); return () => {} },
      connection: { rpc: { handle: () => {} } },
    }
    await apply(ctx2, { baseUrl: base })
    await sleep(200)
    check('startup removed the key-less route (api key missing)', freshLlm.providers?.newapi === undefined)
    check('startup kept other providers', freshLlm.providers?.other !== undefined)
  }

  // 5. Second flow: user closing the login window surfaces a cancel error.
  await call('login.native.start', { baseUrl: base })
  check('second window opened', electron.windows.length === 3)
  const win2 = electron.windows[2]
  win2.close()
  const closedStatus = await status()
  check('window close settles as observable error', closedStatus.status === 'error' && closedStatus.error === 'canceled')
  await call('login.native.cancel')
  check('idle again after ack', (await status()).status === 'idle')

  // 6. Dispose: no throw, pending window force-closed.
  await call('login.native.start', { baseUrl: base })
  const win3 = electron.windows[3]
  for (const dispose of disposers) dispose()
  check('dispose closes the pending window', win3.destroyed === true)
  // The 401 sign-out is EXPECTED to warn once; nothing else may warn.
  check('only the expected sign-out warning', warns.length === 1 && warns[0].includes('signed out'))
} finally {
  await new Promise((resolve) => server.close(resolve))
}

if (failures > 0) {
  console.error(`login-flow: ${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('login-flow: all checks passed')
