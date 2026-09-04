# dsh-plugin-websearch

Generic web search for DSH Desktop, adapted from the upstream
`@deepseek-ai/dsh-web-search-deepseek` provider plugin. Instead of a vendor
search API, every query goes through a self-hosted **Crawl4AI** server — by
default the one installed at `http://172.24.204.251:21235`.

## How it works

The plugin registers a search provider (id `crawl4ai`) in the `ctx.web`
capability seam, so the stock `web_search` tool and its result cards keep
working unchanged. Per query it:

1. builds a search-engine results page (SERP) URL — Bing by default,
   DuckDuckGo as an alternative;
2. asks the Crawl4AI server (`POST /crawl`) to crawl that page with a
   `JsonCssExtractionStrategy` that reads one organic-result block
   (title / URL / snippet);
3. maps the extracted rows onto citeable sources, deduped and filtered of
   engine-internal links — falling back to the page markdown and finally raw
   external links when the structured extraction comes back empty.

No vendor API key is needed. If your Crawl4AI server enables authentication,
set `apiToken` (or the `CRAWL4AI_API_TOKEN` environment variable).

## Configuration

Loader row (`cordis.patch.yml` in this package) — the defaults this product
ships:

```yaml
- insert:
    - id: websearch
      name: dsh-plugin-websearch
      config:
        baseUrl: http://172.24.204.251:21235
        engine: bing
```

The same keys are editable through Settings — the plugin ships a browser half
registering a "Web search" settings page right after the NewAPI entry (server
address, engine, access token, timeout; namespace `websearch`) — and by
environment: `CRAWL4AI_BASE_URL` overrides the server address,
`CRAWL4AI_API_TOKEN` supplies the server token.

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `http://172.24.204.251:21235` | Crawl4AI server origin; `/crawl` is appended. |
| `engine` | `bing` | SERP preset: `bing` or `duckduckgo`. |
| `serpUrl` | — | Custom SERP URL template containing `{query}` (keeps the selected engine's extraction schema). |
| `apiToken` | — | Bearer token for servers with authentication enabled. |
| `timeoutMs` | `60000` | Per-request timeout. |

The bundle patch also repoints the upstream `web` row
(`searchProvider: crawl4ai`) and disables the `web-search-deepseek` row, making
this the product's default web search. To restore DeepSeek search, re-enable
that row and drop the override in a user profile patch.

## Verify against a live server

```bash
node test/crawl4ai-live.mjs [baseUrl] [engine] [query]
```

## Build & test

```bash
corepack yarn workspace dsh-plugin-websearch build
corepack yarn workspace dsh-plugin-websearch test
```
