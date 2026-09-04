/**
 * Wire types for the Crawl4AI Docker/server REST API (`POST /crawl`).
 *
 * Crawl4AI is a crawler, not a search engine: the provider asks it to crawl
 * one search-engine results page (SERP) with a structured CSS extraction
 * strategy, then maps the extracted rows (or the page markdown, as a fallback)
 * onto the `ctx.web` search-source shape. Every field is optional and parsed
 * defensively because a self-hosted server may run any 0.7–0.9 release and
 * the SERP markup itself moves over time.
 * @module dsh-plugin-websearch/types
 */

/** One extracted SERP row, exactly as the JsonCssExtractionStrategy schema asks Crawl4AI to produce. */
export interface SerpRow {
  readonly title?: string
  readonly url?: string
  readonly snippet?: string
}

/** What Crawl4AI's JsonCssExtractionStrategy accepts as a schema field. */
export interface ExtractionField {
  readonly name: 'title' | 'url' | 'snippet'
  readonly selector: string
  readonly type: 'text' | 'attribute'
  /** Attribute name to read when `type` is `attribute`. */
  readonly attribute?: string
}

/** One engine preset: where to search and how to read the results out of the page. */
export interface SearchEnginePreset {
  readonly id: 'bing' | 'duckduckgo'
  /** SERP URL for a query (already URL-encoded). */
  readonly serpUrl: (query: string) => string
  /** CSS selector matching one organic result block on the SERP. */
  readonly baseSelector: string
  /** Structured-extraction schema fields within one result block. */
  readonly fields: readonly ExtractionField[]
  /** Hostnames (suffix match) that belong to the engine and never count as results. */
  readonly internalHosts: readonly string[]
}

/**
 * `POST /crawl` response envelope. `success` is the whole request's outcome;
 * per-URL outcomes live in `results[]`.
 */
export interface CrawlResponse {
  readonly success?: boolean
  readonly results?: readonly CrawlResult[]
  /** String error on request-level failure. */
  readonly error?: string
}

/** One crawled URL's outcome inside a `CrawlResponse`. */
export interface CrawlResult {
  readonly url?: string
  readonly success?: boolean
  /** Markdown rendering of the page (fallback snippet source). */
  readonly markdown?: string
  /**
   * Structured extraction output: a JSON-encoded array of {@link SerpRow} in
   * stock Crawl4AI, but accepted loosely (already-parsed arrays, alternate
   * field spellings) because servers and strategies vary.
   */
  readonly extracted_content?: string | readonly unknown[]
  /** Links Crawl4AI classified on the page (last-resort fallback). */
  readonly links?: {
    readonly internal?: readonly string[]
    readonly external?: readonly string[]
  }
  readonly error_message?: string
  readonly status_code?: number
}
