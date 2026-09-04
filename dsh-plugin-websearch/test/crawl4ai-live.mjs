/**
 * Manual live probe against a real Crawl4AI server — NOT part of `npm test`.
 *
 * Confirms the deployment's wire compatibility (endpoint, serialization,
 * extraction) once the server is reachable and prints the mapped sources:
 *
 *   node test/crawl4ai-live.mjs [baseUrl] [engine] [query]
 *
 * Defaults: http://172.24.204.251:21235 bing "crawl4ai docker deployment"
 * A CRAWL4AI_API_TOKEN environment variable is sent as a bearer token.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const root = process.cwd()
const [baseUrl = 'http://172.24.204.251:21235', engine = 'bing', query = 'crawl4ai docker deployment']
  = process.argv.slice(2)

const bin = ['win32-x64/esbuild.exe', 'linux-x64/esbuild', 'darwin-arm64/esbuild', 'darwin-x64/esbuild']
  .flatMap((rel) => [join(root, 'node_modules', '@esbuild', rel), join(root, '..', 'node_modules', '@esbuild', rel)])
  .find((path) => existsSync(path))
if (bin === undefined) throw new Error('esbuild binary not found')

const tmp = mkdtempSync(join(tmpdir(), 'websearch-live-'))
const built = join(tmp, 'provider.mjs')
const result = spawnSync(bin, [
  join(root, 'src', 'provider.ts'),
  '--bundle', '--format=esm', '--platform=node',
  '--alias:@deepseek-ai/dsh-web=' + join(root, 'test', 'stubs', 'dsh-web.mjs'),
  `--outfile=${built}`,
], { stdio: 'inherit' })
if (result.status !== 0) throw new Error('esbuild failed')

try {
  const { GenericSearchProvider, lookupEngine, buildSerpUrl } = await import(`file://${built.replaceAll('\\', '/')}`)
  const preset = lookupEngine(engine) ?? lookupEngine('bing')
  console.log(`probe: GET ${baseUrl}/health …`)
  try {
    const health = await fetch(`${baseUrl.replace(/\/+$/u, '')}/health`, { signal: AbortSignal.timeout(5000) })
    console.log('health:', health.status, await health.text().then((text) => text.slice(0, 200)))
  } catch (error) {
    console.error(`health check failed (server unreachable?): ${String(error)}`)
  }
  console.log(`probe: search "${query}" via ${preset.id} → ${buildSerpUrl(preset, query)}`)
  const provider = new GenericSearchProvider(() => ({
    baseUrl,
    engine: preset.id,
    timeoutMs: 90_000,
    ...(process.env.CRAWL4AI_API_TOKEN !== undefined ? { apiToken: process.env.CRAWL4AI_API_TOKEN } : {}),
  }))
  const found = await provider.search({ query, maxResults: 8 })
  console.log(`mapped ${String(found.sources.length)} source(s):`)
  for (const source of found.sources) {
    console.log(`  - [${source.title ?? source.url}](${source.url})`)
    if (source.snippet !== undefined) console.log(`      ${source.snippet.slice(0, 160)}`)
  }
} catch (error) {
  console.error(`search failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
