/**
 * Generic web search through a self-hosted Crawl4AI server. Crawl4AI is a
 * crawler rather than a search engine, so each search asks it to crawl one
 * search-engine results page (SERP) with a structured CSS extraction strategy
 * and maps the extracted rows onto `ctx.web` search sources; the page markdown
 * and raw external links serve as progressively dumber fallbacks so a changed
 * SERP markup degrades instead of failing. The wire format and native `fetch`
 * client are provider-private and do not use `ctx.llm`.
 * @module dsh-plugin-websearch/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-session'
import type { CrawlResponse, CrawlResult, SearchEnginePreset, SerpRow } from './types.ts'

/** Stable id this provider registers under (the `web` row's `searchProvider`). */
export const GENERIC_PROVIDER_ID = 'crawl4ai'

/** Default Crawl4AI server installed for this product. */
export const DEFAULT_BASE_URL = 'http://172.24.204.251:21235'

/** Default SERP engine preset. */
export const DEFAULT_ENGINE = 'bing'

/** Default per-request timeout; `dsh-tool-web` layers its own tool timeout on top. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'dsh-desktop-websearch/0.1.0'

/** Upper bound on sources considered before the seam's `maxResults` truncation. */
const MAX_SOURCE_CANDIDATES = 30

/** Captions longer than this are cut; sources stay skimmable in the tool card. */
const SNIPPET_MAX_CHARS = 500

/** Engine presets: where to search and how to read one organic result block. */
export const SEARCH_ENGINES: Readonly<Record<SearchEnginePreset['id'], SearchEnginePreset>> = {
  bing: {
    id: 'bing',
    serpUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20`,
    baseSelector: 'li.b_algo',
    fields: [
      { name: 'title', selector: 'h2', type: 'text' },
      { name: 'url', selector: 'h2 a', type: 'attribute', attribute: 'href' },
      { name: 'snippet', selector: '.b_caption p, .b_algoSlug p, p', type: 'text' },
    ],
    internalHosts: ['bing.com', 'microsoft.com', 'msn.com'],
  },
  duckduckgo: {
    id: 'duckduckgo',
    serpUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    baseSelector: '.result, .web-result',
    fields: [
      { name: 'title', selector: 'a.result__a', type: 'text' },
      { name: 'url', selector: 'a.result__a', type: 'attribute', attribute: 'href' },
      { name: 'snippet', selector: '.result__snippet', type: 'text' },
    ],
    internalHosts: ['duckduckgo.com'],
  },
}

/** Resolve an engine preset id; unknown ids yield `undefined` (surfaced as unusable). */
export function lookupEngine(id: string): SearchEnginePreset | undefined {
  return SEARCH_ENGINES[id as SearchEnginePreset['id']]
}

/**
 * Build the SERP URL for one query. A custom template containing the
 * `{query}` placeholder replaces the preset's URL while keeping its
 * extraction schema — any SERP shaped like the engine's works.
 */
export function buildSerpUrl(engine: SearchEnginePreset, query: string, template?: string): string {
  if (template === undefined || template.trim() === '') return engine.serpUrl(query)
  const filled = template.replaceAll('{query}', encodeURIComponent(query))
  // Preserve the placeholder braces users may quote; anything else is literal.
  return filled
}

/**
 * Serialize one `/crawl` request following Crawl4AI's REST serialization
 * contract: non-primitive configs travel as `{type, params}` and plain dicts
 * wrap as `{type: 'dict', value}` (docs.crawl4ai.com "Self-Hosting").
 */
export function buildCrawlRequestBody(engine: SearchEnginePreset, serpUrl: string): Record<string, unknown> {
  return {
    urls: [serpUrl],
    browser_config: {
      type: 'BrowserConfig',
      params: { headless: true },
    },
    crawler_config: {
      type: 'CrawlerRunConfig',
      params: {
        // SERPs are personalized and stale results poison repeat queries.
        cache_mode: 'bypass',
        extraction_strategy: {
          type: 'JsonCssExtractionStrategy',
          params: {
            schema: {
              type: 'dict',
              value: {
                baseSelector: engine.baseSelector,
                fields: engine.fields.map((field) => ({
                  name: field.name,
                  selector: field.selector,
                  type: field.type,
                  ...field.attribute !== undefined ? { attribute: field.attribute } : {},
                })),
              },
            },
          },
        },
      },
    },
  }
}

/**
 * Normalize one raw result href: protocol-relative SERP links become https,
 * DuckDuckGo's `/l/?uddg=` redirect links unwrap to their target, and
 * anything that is not a usable absolute http(s) URL is rejected.
 */
export function decodeEngineHref(href: string, engine: SearchEnginePreset): string | undefined {
  const trimmed = href.trim()
  if (trimmed === '') return undefined
  const absolute = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  if (!/^https?:\/\//iu.test(absolute)) return undefined
  let url: URL
  try {
    url = new URL(absolute)
  } catch {
    return undefined
  }
  if (engine.id === 'duckduckgo' && url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
    const wrapped = url.searchParams.get('uddg')
    if (wrapped === null || wrapped === '') return undefined
    try {
      return new URL(decodeURIComponent(wrapped)).toString()
    } catch {
      return undefined
    }
  }
  return url.toString()
}

/** True when a URL belongs to the engine itself and must not count as a result. */
export function isInternalSource(url: string, engine: SearchEnginePreset): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return engine.internalHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  } catch {
    return true
  }
}

/** Pick the first non-empty string among a row's tolerated field spellings. */
function pickString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Parse Crawl4AI's `extracted_content`: stock servers return a JSON-encoded
 * array of schema rows, but already-parsed arrays and alternate field
 * spellings are accepted because server versions vary. `undefined` means
 * "nothing usable" so callers fall through to the markdown parser.
 */
export function parseExtractedRows(value: string | readonly unknown[] | undefined): readonly SerpRow[] | undefined {
  if (value === undefined) return undefined
  let rows: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined
    try {
      rows = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(rows)) return undefined
  const parsed: SerpRow[] = []
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const url = pickString(row, ['url', 'href', 'link'])
    if (url === undefined) continue
    const title = pickString(row, ['title', 'name'])
    const snippet = pickString(row, ['snippet', 'description', 'excerpt', 'text'])
    parsed.push({
      ...title !== undefined ? { title } : {},
      url,
      ...snippet !== undefined ? { snippet } : {},
    })
  }
  return parsed
}

/** Markdown inline link: `[label](https://target)` — image links are skipped by label shape. */
const MARKDOWN_LINK = /\[([^\[\]\n]{1,300}?)\]\((https?:\/\/[^\s)]+)\)/gu

/**
 * Fallback result source: the SERP markdown. Titles come from link labels and
 * snippets are unavailable, but URL+title already make a citeable source when
 * the structured extraction missed (a changed SERP markup, an older server
 * that dropped the strategy).
 */
export function extractMarkdownSources(markdown: string | undefined, engine: SearchEnginePreset): readonly WebSearchSource[] {
  if (markdown === undefined || markdown === '') return []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const label = (match[1] ?? '').trim()
    const href = decodeEngineHref(match[2] ?? '', engine)
    if (href === undefined || label === '' || seen.has(href)) continue
    if (isInternalSource(href, engine)) continue
    seen.add(href)
    sources.push({ url: href, title: label.slice(0, 300) })
    if (sources.length >= MAX_SOURCE_CANDIDATES) break
  }
  return sources
}

/**
 * Map one `/crawl` response to a normalized search result. Extraction rows
 * win; markdown links and finally raw external links degrade in that order.
 * An engine page that yields nothing at every tier is a provider error, not
 * an empty success: a live SERP always carries organic results, so total
 * silence means the markup or the server broke and the user should switch
 * engines or fix the endpoint rather than have the model "see" zero hits.
 * @throws {@link WebError} when the crawl failed or nothing could be parsed.
 */
export function mapCrawlResponse(
  response: CrawlResponse,
  engine: SearchEnginePreset,
  maxResults?: number,
): WebSearchResult {
  const page = firstUsablePage(response)
  if (page === undefined) {
    throw new WebError(
      `Crawl4AI returned no crawl result${response.error !== undefined && response.error !== '' ? `: ${response.error}` : ''}`,
      'WEB_PROVIDER_ERROR',
    )
  }

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  const push = (source: WebSearchSource): void => {
    if (seen.has(source.url)) return
    seen.add(source.url)
    sources.push(source)
  }

  const rows = parseExtractedRows(page.extracted_content)
  if (rows !== undefined) {
    for (const row of rows) {
      const url = decodeEngineHref(row.url, engine)
      if (url === undefined || isInternalSource(url, engine)) continue
      push({
        url,
        ...row.title !== undefined && row.title.trim() !== '' ? { title: row.title.trim().slice(0, 300) } : {},
        ...row.snippet !== undefined && row.snippet.trim() !== ''
          ? { snippet: collapseWhitespace(row.snippet).slice(0, SNIPPET_MAX_CHARS) }
          : {},
      })
      if (sources.length >= MAX_SOURCE_CANDIDATES) break
    }
  }
  if (sources.length === 0) {
    for (const source of extractMarkdownSources(page.markdown, engine)) {
      push(source)
      if (sources.length >= MAX_SOURCE_CANDIDATES) break
    }
  }
  if (sources.length === 0) {
    for (const href of page.links?.external ?? []) {
      const url = decodeEngineHref(href, engine)
      if (url === undefined || isInternalSource(url, engine)) continue
      push({ url })
      if (sources.length >= MAX_SOURCE_CANDIDATES) break
    }
  }
  if (sources.length === 0) {
    throw new WebError(
      `No organic results could be parsed from the ${engine.id} results page; `
      + 'the engine markup may have changed — try the other engine (dsh-plugin-websearch engine setting) '
      + 'or verify the Crawl4AI server version',
      'WEB_PROVIDER_ERROR',
    )
  }
  return {
    sources: maxResults !== undefined && sources.length > maxResults ? sources.slice(0, maxResults) : sources,
    truncated: false,
  }
}

/** First result entry that did not fail; a lone failed entry surfaces its error. */
function firstUsablePage(response: CrawlResponse): CrawlResult | undefined {
  const results = response.results ?? []
  const ok = results.find((result) => result.success !== false)
  if (ok !== undefined) return ok
  const failed = results[0]
  if (failed !== undefined && (failed.error_message !== undefined || failed.status_code !== undefined)) {
    throw new WebError(
      `Crawl4AI failed to crawl the results page${failed.error_message !== undefined ? `: ${failed.error_message}` : ` (HTTP ${String(failed.status_code)})`}`,
      'WEB_PROVIDER_ERROR',
    )
  }
  return failed
}

/** Collapse runs of whitespace so snippets read as one line in the tool card. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * Exact secret-free request recorded immediately before one auxiliary search
 * dispatch (the Crawl4AI server token never rides this event).
 */
export interface GenericSearchRequest {
  /** Fully resolved `/crawl` endpoint. */
  readonly endpoint: string
  /** URLs asked of Crawl4AI: one SERP URL today. */
  readonly urls: readonly string[]
  /** Engine preset id used for this search. */
  readonly engine: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Secret-free generic search request recorded before dispatch. */
    'web/generic-search-request': GenericSearchRequest
  }
}

/** Resolved provider options (the plugin's `apply` fills env and constant defaults). */
export interface GenericSearchProviderOptions {
  /** Crawl4AI server origin, e.g. `http://172.24.204.251:21235`; `/crawl` is appended. */
  baseUrl: string
  /** Engine preset id (`bing` or `duckduckgo`). */
  engine: string
  /** Custom SERP URL template containing `{query}`; empty uses the preset's URL. */
  serpUrlTemplate?: string
  /** Optional server token sent as `Authorization: Bearer` (Crawl4AI `CRAWL4AI_API_TOKEN`). */
  apiToken?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /**
   * Record the exact secret-free request immediately before dispatch. A throw
   * prevents dispatch so model-visible auxiliary input cannot escape logging.
   */
  recordRequest?: (request: GenericSearchRequest) => void
}

/** How the timeout guard reports itself (distinguishes timeout from caller abort). */
interface TimeoutMarker { timedOut: boolean }

/**
 * The Crawl4AI-backed generic search provider. Requests reject redirects
 * (`redirect: 'error'`) so a misconfigured or hostile endpoint can never
 * relocate a credentialed POST; failures after dispatch name the endpoint and
 * tell the model how the user can configure it.
 */
export class GenericSearchProvider implements WebSearchProvider {
  readonly id = GENERIC_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can
   * change between searches, and re-registering the provider would make the
   * seam's selection observable as a flicker.
   */
  constructor(private readonly resolveOptions: () => GenericSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseUrl)
      && lookupEngine(options.engine) !== undefined
      && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      && (options.serpUrlTemplate === undefined
        || options.serpUrlTemplate.trim() === ''
        || options.serpUrlTemplate.includes('{query}'))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: a settings write landing inside
    // the fetch must not send the token resolved from the old section to the
    // endpoint named by the new one.
    const options = this.resolveOptions()
    throwIfAborted(signal)
    if (request.query.trim() === '') return { sources: [], truncated: false }
    const engine = lookupEngine(options.engine)
    if (engine === undefined) {
      throw new WebError(
        `Generic search engine "${options.engine}" is unknown; use "bing" or "duckduckgo"`,
        'WEB_PROVIDER_ERROR',
      )
    }
    const serpUrl = buildSerpUrl(engine, request.query, options.serpUrlTemplate)
    const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/crawl`
    const body = buildCrawlRequestBody(engine, serpUrl)
    options.recordRequest?.({ endpoint, urls: [serpUrl], engine: engine.id })
    throwIfAborted(signal)

    const marker: TimeoutMarker = { timedOut: false }
    let response: Response
    try {
      response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
          ...options.apiToken !== undefined && options.apiToken !== ''
            ? { authorization: `Bearer ${options.apiToken}` }
            : {},
        },
        body: JSON.stringify(body),
      }, options.timeoutMs, signal, marker)
    } catch (error: unknown) {
      if (marker.timedOut) {
        throw searchEndpointError(
          endpoint,
          `Crawl4AI search request timed out after ${String(Math.round(options.timeoutMs / 1000))}s`,
        )
      }
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw searchEndpointError(endpoint, `Crawl4AI search request failed: ${String(error)}`, error)
    }

    if (!response.ok) {
      const status = response.status
      let message = `Crawl4AI server error (HTTP ${status})`
      try {
        const text = await response.text()
        if (text !== '') {
          const parsed = JSON.parse(text) as { error?: unknown, detail?: unknown, message?: unknown }
          const detail = [parsed.error, parsed.detail, parsed.message]
            .find((value): value is string => typeof value === 'string' && value.length > 0)
          if (detail !== undefined) message += `: ${detail}`
        }
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Otherwise the HTTP status is already captured; a non-JSON error body
        // can only cost a richer message, never the real error.
      }
      throw searchEndpointError(endpoint, message)
    }

    try {
      const payload = await response.json() as CrawlResponse
      return mapCrawlResponse(payload, engine, request.maxResults)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      const message = error instanceof WebError
        ? error.message
        : `Crawl4AI returned an unprocessable response body: ${String(error)}`
      throw searchEndpointError(endpoint, message, error)
    }
  }
}

/**
 * `fetch` with one combined deadline: the caller's cancellation signal or the
 * provider timeout, whichever fires first. Callers distinguish the two with
 * `marker.timedOut`.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  marker: TimeoutMarker,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    marker.timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => { controller.abort() }
  throwIfAborted(signal)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Add endpoint recovery instructions to failures that occur after request dispatch begins. */
function searchEndpointError(endpoint: string, message: string, cause?: unknown): WebError {
  return new WebError(
    `${message}\n\nThe web search request used the Crawl4AI server at ${JSON.stringify(endpoint)}. `
    + 'Search endpoint configuration is separate from chat. If that endpoint is not intended, '
    + 'guide the user to Settings > Plugins > Plugin configuration > websearch, where they can '
    + 'change and save the Crawl4AI server address. If that settings page is unavailable, the user '
    + 'can set CRAWL4AI_BASE_URL or configure dsh-plugin-websearch.baseUrl to the address of a '
    + 'reachable Crawl4AI server. Only the user should choose or change the endpoint.',
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Generic web search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
