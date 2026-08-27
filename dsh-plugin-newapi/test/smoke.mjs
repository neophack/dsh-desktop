/**
 * Functional smoke test: run the real NewApiClient source against a local mock
 * of the NewAPI management API (v1.0.0-rc.x wire shapes) and assert:
 *  - public server status parsing (custom OAuth providers, quota_per_unit),
 *  - password login -> session cookie -> /api/user/auth/refresh -> bearer,
 *  - session rotation persistence via onSessionRotated,
 *  - embedded OAuth flow: /api/oauth/state minted in the client jar, code
 *    exchange with the same jar authenticates (the Host's zero-paste login),
 *  - token list / models / pricing parsing, quota conversion, error mapping.
 *
 * Usage: node test/smoke.mjs   (from the package root, after npm install)
 */
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const PERSONAL_TOKEN = 'sk-test-token-1234'
const PASSWORD = 'correct-horse'
const USER = { id: 42, username: 'alice', display_name: 'Alice', email: 'alice@example.com', quota: 5_000_000, used_quota: 2_500_000, request_count: 7, group: 'vip' }

let counter = 0
const sessions = new Set()
const stateBySession = new Map()
const bearers = new Set()
const createdTokens = []
let emptyTokens = false
let sawNewApiUserHeader = false
let checkedBearerAuth = false

function mintSession() {
  counter += 1
  const value = `jwt${String(counter)}.sig`
  sessions.add(value)
  return value
}

function mintBearer() {
  counter += 1
  const value = `tok${String(counter)}.a.b`
  bearers.add(value)
  return value
}

const cookiesOf = (req) => {
  const header = req.headers.cookie ?? ''
  const jar = new Map()
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  return jar
}

const server = createServer((req, res) => {
  const send = (data, extraHeaders = {}) => {
    res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders })
    res.end(JSON.stringify({ success: true, data }))
  }
  const deny = (message, status = 401) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: false, message }))
  }

  // Public: server capabilities.
  if (req.method === 'GET' && req.url === '/api/status') {
    send({
      system_name: 'AI',
      version: 'v1.0.0-rc.25',
      quota_per_unit: 500_000,
      usd_exchange_rate: 7.3,
      password_login_enabled: true,
      github_oauth: false,
      linuxdo_oauth: false,
      oidc_enabled: false,
      wechat_login: false,
      custom_oauth_providers: [{ id: 1, name: '飞书', slug: 'feishu', client_id: 'cli_x', authorization_endpoint: 'https://accounts.example/open-apis/authen/v1/authorize', scopes: 'contact:user.id' }],
    })
    return
  }

  // Login: issues the session cookie.
  if (req.method === 'POST' && req.url === '/api/user/login?turnstile=') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const { username, password } = JSON.parse(body)
      if (username !== USER.username || password !== PASSWORD) {
        deny('用户名或密码错误')
        return
      }
      send({}, { 'set-cookie': `session=${mintSession()}; Path=/; HttpOnly` })
    })
    return
  }

  // OAuth state: binds a state value to the caller's session cookie.
  if (req.method === 'POST' && req.url === '/api/oauth/state') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const { provider, intent } = JSON.parse(body)
      if (provider !== 'feishu' || intent !== 'login') {
        deny('provider not supported', 400)
        return
      }
      const session = mintSession()
      stateBySession.set(session, `st${String(counter)}`)
      send(`st${String(counter)}`, { 'set-cookie': `session=${session}; Path=/; HttpOnly` })
    })
    return
  }

  // OAuth code exchange: requires the state bound to the caller's session.
  if (req.method === 'GET' && req.url?.startsWith('/api/oauth/feishu')) {
    const url = new URL(req.url, base)
    const session = cookiesOf(req).get('session')
    const expected = session !== undefined ? stateBySession.get(session) : undefined
    if (expected === undefined || url.searchParams.get('state') !== expected || url.searchParams.get('code') === '') {
      deny('state mismatch', 401)
      return
    }
    stateBySession.delete(session)
    send({}, { 'set-cookie': `session=${mintSession()}; Path=/; HttpOnly` })
    return
  }

  // Refresh: rotates the session cookie and mints a short-lived bearer.
  if (req.method === 'POST' && req.url === '/api/user/auth/refresh') {
    const session = cookiesOf(req).get('session')
    if (session === undefined || !sessions.has(session)) {
      deny('无权进行此操作，未登录...')
      return
    }
    send(
      {
        access_token: mintBearer(),
        token_type: 'Bearer',
        access_expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: USER,
        session: { sid: 's1', current: true, login_method: 'password' },
      },
      { 'set-cookie': `session=${mintSession()}; Path=/; HttpOnly` },
    )
    return
  }

  // Everything below requires a bearer (personal token or minted access token).
  const auth = req.headers.authorization ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const authorized = bearer === PERSONAL_TOKEN || bearers.has(bearer)
  if (!authorized) {
    deny('无权进行此操作，未登录...')
    return
  }
  checkedBearerAuth = true
  if (req.headers['new-api-user'] === String(USER.id)) sawNewApiUserHeader = true

  if (req.method === 'GET' && req.url === '/api/user/self') {
    send(USER)
  } else if (req.method === 'POST' && req.url === '/api/token/') {
    // Create: appends a token and returns bare success (wire shape of AddToken).
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const { name, expired_time, unlimited_quota } = JSON.parse(body)
      counter += 1
      createdTokens.push({ id: 100 + createdTokens.length, name, expired_time, unlimited_quota, key: `sk-created${String(counter)}` })
      send(null)
    })
    return
  } else if (/^\/api\/token\/\d+\/key$/.test(req.url ?? '')) {
    const id = Number.parseInt((req.url ?? '').split('/')[3], 10)
    const hit = [...createdTokens, { id: 1, key: 'sk-abcde1234-full' }, { id: 2, key: 'sk-fghi5678-full' }].find((row) => row.id === id)
    if (hit === undefined) {
      deny('token not found', 404)
      return
    }
    send({ key: hit.key })
  } else if (req.method === 'GET' && req.url?.startsWith('/api/token/')) {
    const seeded = emptyTokens
      ? []
      : [
          { id: 1, name: 'default', key: 'sk-abcde1234', quota: -1, used_quota: 0, models: '-1', expired_time: -1 },
          { id: 2, name: 'ci', key: 'sk-fghi5678', quota: 1_000_000, used_quota: 250_000, models: 'gpt-4o,claude-3-5' },
        ]
    send({
      items: [
        ...seeded,
        ...createdTokens.map(({ id, name, expired_time, unlimited_quota }) => ({ id, name, key: 'sk-masked', quota: unlimited_quota === true ? -1 : 0, used_quota: 0, models: '-1', expired_time })),
      ],
    })
  } else if (req.method === 'GET' && req.url === '/api/user/models') {
    send(['gpt-4o', 'claude-3-5', 'deepseek-chat'])
  } else if (req.method === 'GET' && req.url === '/api/pricing') {
    send([
      { model_name: 'gpt-4o', model_price: 2.5, model_out_price: 10, quota_type: 0 },
      { model_name: 'claude-3-5', model_price: 3, model_out_price: 15, quota_type: 0 },
    ])
  } else {
    res.writeHead(404)
    res.end()
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${String(port)}`

// Bundle the real client source (same transform the host build uses).
const bin = ['win32-x64/esbuild.exe', 'linux-x64/esbuild', 'darwin-arm64/esbuild', 'darwin-x64/esbuild']
  .map((rel) => join(process.cwd(), 'node_modules', '@esbuild', rel))
  .find((path) => existsSync(path))
if (bin === undefined) throw new Error('esbuild binary not found — run npm install first')

const tmp = mkdtempSync(join(tmpdir(), 'newapi-smoke-'))
const built = join(tmp, 'client.mjs')
const result = spawnSync(bin, [join(process.cwd(), 'src', 'newapi-client.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${built}`], { stdio: 'inherit' })
if (result.status !== 0) throw new Error('esbuild failed')

let failures = 0
const check = (name, condition) => {
  if (condition) {
    console.log(`  ok: ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL: ${name}`)
  }
}

try {
  const { NewApiClient, NewApiError, mergeModels, usageFromUser } = await import(`file://${built.replaceAll('\\', '/')}`)

  // 1. Public server probe.
  const info = await new NewApiClient({ baseUrl: base }).getServerInfo()
  check('status.systemName', info.systemName === 'AI')
  check('status.version', info.version === 'v1.0.0-rc.25')
  check('status.oauthProviders[0].slug = feishu', info.oauthProviders[0]?.slug === 'feishu')
  check('status.quotaPerUnit', info.quotaPerUnit === 500_000)
  check('status.usdExchangeRate', info.usdExchangeRate === 7.3)
  check('status.passwordLogin', info.passwordLogin === true)

  // 2. Password login: session cookie -> refresh -> bearer -> profile.
  const rotations = []
  const login = new NewApiClient({ baseUrl: base, onSessionRotated: (value) => rotations.push(value) })
  const user = await login.loginWithPassword(USER.username, PASSWORD)
  check('login.user.id', user.id === 42)
  check('login issued a session', typeof login.sessionValue() === 'string' && login.sessionValue() !== '')
  check('login rotation observed', rotations.length === 1 && rotations[0] === login.sessionValue())

  // 3. The rotated session value authenticates a fresh client (bridge flow).
  const bridged = new NewApiClient({ baseUrl: base })
  bridged.adopt({ kind: 'session', value: login.sessionValue() })
  const bridgedUser = await bridged.getUser()
  check('bridged session authenticates', bridgedUser.username === USER.username)

  // 3b. Embedded OAuth: state minted in this client's jar, code exchanged with
  // the same jar authenticates and rotates the session — the credential the
  // Host persists automatically, with no copy/paste.
  check('oauth provider endpoints parsed', info.oauthProviders[0]?.authorizationEndpoint === 'https://accounts.example/open-apis/authen/v1/authorize' && info.oauthProviders[0]?.clientId === 'cli_x' && info.oauthProviders[0]?.scopes === 'contact:user.id')
  const embeddedClient = new NewApiClient({ baseUrl: base })
  const state = await embeddedClient.createOAuthState('feishu')
  check('oauth state minted', typeof state === 'string' && state.startsWith('st'))
  let wrongStateRejected = false
  try {
    await embeddedClient.exchangeOAuthCode('feishu', 'code-1', 'st-wrong')
  } catch (error) {
    wrongStateRejected = error instanceof NewApiError && error.status === 401
  }
  check('oauth wrong state rejected with 401', wrongStateRejected)
  await embeddedClient.exchangeOAuthCode('feishu', 'code-1', state)
  const embeddedUser = await embeddedClient.getUser()
  check('oauth exchange authenticates', embeddedUser.username === USER.username)
  check('oauth session captured', typeof embeddedClient.sessionValue() === 'string' && embeddedClient.sessionValue() !== '')

  // 4. Personal access token authenticates directly (no session, no refresh).
  const tokenClient = new NewApiClient({ baseUrl: base, auth: { kind: 'token', value: PERSONAL_TOKEN } })
  const tokenUser = await tokenClient.getUser()
  check('personal token authenticates', tokenUser.group === 'vip')

  // 5. Data endpoints via the token client.
  const tokens = await tokenClient.getTokens()
  check('tokens.length', tokens.length === 2)
  check('tokens[0].quota unlimited', tokens[0].quota === -1)
  check('tokens[1].models', tokens[1].models === 'gpt-4o,claude-3-5')

  // 5b. ensureApiKey: existing account -> first token's full key.
  const ensured = await tokenClient.ensureApiKey()
  check('ensure uses the first existing token', ensured.token.id === 1 && ensured.key === 'sk-abcde1234-full')

  // 5c. ensureApiKey: empty account -> creates one, returns the new full key.
  emptyTokens = true
  const fresh = new NewApiClient({ baseUrl: base, auth: { kind: 'token', value: PERSONAL_TOKEN } })
  const created = await fresh.ensureApiKey()
  check('ensure creates when none exist', created.token.name === 'DSH' && created.key.startsWith('sk-created'))
  check('created token visible in list', (await fresh.getTokens()).some((row) => row.id === created.token.id))
  emptyTokens = false

  const models = await tokenClient.getModels()
  check('models', models.join(',') === 'gpt-4o,claude-3-5,deepseek-chat')

  const pricing = await tokenClient.getPricing()
  check('pricing gpt-4o input', pricing.get('gpt-4o')?.input === 2.5)
  check('pricing claude output', pricing.get('claude-3-5')?.output === 15)

  const merged = mergeModels(models, pricing)
  check('merged deepseek unpriced', merged.find((m) => m.id === 'deepseek-chat')?.priced === false)
  check('merged gpt-4o priced', merged.find((m) => m.id === 'gpt-4o')?.priced === true)

  const usage = usageFromUser(USER, info.quotaPerUnit)
  check('usage.quotaUsed = 5.00 USD', usage.quotaUsed === 5)
  check('usage.quotaRemaining = 10.00 USD', usage.quotaRemaining === 10)
  check('usage.quotaTotal = 15.00 USD', usage.quotaTotal === 15)
  check('usage not unlimited', usage.unlimited === false)

  // 6. Failure mapping.
  const bad = new NewApiClient({ baseUrl: base, auth: { kind: 'token', value: 'sk-wrong' } })
  let rejected = false
  try {
    await bad.getUser()
  } catch (error) {
    rejected = error instanceof NewApiError && error.status === 401
  }
  check('wrong token rejected with 401 NewApiError', rejected)

  const stale = new NewApiClient({ baseUrl: base })
  stale.adopt({ kind: 'session', value: 'jwtX.sig' })
  let staleRejected = false
  try {
    await stale.getUser()
  } catch (error) {
    staleRejected = error instanceof NewApiError && error.status === 401
  }
  check('stale session rejected with 401 NewApiError', staleRejected)

  const wrongPassword = new NewApiClient({ baseUrl: base })
  let passwordRejected = false
  try {
    await wrongPassword.loginWithPassword(USER.username, 'nope')
  } catch (error) {
    passwordRejected = error instanceof NewApiError
  }
  check('wrong password rejected', passwordRejected)

  check('bearer auth was exercised', checkedBearerAuth)
  check('new-api-user header sent after id learned', sawNewApiUserHeader)
} finally {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('newapi client smoke: all checks passed')
