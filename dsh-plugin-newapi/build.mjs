/**
 * Build both halves of dsh-plugin-newapi:
 *
 * - lib/index.js  — Host Cordis plugin (ESM, Node). Runtime deps are externals
 *   resolved from the DSH profile's node_modules.
 * - lib/client.js — browser bundle in the DSH module-loader format:
 *   `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` with
 *   react/jsx-runtime and the shared UI primitives left external.
 *
 * esbuild is invoked as a CLI child with inherited stdio (its JS API spawns a
 * piped service process, which confined sandboxes deny), then the browser
 * body is wrapped into the loader factory shape with plain fs concatenation.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const out = (path) => join(root, path)
const require = createRequire(import.meta.url)

// Package + in-package subpath for each platform, matching esbuild's own
// lib/main.js pkgAndSubpathForCurrentPlatform() exactly (the Windows package
// ships its exe at its root; every other platform nests it under bin/).
const ESBUILD_PLATFORM_SUBPATHS = {
  'win32-x64': 'esbuild.exe',
  'win32-arm64': 'esbuild.exe',
  'win32-ia32': 'esbuild.exe',
  'linux-x64': 'bin/esbuild',
  'linux-arm64': 'bin/esbuild',
  'darwin-x64': 'bin/esbuild',
  'darwin-arm64': 'bin/esbuild',
}

/** Locate the platform esbuild binary via Node's own module resolution. */
function esbuildBinary() {
  const platformKey = `${process.platform}-${process.arch}`
  const subpath = ESBUILD_PLATFORM_SUBPATHS[platformKey]
  if (subpath === undefined) throw new Error(`esbuild platform binary not supported for ${platformKey}`)
  try {
    return require.resolve(`@esbuild/${platformKey}/${subpath}`)
  } catch (cause) {
    throw new Error('esbuild platform binary not found — run `npm install` or `corepack yarn install` first', { cause })
  }
}

const bin = esbuildBinary()

function runEsbuild(args) {
  const result = spawnSync(bin, args, { stdio: 'inherit', cwd: root })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`esbuild exited with ${String(result.status)}`)
}

mkdirSync(out('lib/types'), { recursive: true })

// --- Host bundle -----------------------------------------------------------
runEsbuild([
  out('src/index.ts'),
  '--bundle', '--format=esm', '--platform=node', '--target=node18',
  '--packages=external',
  '--outfile=' + out('lib/index.js'),
])

// --- Client bundle ---------------------------------------------------------
const ID = 'dsh-plugin-newapi'
const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(ID)},
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
  '--external:@deepseek-ai/cordis',
  '--external:@deepseek-ai/dsh-client-ui-primitives',
  '--external:@deepseek-ai/dsh-client-runtime',
  '--external:@deepseek-ai/dsh-client-runtime/client',
  '--outfile=' + out('lib/client.body.js'),
])

const body = readFileSync(out('lib/client.body.js'), 'utf8')
writeFileSync(out('lib/client.js'), `${banner}${body}${footer}`)
rmSync(out('lib/client.body.js'))

// --- Hand-written declarations --------------------------------------------
writeFileSync(out('lib/types/index.d.ts'), `/** Host Cordis plugin contract for dsh-plugin-newapi. */
import type { Context } from '@deepseek-ai/cordis'

export interface PluginConfig {
  route?: string
  apiKeyEnv?: string
  displayName?: string
}

export const name: string
export const inject: string[]
export function apply(ctx: Context, config?: PluginConfig): void
`)

writeFileSync(out('lib/types/client.d.ts'), `/** Browser plugin contract for dsh-plugin-newapi. */
export const inject: string[]
export function apply(ctx: unknown): void
`)

console.log('newapi: build complete')
