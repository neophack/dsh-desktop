/**
 * Module-shape and registration smoke test for the built entry.
 *
 * Runs the real src/index.ts (bundled with stubs for the three DSH runtime
 * packages that only resolve inside a DSH profile) against a fake Cordis
 * context and asserts:
 *  - the Loader's unwrapExports contract: named exports only, NO default
 *    export (a default would collapse the namespace and drop `inject`);
 *  - `inject` names the web seam and nothing else;
 *  - `apply` installs the `websearch` settings section and registers one
 *    search provider under id "crawl4ai" that is available with defaults.
 *
 * Usage: node test/smoke.mjs   (from the package root)
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const root = process.cwd()

const bin = ['win32-x64/esbuild.exe', 'linux-x64/esbuild', 'darwin-arm64/esbuild', 'darwin-x64/esbuild']
  .flatMap((rel) => [join(root, 'node_modules', '@esbuild', rel), join(root, '..', 'node_modules', '@esbuild', rel)])
  .find((path) => existsSync(path))
if (bin === undefined) throw new Error('esbuild binary not found — run `corepack yarn install` first')

const tmp = mkdtempSync(join(tmpdir(), 'websearch-smoke-'))
const built = join(tmp, 'index.mjs')
const result = spawnSync(bin, [
  join(root, 'src', 'index.ts'),
  '--bundle', '--format=esm', '--platform=node',
  '--alias:@deepseek-ai/dsh-web=' + join(root, 'test', 'stubs', 'dsh-web.mjs'),
  '--alias:@deepseek-ai/schemastery=' + join(root, 'test', 'stubs', 'schemastery.mjs'),
  '--alias:@deepseek-ai/dsh-launch-environment=' + join(root, 'test', 'stubs', 'dsh-launch-environment.mjs'),
  `--outfile=${built}`,
], { stdio: 'inherit' })
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
  const plugin = await import(`file://${built.replaceAll('\\', '/')}`)

  // 1. Loader export contract.
  check('has name', typeof plugin.name === 'string' && plugin.name === 'dsh-plugin-websearch')
  check('inject = [web]', Array.isArray(plugin.inject) && plugin.inject.join(',') === 'web')
  check('has Config schema', plugin.Config !== undefined && plugin.Config !== null)
  check('has apply', typeof plugin.apply === 'function')
  check('no default export (unwrapExports contract)', plugin.default === undefined)
  check('exports provider id constant', plugin.GENERIC_PROVIDER_ID === 'crawl4ai')
  check('exports default base URL', plugin.DEFAULT_BASE_URL === 'http://172.24.204.251:21235')

  // 2. Registration against a fake context.
  const installedSections = []
  const registered = []
  const fakeSettings = {
    installSection: (ctx, namespace, schema, config, hooks) => {
      installedSections.push(namespace)
      // Mirror the real service: the initial source projects the row config.
      hooks.setSource(() => config)
    },
  }
  const ctx = {
    inject: (_deps, callback) => callback({ settings: fakeSettings }),
    get: () => undefined,
    web: {
      registerSearchProvider: (provider) => {
        registered.push(provider)
        return () => {}
      },
    },
    effect: () => () => {},
  }
  plugin.apply(ctx, { baseUrl: 'http://172.24.204.251:21235', engine: 'bing', timeoutMs: 60000 })

  check('settings section "websearch" installed', installedSections.join(',') === 'websearch')
  check('one search provider registered', registered.length === 1)
  const provider = registered[0]
  check('provider id = crawl4ai', provider.id === 'crawl4ai')
  check('provider available with row config', provider.available() === true)
  check('empty query resolves to empty result',
    await provider.search({ query: '   ' }).then((r) => r.sources.length === 0 && r.truncated === false))

  // 3. Unavailable states the seam reports as configured-unavailable.
  const unavailable = new plugin.GenericSearchProvider(() => ({
    baseUrl: 'http://172.24.204.251:21235',
    engine: 'no-such-engine',
    timeoutMs: 60000,
  }))
  check('unknown engine marks provider unavailable', unavailable.available() === false)
  const badTemplate = new plugin.GenericSearchProvider(() => ({
    baseUrl: 'http://172.24.204.251:21235',
    engine: 'bing',
    serpUrlTemplate: 'https://example.com/search?x=1',
    timeoutMs: 60000,
  }))
  check('serp template without {query} marks provider unavailable', badTemplate.available() === false)
  check('template with {query} stays available', new plugin.GenericSearchProvider(() => ({
    baseUrl: 'http://172.24.204.251:21235',
    engine: 'bing',
    serpUrlTemplate: 'https://example.com/s?q={query}',
    timeoutMs: 60000,
  })).available() === true)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('websearch smoke: all checks passed')
