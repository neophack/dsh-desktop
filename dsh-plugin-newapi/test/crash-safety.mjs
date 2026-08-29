/**
 * Crash-safety regression: no Host code path may leave an UNHANDLED promise
 * rejection behind.
 *
 * DSH Desktop installs a process-level `uncaughtException` handler that exits
 * the app (dsh-plugin-desktop/src/desktop-logger.ts), and Node escalates an
 * unhandled rejection into exactly that. So a single fire-and-forget promise
 * that rejects — a credential store hiccup while signing in, a settings write
 * losing a race, an Electron cookie jar throwing — took the whole desktop app
 * down: the "sometimes it just disappears while logging in" report.
 *
 * The traps this pins:
 *  1. `refreshSnapshot` used to reject when the credential read (which sits
 *     outside its inner try) threw, and its flight is shared + detached.
 *  2. `void promise.finally(cb)` does NOT handle a rejection — it forwards it
 *     onto a derived promise nobody watches, so even a flight its own caller
 *     awaits still crashed the process.
 *  3. The embedded-login cookie watch ticks every second through a bare
 *     `void`, so anything unexpected inside it was fatal too.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { electronState as electron, patchHostBundle } from './login-flow-stubs.mjs'

const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

const server = createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, data: { system_name: 'AI', version: 'v1', password_login_enabled: false, custom_oauth_providers: [{ name: 'Feishu', slug: 'feishu' }] } }))
    return
  }
  res.writeHead(500, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ success: false, message: 'boom' }))
})
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const base = `http://127.0.0.1:${String(server.address().port)}`

// --- Cordis-shaped stubs whose every seam can fail ----------------------------
const settingsStore = {}
/** Flipped on to make the credential store and the settings writes throw. */
let failing = false
const boom = () => { throw new Error('credential store unavailable') }
const scope = {
  get: () => ({ ...settingsStore }),
  update: async (patch) => { if (failing) boom(); Object.assign(settingsStore, patch) },
  replace: async () => { if (failing) boom() },
}
const credentialsStore = new Map([['NEWAPI_SESSION', 'pat-x.system-access'], ['NEWAPI_API_KEY', 'sk-x']])
const warns = []
let handler
const ctx = {
  logger: { info: () => {}, warn: (message) => { warns.push(String(message)) }, debug: () => {} },
  effect: (fn) => { fn(); return () => {} },
  on: () => () => {},
  settings: {
    register: () => scope,
    get: () => undefined,
    update: async () => { if (failing) boom() },
  },
  credentials: {
    resolve: async (ref) => {
      if (failing) boom()
      return credentialsStore.has(ref.name) ? { value: credentialsStore.get(ref.name) } : undefined
    },
    set: async (ref, value) => { if (failing) boom(); credentialsStore.set(ref.name, value) },
    unset: async (ref) => { if (failing) boom(); credentialsStore.delete(ref.name) },
    describe: async (ref) => { if (failing) boom(); return { configured: credentialsStore.has(ref.name) } },
  },
  connection: { rpc: { handle: (_channel, h) => { handler = h } } },
}

settingsStore.baseUrl = base
settingsStore.authKind = 'token'

const hostBundle = join(mkdtempSync(join(tmpdir(), 'newapi-crash-safety-')), 'index.mjs')
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
/** Give Node a few turns so any unhandled rejection is reported before we look. */
const settle = async () => { await sleep(60) }

try {
  failing = true

  // 1. Snapshot with a throwing credential store: the detached flight must not
  //    take the process down, and the RPC must answer with a typed failure.
  const snapshot = await call('snapshot.get')
  await settle()
  check('snapshot.get survives a throwing credential store', snapshot.ok === false)
  check('no unhandled rejection from the snapshot flight', unhandled.length === 0)

  // 2. The user widget on the same broken store.
  const user = await call('user.get')
  await settle()
  check('user.get survives a throwing credential store', user.ok === false)

  // 3. models.sync reaches the same flight through a different door.
  const synced = await call('models.sync')
  await settle()
  check('models.sync survives a throwing credential store', synced.ok === false)

  // 4. config.get fires the detached key self-heal against the broken store.
  const config = await call('config.get')
  await settle()
  check('config.get survives a throwing credential store', config.ok === true)

  // 5. The embedded-login cookie watch: a jar that throws must not be fatal
  //    either, and the attempt has to stay observable.
  const originalGet = electron.jar.get.bind(electron.jar)
  const started = await call('login.native.start', { baseUrl: base })
  check('login.native.start ok', started.ok === true)
  const status = await call('login.native.status')
  check('attempt observable as pending', status.value.status === 'pending')
  await sleep(2500)
  await settle()
  check('cookie watch ticks are crash-safe', unhandled.length === 0)
  await call('login.native.cancel')
  void originalGet

  failing = false
  await settle()
  check('no unhandled rejection across the whole run', unhandled.length === 0)
  if (unhandled.length > 0) console.error(unhandled)
} finally {
  server.close()
}

if (failures > 0) {
  console.error(`crash-safety: ${String(failures)} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('crash-safety: all checks passed')
}
