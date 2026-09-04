/**
 * Real-composition check (manual): compose the actual installed bundle patches
 * in the desktop profile order and print the web-related rows.
 *
 *   node test/compose-check.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const desktopRequire = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dsh-plugin-desktop', 'package.json'))
const { composeEntries } = desktopRequire('@deepseek-ai/dsh-app-boot')
const { parseAllDocuments } = desktopRequire('yaml')

const testDir = dirname(fileURLToPath(import.meta.url))
const root = join(testDir, '..')
const desktopRoot = join(root, '..', 'dsh-plugin-desktop')
const nm = join(desktopRoot, 'node_modules')

const load = (path) => parseAllDocuments(readFileSync(path, 'utf8'))
  .flatMap((doc) => doc.toJS() ?? [])
  .flatMap((entry) => Array.isArray(entry) ? entry : [entry])

const patches = [
  ...load(join(nm, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml')),
  ...load(join(nm, '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml')),
  ...load(join(desktopRoot, 'cordis.patch.yml')),
  ...load(join(nm, 'dsh-plugin-newapi', 'cordis.patch.yml')),
  ...load(join(root, 'cordis.patch.yml')),
]
const rows = composeEntries([patches])
const byId = new Map(rows.map((row) => [row.id, row]))
for (const id of ['web', 'web-search-deepseek', 'web-fetch-http', 'tool-web', 'websearch', 'newapi']) {
  console.log(JSON.stringify(byId.get(id)))
}
