/**
 * Snapshot disk-cache regression test: drives the REAL built Host bundle
 * (lib/index.js, app-only imports swapped for doubles) against a mock NewAPI
 * server and verifies the offline caching contract:
 *
 * 1. A successful snapshot is persisted to the cache file (keyed by baseUrl).
 * 2. When the server is unreachable, snapshot.get (force and non-force)
 *    serves the stale cache with {stale: true} instead of an error.
 * 3. A fresh Host instance seeds its cache from disk, so the first window
 *    open after a (re)start shows data instantly while offline.
 * 4. config.clear drops the persisted cache (no stale account data leaks).
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { patchHostBundle } from './login-flow-stubs.mjs'

const USER = { id: 42, username: 'root', display_name: 'Root', email: 'root@example.com', quota: -1, used_quota: 0, request_count: 5 }

const server = createServer((req, res) => {
  const send = (data) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, data }))
  }
  if (req.url === '/api/status') {
    send({ system_name: 'AI', version: 'v1.0.0-rc.test', quota_per_unit: 500_000, usd_exchange_rate: 7.3 })
    return
  }
  if (req.method === 'POST' && req.url === '/api/user/auth/refresh') {
    send({ access_token: 'bearer.1.sig', access_expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER })
    return
  }
  if (req.url === '/api/user/self') { send(USER); return }
  if (req.url?.startsWith('/api/token/?')) { send({ items: [{ id: 1, name: 'default', key: 'sk-tail', quota: -1, used_quota: 0, models: '-1', expired_time: -1 }] }); return }
  if (req.url === '/api/user/models') { send(['gpt-x', 'gpt-y']); return }
  if (req.url === '/api/pricing') { send({ data: [] }); return }
  res.writeHead(404).end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${String(server.address().port)}`
const cacheDir = mkdtempSync(join(tmpdir(), 'newapi-snapshot-cache-'))
process.env.DSH_NEWAPI_CACHE_DIR = cacheDir

const settingsStore = {}
const scope = { get: () => ({ ...settingsStore }), update: async (patch) => { Object.assign(settingsStore, patch) } }
const credentialsStore = new Map()
const disposers = []
let handler
const makeCtx = () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  effect: (fn) => { const dispose = fn(); disposers.push(dispose); return () => {} },
  settings: {
    register: () => scope,
    get: () => undefined,
    update: async () => { throw new Error('unexpected settings namespace') },
  },
  credentials: {
    resolve: async (ref) => (credentialsStore.has(ref.name) ? { value: credentialsStore.get(ref.name) } : undefined),
    set: async (ref, value) => { credentialsStore.set(ref.name, value) },
    unset: async (ref) => { credentialsStore.delete(ref.name) },
    describe: async (ref) => ({ configured: credentialsStore.has(ref.name) }),
  },
  connection: { rpc: { handle: (_channel, h) => { handler = h } } },
})

const bundleSource = patchHostBundle(readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8'))
let bundleSeq = 0
const loadHost = async () => {
  const file = join(cacheDir, `host-${String(bundleSeq += 1)}.mjs`)
  writeFileSync(file, bundleSource, 'utf8')
  const { apply } = await import(pathToFileURL(file).href)
  apply(makeCtx(), { baseUrl: base })
  return (endpoint, payload) => handler(endpoint, payload, undefined)
}

credentialsStore.set('NEWAPI_SESSION', 'nar.a.b')

let failures = 0
const check = (name, condition) => {
  if (condition) console.log(`  ok: ${name}`)
  else { failures += 1; console.error(`  FAIL: ${name}`) }
}

try {
  // 1. Online: fresh snapshot, persisted to disk.
  const online = await loadHost()
  const fresh = await online('snapshot.get')
  check('online snapshot ok', fresh.ok === true && fresh.value.user?.username === 'root' && fresh.value.stale !== true)
  const cacheFile = join(cacheDir, 'newapi-snapshots.json')
  await new Promise((resolve) => setTimeout(resolve, 300))
  check('cache file written', existsSync(cacheFile) === true)
  const onDisk = JSON.parse(readFileSync(cacheFile, 'utf8'))
  check('cache keyed by baseUrl with payload', onDisk[base]?.payload?.user?.username === 'root')

  // 2. Offline: force and plain snapshot.get fall back to the stale cache.
  await new Promise((resolve) => server.close(resolve))
  const forced = await online('snapshot.get', { force: true })
  check('offline force refresh serves stale cache', forced.ok === true && forced.value.stale === true && forced.value.cachedAt !== undefined
    && forced.value.user?.username === 'root')
  const plain = await online('snapshot.get')
  check('offline plain get serves stale cache', plain.ok === true && plain.value.stale === true)

  // 3. Fresh Host instance (restart) seeds from disk; age the entry past the
  //    TTL so the first get takes the stale-serve path while offline.
  const aged = { ...onDisk }
  aged[base] = { ...aged[base], at: Date.now() - 120_000 }
  writeFileSync(cacheFile, JSON.stringify(aged), 'utf8')
  const restarted = await loadHost()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const afterRestart = await restarted('snapshot.get')
  check('restart serves the persisted snapshot instantly (stale, offline)', afterRestart.ok === true
    && afterRestart.value.stale === true && afterRestart.value.user?.username === 'root')
  const userView = await restarted('user.get')
  check('offline user.get falls back to the cached user', userView.ok === true && userView.value?.username === 'root')

  // 4. Signing out drops the persisted cache.
  await restarted('config.clear')
  await new Promise((resolve) => setTimeout(resolve, 300))
  check('config.clear drops the cache file', existsSync(cacheFile) === false)
} finally {
  for (const dispose of disposers) dispose()
}

if (failures > 0) {
  console.error(`snapshot-cache: ${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('snapshot-cache: all checks passed')
