/**
 * Build both halves of dsh-plugin-websearch:
 *
 * - lib/index.js  — Host Cordis plugin (ESM, Node). Runtime deps are externals
 *   resolved from the DSH profile's node_modules (the same contract as
 *   dsh-plugin-newapi).
 * - lib/client.js — browser bundle in the DSH module-loader format:
 *   `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` with
 *   react/jsx-runtime left external. The client half is the Settings page
 *   registered right after the NewAPI entry.
 *
 * esbuild is invoked as a CLI child with inherited stdio (its JS API spawns a
 * piped service process, which confined sandboxes deny), then the browser
 * body is wrapped into the loader factory shape with plain fs concatenation.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const out = (path) => join(root, path)

/** Locate the platform esbuild binary: package-local first, then the repo root. */
function esbuildBinary() {
  const candidates = [
    join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    join(root, 'node_modules', '@esbuild', 'linux-x64', 'esbuild'),
    join(root, 'node_modules', '@esbuild', 'darwin-arm64', 'esbuild'),
    join(root, 'node_modules', '@esbuild', 'darwin-x64', 'esbuild'),
    join(root, '..', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    join(root, '..', 'node_modules', '@esbuild', 'linux-x64', 'esbuild'),
    join(root, '..', 'node_modules', '@esbuild', 'darwin-arm64', 'esbuild'),
    join(root, '..', 'node_modules', '@esbuild', 'darwin-x64', 'esbuild'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error('esbuild platform binary not found — run `npm install` or `corepack yarn install` first')
}

const bin = esbuildBinary()

function runEsbuild(args) {
  const result = spawnSync(bin, args, { stdio: 'inherit', cwd: root })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`esbuild exited with ${String(result.status)}`)
}

// --- Host bundle -----------------------------------------------------------
runEsbuild([
  out('src/index.ts'),
  '--bundle', '--format=esm', '--platform=node', '--target=node18',
  '--packages=external',
  '--outfile=' + out('lib/index.js'),
])

mkdirSync(out('lib/types'), { recursive: true })
// Hand-written declarations, matching the dsh-plugin-newapi convention.
// NOTE: keep in sync with src/index.ts exports; the Loader's unwrapExports
// contract forbids a default export.
writeFileSync(out('lib/types/index.d.ts'), `/** Host Cordis plugin contract for dsh-plugin-websearch. */
import type { Context } from '@deepseek-ai/cordis'

export interface PluginConfig {
  /** Crawl4AI server origin; \`/crawl\` is appended. */
  baseUrl?: string
  /** SERP engine preset: 'bing' (default) or 'duckduckgo'. */
  engine?: string
  /** Custom SERP URL template containing '{query}'. */
  serpUrl?: string
  /** Literal Crawl4AI server token. */
  apiToken?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
}

export const name: string
export const inject: string[]
export const WEBSEARCH_SETTINGS_NAMESPACE: string
export function apply(ctx: Context, config?: PluginConfig): void
`)

// --- Client bundle ---------------------------------------------------------
const CLIENT_ID = 'dsh-plugin-websearch'
const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(CLIENT_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
`
const footer = `
\t\treturn module.exports;
\t}
});
`

runEsbuild([
  out('src/client.tsx'),
  '--bundle', '--format=cjs', '--platform=browser', '--target=es2020',
  '--jsx=automatic',
  '--external:react', '--external:react/jsx-runtime', '--external:react-dom',
  '--outfile=' + out('lib/client.body.js'),
])

const body = readFileSync(out('lib/client.body.js'), 'utf8')
writeFileSync(out('lib/client.js'), `${banner}${body}${footer}`)
rmSync(out('lib/client.body.js'))

// Hand-written declaration, matching the dsh-plugin-newapi convention.
writeFileSync(out('lib/types/client.d.ts'), `/** Browser Cordis plugin contract for dsh-plugin-websearch. */
export const inject: string[]
export function apply(ctx: unknown): void
`)

console.log('websearch: build complete')
