/**
 * Functional tests for the generic Crawl4AI search provider.
 *
 * The real src/provider.ts is bundled with a stub for '@deepseek-ai/dsh-web'
 * (the only runtime import; the seam never instanceof-checks provider errors,
 * so the stub exercises every error path faithfully) and exercised against a
 * local HTTP server speaking the Crawl4AI /crawl wire shape:
 *  - SERP URL building per engine and custom template,
 *  - the REST serialization contract ({type, params} + dict-wrapped schema),
 *  - href decoding (protocol-relative, DuckDuckGo uddg unwrap),
 *  - response mapping: structured rows, markdown fallback, links fallback,
 *    dedupe, engine-internal filtering, error tiers,
 *  - search(): happy path, bearer token, maxResults, HTTP error body,
 *    non-JSON body, caller abort (WEB_ABORTED), timeout, recordRequest.
 *
 * Usage: node test/provider.mjs   (from the package root)
 */
import { createServer } from 'node:http'
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

const tmp = mkdtempSync(join(tmpdir(), 'websearch-provider-'))
const built = join(tmp, 'provider.mjs')
const result = spawnSync(bin, [
  join(root, 'src', 'provider.ts'),
  '--bundle', '--format=esm', '--platform=node',
  '--alias:@deepseek-ai/dsh-web=' + join(root, 'test', 'stubs', 'dsh-web.mjs'),
  `--outfile=${built}`,
], { stdio: 'inherit' })
if (result.status !== 0) throw new Error('esbuild failed')

const {
  buildSerpUrl,
  buildCrawlRequestBody,
  decodeEngineHref,
  extractMarkdownSources,
  isInternalSource,
  lookupEngine,
  mapCrawlResponse,
  parseExtractedRows,
  GenericSearchProvider,
} = await import(`file://${built.replaceAll('\\', '/')}`)

let failures = 0
const check = (name, condition) => {
  if (condition) {
    console.log(`  ok: ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL: ${name}`)
  }
}

const bing = lookupEngine('bing')
const ddg = lookupEngine('duckduckgo')

// --- SERP URLs --------------------------------------------------------------
check('bing serp url encodes the query',
  buildSerpUrl(bing, '深度 搜索 a&b') === `https://www.bing.com/search?q=${encodeURIComponent('深度 搜索 a&b')}&count=20`)
check('duckduckgo serp url', buildSerpUrl(ddg, 'x y').startsWith('https://html.duckduckgo.com/html/?q=x%20y'))
check('custom template fills {query}',
  buildSerpUrl(bing, 'a b', 'https://s.example/q?k={query}&z=1') === `https://s.example/q?k=${encodeURIComponent('a b')}&z=1`)
check('empty template falls back to the preset url',
  buildSerpUrl(bing, 'q', '   ') === buildSerpUrl(bing, 'q'))

// --- REST serialization -----------------------------------------------------
{
  const body = buildCrawlRequestBody(bing, 'https://www.bing.com/search?q=t')
  check('crawl body carries the serp url', body.urls[0] === 'https://www.bing.com/search?q=t')
  check('browser config uses the {type, params} form',
    body.browser_config.type === 'BrowserConfig' && body.browser_config.params.headless === true)
  const crawler = body.crawler_config
  check('crawler config names CrawlerRunConfig', crawler.type === 'CrawlerRunConfig')
  check('cache bypassed', crawler.params.cache_mode === 'bypass')
  const strategy = crawler.params.extraction_strategy
  check('extraction strategy named', strategy.type === 'JsonCssExtractionStrategy')
  const schema = strategy.params.schema
  check('schema dict-wrapped', schema.type === 'dict')
  check('schema uses the engine baseSelector', schema.value.baseSelector === 'li.b_algo')
  const urlField = schema.value.fields.find((f) => f.name === 'url')
  check('url field reads the href attribute', urlField.type === 'attribute' && urlField.attribute === 'href')
  const textFields = schema.value.fields.filter((f) => f.type === 'text').map((f) => f.name).join(',')
  check('title and snippet read text', textFields === 'title,snippet')
}

// --- href decoding & filtering ----------------------------------------------
check('absolute https href passes through',
  decodeEngineHref('https://example.com/a?b=1', bing) === 'https://example.com/a?b=1')
check('protocol-relative href upgrades to https',
  decodeEngineHref('//example.com/x', bing) === 'https://example.com/x')
check('non-http href rejected', decodeEngineHref('javascript:alert(1)', bing) === undefined
  && decodeEngineHref('mailto:a@b.c', bing) === undefined && decodeEngineHref('', bing) === undefined)
check('duckduckgo uddg link unwraps',
  decodeEngineHref(`//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/page?x=1')}&rut=abc`, ddg)
    === 'https://example.com/page?x=1')
check('duckduckgo redirect without uddg rejected',
  decodeEngineHref('https://duckduckgo.com/l/?rut=abc', ddg) === undefined)

check('engine host filtered', isInternalSource('https://www.bing.com/whatever', bing)
  && isInternalSource('https://images.bing.com/i', bing) && isInternalSource('https://go.microsoft.com/x', bing))
check('organic host kept', !isInternalSource('https://example.com/a', bing))

// --- extracted rows -----------------------------------------------------------
check('json string rows parse', parseExtractedRows('[{"title":"t","url":"https://a.com","snippet":"s"}]')?.length === 1)
check('already-parsed rows parse', parseExtractedRows([{ title: 't', url: 'https://a.com' }])?.length === 1)
check('alternate field spellings parse',
  parseExtractedRows([{ name: 't', href: 'https://a.com', description: 'd' }])?.[0]?.url === 'https://a.com')
check('rows without a url dropped', parseExtractedRows([{ title: 'no url' }, 'junk'])?.length === 0)
check('unparseable extraction is undefined (fallback signal)',
  parseExtractedRows('not json') === undefined && parseExtractedRows('') === undefined && parseExtractedRows(undefined) === undefined)

// --- markdown fallback --------------------------------------------------------
{
  const markdown = [
    '# Bing',
    '[Shop widgets](https://www.bing.com/aclick) junk',
    '[Widget guide](https://example.com/guide) — everything about widgets.',
    '[Widget guide again](https://example.com/guide)',
    '[Empty label](https://example.com/empty-label)',
    '[](https://example.com/no-label)',
  ].join('\n')
  const sources = extractMarkdownSources(markdown, bing)
  check('markdown links extracted', sources.length === 2)
  check('markdown titles carried', sources[0]?.title === 'Widget guide' && sources[0]?.url === 'https://example.com/guide')
  check('markdown dedupes by url', sources[1]?.url === 'https://example.com/empty-label')
}

// --- response mapping ---------------------------------------------------------
{
  const response = {
    success: true,
    results: [{
      url: 'https://www.bing.com/search?q=w',
      success: true,
      extracted_content: JSON.stringify([
        { title: '  Widget  ', url: 'https://example.com/one', snippet: 'line1\n  line2  ' },
        { title: 'dup', url: 'https://example.com/one' },
        { title: 'internal', url: 'https://www.bing.com/aclick' },
        { title: 'two', url: 'https://example.com/two' },
      ]),
    }],
  }
  const mapped = mapCrawlResponse(response, bing)
  check('rows mapped in order', mapped.sources.map((s) => s.url).join(',') === 'https://example.com/one,https://example.com/two')
  check('titles trimmed', mapped.sources[0]?.title === 'Widget')
  check('snippets collapse whitespace', mapped.sources[0]?.snippet === 'line1 line2')
  check('not truncated when under the cap', mapped.truncated === false)
  const capped = mapCrawlResponse(response, bing, 1)
  check('maxResults pre-slices', capped.sources.length === 1)
}
{
  const markdownOnly = { success: true, results: [{ success: true, markdown: '[T](https://example.com/m)' }] }
  check('markdown fallback used when extraction empty', mapCrawlResponse(markdownOnly, bing).sources[0]?.url === 'https://example.com/m')
  const linksOnly = { success: true, results: [{ success: true, links: { external: ['https://example.com/raw', 'https://www.bing.com/x'] } }] }
  check('raw-link fallback used last', mapCrawlResponse(linksOnly, bing).sources.length === 1
    && mapCrawlResponse(linksOnly, bing).sources[0]?.url === 'https://example.com/raw')
}
{
  let thrown = undefined
  try { mapCrawlResponse({ success: false, error: 'boom' }, bing) } catch (error) { thrown = error }
  check('request-level failure throws WEB_PROVIDER_ERROR', thrown?.code === 'WEB_PROVIDER_ERROR' && String(thrown?.message).includes('boom'))
  thrown = undefined
  try { mapCrawlResponse({ success: true, results: [] }, bing) } catch (error) { thrown = error }
  check('no results entry throws', thrown?.code === 'WEB_PROVIDER_ERROR')
  thrown = undefined
  try { mapCrawlResponse({ success: true, results: [{ success: false, error_message: 'net::ERR' }] }, bing) } catch (error) { thrown = error }
  check('failed page surfaces its error', thrown?.code === 'WEB_PROVIDER_ERROR' && String(thrown?.message).includes('net::ERR'))
  thrown = undefined
  try { mapCrawlResponse({ success: true, results: [{ success: true }] }, bing) } catch (error) { thrown = error }
  check('empty page at every tier throws with engine guidance', thrown?.code === 'WEB_PROVIDER_ERROR' && String(thrown?.message).includes('bing'))
}

// --- search() against a local Crawl4AI mock -----------------------------------
{
  const seen = []
  let behavior = 'ok'
  const serpRows = JSON.stringify([
    { title: 'Widgets explained', url: 'https://example.com/widgets', snippet: 'All about widgets.' },
    { title: 'More widgets', url: 'https://example.net/more' },
  ])
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (behavior === 'http500') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal crawl failure' }))
        return
      }
      if (behavior === 'garbage') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>not json</html>')
        return
      }
      if (behavior === 'slow') return // never answer; client abort/timeout fires
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        results: [{ url: 'https://www.bing.com/search?q=widgets', success: true, extracted_content: serpRows }],
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${String(server.address().port)}`

  const recorded = []
  const optionsOf = (extra) => ({
    baseUrl: base,
    engine: 'bing',
    timeoutMs: 5000,
    recordRequest: (request) => recorded.push(request),
    ...extra,
  })
  const provider = (extra) => new GenericSearchProvider(() => optionsOf(extra))

  try {
    // Happy path: request wire shape + result mapping.
    const result = await provider().search({ query: 'widgets & gadgets', maxResults: 8 })
    check('search returns both sources', result.sources.length === 2 && result.sources[0]?.url === 'https://example.com/widgets')
    check('search keeps titles and snippets', result.sources[0]?.title === 'Widgets explained' && result.sources[0]?.snippet === 'All about widgets.')
    check('crawl endpoint posted', seen[0]?.method === 'POST' && seen[0]?.url === '/crawl')
    check('request body serializes the serp url',
      JSON.parse(seen[0].body).urls[0] === `https://www.bing.com/search?q=${encodeURIComponent('widgets & gadgets')}&count=20`)
    check('request body uses the REST serialization contract',
      JSON.parse(seen[0].body).browser_config?.type === 'BrowserConfig')
    check('no authorization header without a token', seen[0]?.headers.authorization === undefined)
    check('recordRequest fired with the endpoint and engine',
      recorded.length === 1 && recorded[0].endpoint === `${base}/crawl` && recorded[0].engine === 'bing')

    // Token: bearer header present, never recorded.
    await provider({ apiToken: 'tok-1' }).search({ query: 't' })
    check('bearer token sent', seen.at(-1)?.headers.authorization === 'Bearer tok-1')
    check('token never rides the recorded event', JSON.stringify(recorded).includes('tok-1') === false)

    // maxResults is applied by the provider too (seam enforces regardless).
    const capped = await provider().search({ query: 'widgets', maxResults: 1 })
    check('search honors maxResults', capped.sources.length === 1)

    // HTTP error with a JSON detail.
    behavior = 'http500'
    let thrown = undefined
    try { await provider().search({ query: 'x' }) } catch (error) { thrown = error }
    check('http 500 → WEB_PROVIDER_ERROR with detail',
      thrown?.code === 'WEB_PROVIDER_ERROR' && String(thrown?.message).includes('HTTP 500') && String(thrown?.message).includes('internal crawl failure'))
    check('error guidance names the endpoint', String(thrown?.message).includes(base))

    // Non-JSON success body.
    behavior = 'garbage'
    thrown = undefined
    try { await provider().search({ query: 'x' }) } catch (error) { thrown = error }
    check('non-json body → WEB_PROVIDER_ERROR', thrown?.code === 'WEB_PROVIDER_ERROR' && String(thrown?.message).includes('unprocessable'))

    // Caller abort.
    behavior = 'slow'
    thrown = undefined
    const controller = new AbortController()
    const pending = provider().search({ query: 'x' }, controller.signal)
    setTimeout(() => controller.abort(new Error('user canceled')), 60)
    try { await pending } catch (error) { thrown = error }
    if (thrown?.code !== 'WEB_ABORTED') console.error('    (abort diagnostic)', thrown?.name, thrown?.code, String(thrown?.message ?? thrown).slice(0, 160))
    check('caller abort → WEB_ABORTED', thrown?.code === 'WEB_ABORTED')

    // Timeout.
    thrown = undefined
    try { await provider({ timeoutMs: 150 }).search({ query: 'x' }) } catch (error) { thrown = error }
    if (!(thrown?.code === 'WEB_PROVIDER_ERROR' && String(thrown?.message).includes('timed out'))) console.error('    (timeout diagnostic)', thrown?.name, thrown?.code, String(thrown?.message ?? thrown).slice(0, 160))
    check('timeout → WEB_PROVIDER_ERROR naming the deadline',
      thrown?.code === 'WEB_PROVIDER_ERROR' && String(thrown?.message).includes('timed out'))

    // Unreachable endpoint.
    behavior = 'ok'
    thrown = undefined
    const dead = new GenericSearchProvider(() => ({ baseUrl: 'http://127.0.0.1:1', engine: 'bing', timeoutMs: 500 }))
    try { await dead.search({ query: 'x' }) } catch (error) { thrown = error }
    check('connection refused → WEB_PROVIDER_ERROR with guidance', thrown?.code === 'WEB_PROVIDER_ERROR')
  } finally {
    server.close()
    // Pending "slow" sockets never settle on their own; drop them so the
    // process exits without libuv handle noise on Windows.
    server.closeAllConnections()
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('websearch provider: all checks passed')
