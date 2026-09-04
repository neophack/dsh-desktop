/**
 * Register a generic web-search provider in `ctx.web`, backed by the
 * self-hosted Crawl4AI server at `http://172.24.204.251:21235` by default.
 *
 * This is the desktop-owned adaptation of the upstream
 * `@deepseek-ai/dsh-web-search-deepseek` provider plugin: same seam contract
 * (`inject: ['web']`, `ctx.web.registerSearchProvider`, per-search option
 * projection through a settings section), but the search backend is any
 * Crawl4AI server crawling a configurable search engine's results page, so no
 * vendor API key is required. The bundle patch (`cordis.patch.yml`) also
 * repoints the `web` row's `searchProvider` here and disables the DeepSeek
 * provider row, making this the product's default web search.
 * @module dsh-plugin-websearch
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  GenericSearchProvider,
  DEFAULT_BASE_URL,
  DEFAULT_ENGINE,
  DEFAULT_TIMEOUT_MS,
} from './provider.ts'
import type { GenericSearchProviderOptions } from './provider.ts'

export {
  GenericSearchProvider,
  GENERIC_PROVIDER_ID,
  DEFAULT_BASE_URL,
  DEFAULT_ENGINE,
  DEFAULT_TIMEOUT_MS,
  SEARCH_ENGINES,
  buildSerpUrl,
  buildCrawlRequestBody,
  decodeEngineHref,
  extractMarkdownSources,
  isInternalSource,
  lookupEngine,
  mapCrawlResponse,
  parseExtractedRows,
} from './provider.ts'
export type {
  GenericSearchProviderOptions,
  GenericSearchRequest,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-plugin-websearch'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * Environment variable naming the Crawl4AI server, e.g.
 * `CRAWL4AI_BASE_URL=http://172.24.204.251:21235`. Distinct from any chat
 * endpoint variable because search never shares configuration with chat.
 */
const BASE_URL_ENV = 'CRAWL4AI_BASE_URL'

/**
 * Environment variable carrying the Crawl4AI server token (the server-side
 * `CRAWL4AI_API_TOKEN`), for deployments that enable authentication.
 */
const API_TOKEN_ENV = 'CRAWL4AI_API_TOKEN'

/** Settings namespace carrying this provider's server address and engine. */
export const WEBSEARCH_SETTINGS_NAMESPACE = 'websearch'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Crawl4AI server origin; `/crawl` is appended. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string
  /** SERP engine preset: `bing` (default) or `duckduckgo`. */
  engine?: string
  /** Custom SERP URL template containing `{query}`; empty uses the preset URL. */
  serpUrl?: string
  /** Literal Crawl4AI server token (servers with authentication enabled). */
  apiToken?: string
  /** Per-request timeout in milliseconds. Defaults to 60000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  // No schema default, matching the upstream provider pattern: an empty value
  // must stay distinguishable from "explicitly set" so the launch environment
  // can carry the endpoint; the effective default fills in below.
  baseUrl: z.string(),
  engine: z.string().default(DEFAULT_ENGINE),
  serpUrl: z.string(),
  apiToken: z.string().role('secret'),
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS),
})

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the environment plane.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): GenericSearchProviderOptions {
  const environment = launchEnvironmentOf(ctx)
  const baseUrl = config.baseUrl !== undefined && config.baseUrl.trim() !== ''
    ? config.baseUrl.trim()
    : environment.get(BASE_URL_ENV)?.value ?? DEFAULT_BASE_URL
  const apiToken = config.apiToken !== undefined && config.apiToken.length > 0
    ? config.apiToken
    : environment.get(API_TOKEN_ENV)?.value
  return {
    baseUrl,
    engine: config.engine ?? DEFAULT_ENGINE,
    ...config.serpUrl !== undefined && config.serpUrl.trim() !== '' ? { serpUrlTemplate: config.serpUrl.trim() } : {},
    ...apiToken !== undefined && apiToken.length > 0 ? { apiToken } : {},
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append(
        'web/generic-search-request',
        request,
      )
    },
  }
}

/** Register the generic Crawl4AI search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEBSEARCH_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      // The registration carries no resolved value: the provider projects the
      // section per search, so a committed change needs no re-registration.
      onChange: () => {},
    })
  })
  ctx.web.registerSearchProvider(new GenericSearchProvider(() => resolveOptions(ctx, current())))
}
