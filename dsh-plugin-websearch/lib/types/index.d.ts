/** Host Cordis plugin contract for dsh-plugin-websearch. */
import type { Context } from '@deepseek-ai/cordis'

export interface PluginConfig {
  /** Crawl4AI server origin; `/crawl` is appended. */
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
