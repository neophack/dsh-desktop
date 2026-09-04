/**
 * Loader-patch and build-output shape test.
 *
 * The bundle patch is what turns the shipped DeepSeek search into the generic
 * Crawl4AI search, so its exact rows are regression-critical: an override of
 * the `web` row that restates BOTH provider selections (loader overrides
 * replace a row's config wholesale — dropping `fetchProvider` would break
 * web_fetch), the disabled upstream `web-search-deepseek` row, and the
 * inserted `websearch` row with the product's Crawl4AI address.
 *
 * Usage: node test/patch-shape.mjs   (from the package root, after build)
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
let failures = 0
const check = (name, condition) => {
  if (condition) {
    console.log(`  ok: ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL: ${name}`)
  }
}

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
check('web row overridden', /- id: web\s*\n\s+config:/u.test(patch))
check('search provider repointed to crawl4ai', /searchProvider:\s*crawl4ai\s*\n/u.test(patch))
check('fetch provider restated (config replaces wholesale)', /fetchProvider:\s*http\s*\n/u.test(patch))
check('deepseek search row disabled', /- id: web-search-deepseek\s*\n\s+disabled:\s*true\s*\n/u.test(patch))
check('websearch row inserted', /- id: websearch\s*\n\s+name:\s*dsh-plugin-websearch\s*\n/u.test(patch))
check('default Crawl4AI address shipped', patch.includes('baseUrl: http://172.24.204.251:21235'))
check('default engine is bing', /engine:\s*bing\s*\n/u.test(patch))

const built = join(root, 'lib', 'index.js')
if (!existsSync(built)) {
  console.error('  FAIL: lib/index.js missing — run `corepack yarn workspace dsh-plugin-websearch build` first')
  failures += 1
} else {
  const bundle = readFileSync(built, 'utf8')
  check('built entry exports the plugin name', bundle.includes('dsh-plugin-websearch'))
  check('built entry keeps the provider id', bundle.includes('crawl4ai'))
  check('built entry has no default export', /^export\s+default\s/mu.test(bundle) === false)
  check('built entry registers into ctx.web', /registerSearchProvider/u.test(bundle))
}

if (failures > 0) {
  console.error(`${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('websearch patch shape: all checks passed')
