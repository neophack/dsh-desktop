// src/index.ts
import z from "@deepseek-ai/schemastery";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

// src/provider.ts
import { WebError } from "@deepseek-ai/dsh-web";
var GENERIC_PROVIDER_ID = "crawl4ai";
var DEFAULT_BASE_URL = "http://172.24.204.251:21235";
var DEFAULT_ENGINE = "bing";
var DEFAULT_TIMEOUT_MS = 6e4;
var USER_AGENT = "dsh-desktop-websearch/0.1.0";
var MAX_SOURCE_CANDIDATES = 30;
var SNIPPET_MAX_CHARS = 500;
var SEARCH_ENGINES = {
  bing: {
    id: "bing",
    serpUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20`,
    baseSelector: "li.b_algo",
    fields: [
      { name: "title", selector: "h2", type: "text" },
      { name: "url", selector: "h2 a", type: "attribute", attribute: "href" },
      { name: "snippet", selector: ".b_caption p, .b_algoSlug p, p", type: "text" }
    ],
    internalHosts: ["bing.com", "microsoft.com", "msn.com"]
  },
  duckduckgo: {
    id: "duckduckgo",
    serpUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    baseSelector: ".result, .web-result",
    fields: [
      { name: "title", selector: "a.result__a", type: "text" },
      { name: "url", selector: "a.result__a", type: "attribute", attribute: "href" },
      { name: "snippet", selector: ".result__snippet", type: "text" }
    ],
    internalHosts: ["duckduckgo.com"]
  }
};
function lookupEngine(id) {
  return SEARCH_ENGINES[id];
}
function buildSerpUrl(engine, query, template) {
  if (template === void 0 || template.trim() === "") return engine.serpUrl(query);
  const filled = template.replaceAll("{query}", encodeURIComponent(query));
  return filled;
}
function buildCrawlRequestBody(engine, serpUrl) {
  return {
    urls: [serpUrl],
    browser_config: {
      type: "BrowserConfig",
      params: { headless: true }
    },
    crawler_config: {
      type: "CrawlerRunConfig",
      params: {
        // SERPs are personalized and stale results poison repeat queries.
        cache_mode: "bypass",
        extraction_strategy: {
          type: "JsonCssExtractionStrategy",
          params: {
            schema: {
              type: "dict",
              value: {
                baseSelector: engine.baseSelector,
                fields: engine.fields.map((field) => ({
                  name: field.name,
                  selector: field.selector,
                  type: field.type,
                  ...field.attribute !== void 0 ? { attribute: field.attribute } : {}
                }))
              }
            }
          }
        }
      }
    }
  };
}
function decodeEngineHref(href, engine) {
  const trimmed = href.trim();
  if (trimmed === "") return void 0;
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (!/^https?:\/\//iu.test(absolute)) return void 0;
  let url;
  try {
    url = new URL(absolute);
  } catch {
    return void 0;
  }
  if (engine.id === "duckduckgo" && url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
    const wrapped = url.searchParams.get("uddg");
    if (wrapped === null || wrapped === "") return void 0;
    try {
      return new URL(decodeURIComponent(wrapped)).toString();
    } catch {
      return void 0;
    }
  }
  return url.toString();
}
function isInternalSource(url, engine) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return engine.internalHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return true;
  }
}
function pickString(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return void 0;
}
function parseExtractedRows(value) {
  if (value === void 0) return void 0;
  let rows = value;
  if (typeof value === "string") {
    if (value.trim() === "") return void 0;
    try {
      rows = JSON.parse(value);
    } catch {
      return void 0;
    }
  }
  if (!Array.isArray(rows)) return void 0;
  const parsed = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw;
    const url = pickString(row, ["url", "href", "link"]);
    if (url === void 0) continue;
    const title = pickString(row, ["title", "name"]);
    const snippet = pickString(row, ["snippet", "description", "excerpt", "text"]);
    parsed.push({
      ...title !== void 0 ? { title } : {},
      url,
      ...snippet !== void 0 ? { snippet } : {}
    });
  }
  return parsed;
}
var MARKDOWN_LINK = /\[([^\[\]\n]{1,300}?)\]\((https?:\/\/[^\s)]+)\)/gu;
function extractMarkdownSources(markdown, engine) {
  if (markdown === void 0 || markdown === "") return [];
  const sources = [];
  const seen = /* @__PURE__ */ new Set();
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const label = (match[1] ?? "").trim();
    const href = decodeEngineHref(match[2] ?? "", engine);
    if (href === void 0 || label === "" || seen.has(href)) continue;
    if (isInternalSource(href, engine)) continue;
    seen.add(href);
    sources.push({ url: href, title: label.slice(0, 300) });
    if (sources.length >= MAX_SOURCE_CANDIDATES) break;
  }
  return sources;
}
function mapCrawlResponse(response, engine, maxResults) {
  const page = firstUsablePage(response);
  if (page === void 0) {
    throw new WebError(
      `Crawl4AI returned no crawl result${response.error !== void 0 && response.error !== "" ? `: ${response.error}` : ""}`,
      "WEB_PROVIDER_ERROR"
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const sources = [];
  const push = (source) => {
    if (seen.has(source.url)) return;
    seen.add(source.url);
    sources.push(source);
  };
  const rows = parseExtractedRows(page.extracted_content);
  if (rows !== void 0) {
    for (const row of rows) {
      const url = decodeEngineHref(row.url, engine);
      if (url === void 0 || isInternalSource(url, engine)) continue;
      push({
        url,
        ...row.title !== void 0 && row.title.trim() !== "" ? { title: row.title.trim().slice(0, 300) } : {},
        ...row.snippet !== void 0 && row.snippet.trim() !== "" ? { snippet: collapseWhitespace(row.snippet).slice(0, SNIPPET_MAX_CHARS) } : {}
      });
      if (sources.length >= MAX_SOURCE_CANDIDATES) break;
    }
  }
  if (sources.length === 0) {
    for (const source of extractMarkdownSources(page.markdown, engine)) {
      push(source);
      if (sources.length >= MAX_SOURCE_CANDIDATES) break;
    }
  }
  if (sources.length === 0) {
    for (const href of page.links?.external ?? []) {
      const url = decodeEngineHref(href, engine);
      if (url === void 0 || isInternalSource(url, engine)) continue;
      push({ url });
      if (sources.length >= MAX_SOURCE_CANDIDATES) break;
    }
  }
  if (sources.length === 0) {
    throw new WebError(
      `No organic results could be parsed from the ${engine.id} results page; the engine markup may have changed \u2014 try the other engine (dsh-plugin-websearch engine setting) or verify the Crawl4AI server version`,
      "WEB_PROVIDER_ERROR"
    );
  }
  return {
    sources: maxResults !== void 0 && sources.length > maxResults ? sources.slice(0, maxResults) : sources,
    truncated: false
  };
}
function firstUsablePage(response) {
  const results = response.results ?? [];
  const ok = results.find((result) => result.success !== false);
  if (ok !== void 0) return ok;
  const failed = results[0];
  if (failed !== void 0 && (failed.error_message !== void 0 || failed.status_code !== void 0)) {
    throw new WebError(
      `Crawl4AI failed to crawl the results page${failed.error_message !== void 0 ? `: ${failed.error_message}` : ` (HTTP ${String(failed.status_code)})`}`,
      "WEB_PROVIDER_ERROR"
    );
  }
  return failed;
}
function collapseWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}
var GenericSearchProvider = class {
  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can
   * change between searches, and re-registering the provider would make the
   * seam's selection observable as a flicker.
   */
  constructor(resolveOptions2) {
    this.resolveOptions = resolveOptions2;
  }
  id = GENERIC_PROVIDER_ID;
  available() {
    const options = this.resolveOptions();
    return URL.canParse(options.baseUrl) && lookupEngine(options.engine) !== void 0 && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && (options.serpUrlTemplate === void 0 || options.serpUrlTemplate.trim() === "" || options.serpUrlTemplate.includes("{query}"));
  }
  async search(request, signal) {
    const options = this.resolveOptions();
    throwIfAborted(signal);
    if (request.query.trim() === "") return { sources: [], truncated: false };
    const engine = lookupEngine(options.engine);
    if (engine === void 0) {
      throw new WebError(
        `Generic search engine "${options.engine}" is unknown; use "bing" or "duckduckgo"`,
        "WEB_PROVIDER_ERROR"
      );
    }
    const serpUrl = buildSerpUrl(engine, request.query, options.serpUrlTemplate);
    const endpoint = `${options.baseUrl.replace(/\/+$/u, "")}/crawl`;
    const body = buildCrawlRequestBody(engine, serpUrl);
    options.recordRequest?.({ endpoint, urls: [serpUrl], engine: engine.id });
    throwIfAborted(signal);
    const marker = { timedOut: false };
    let response;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "user-agent": USER_AGENT,
          ...options.apiToken !== void 0 && options.apiToken !== "" ? { authorization: `Bearer ${options.apiToken}` } : {}
        },
        body: JSON.stringify(body)
      }, options.timeoutMs, signal, marker);
    } catch (error) {
      if (marker.timedOut) {
        throw searchEndpointError(
          endpoint,
          `Crawl4AI search request timed out after ${String(Math.round(options.timeoutMs / 1e3))}s`
        );
      }
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw searchEndpointError(endpoint, `Crawl4AI search request failed: ${String(error)}`, error);
    }
    if (!response.ok) {
      const status = response.status;
      let message = `Crawl4AI server error (HTTP ${status})`;
      try {
        const text = await response.text();
        if (text !== "") {
          const parsed = JSON.parse(text);
          const detail = [parsed.error, parsed.detail, parsed.message].find((value) => typeof value === "string" && value.length > 0);
          if (detail !== void 0) message += `: ${detail}`;
        }
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      }
      throw searchEndpointError(endpoint, message);
    }
    try {
      const payload = await response.json();
      return mapCrawlResponse(payload, engine, request.maxResults);
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      const message = error instanceof WebError ? error.message : `Crawl4AI returned an unprocessable response body: ${String(error)}`;
      throw searchEndpointError(endpoint, message, error);
    }
  }
};
async function fetchWithTimeout(url, init, timeoutMs, signal, marker) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    marker.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    controller.abort();
  };
  throwIfAborted(signal);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
function searchEndpointError(endpoint, message, cause) {
  return new WebError(
    `${message}

The web search request used the Crawl4AI server at ${JSON.stringify(endpoint)}. Search endpoint configuration is separate from chat. If that endpoint is not intended, guide the user to Settings > Plugins > Plugin configuration > websearch, where they can change and save the Crawl4AI server address. If that settings page is unavailable, the user can set CRAWL4AI_BASE_URL or configure dsh-plugin-websearch.baseUrl to the address of a reachable Crawl4AI server. Only the user should choose or change the endpoint.`,
    "WEB_PROVIDER_ERROR",
    cause === void 0 ? void 0 : { cause }
  );
}
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal);
}
function searchAborted(signal, fallback) {
  return new WebError("Generic web search aborted", "WEB_ABORTED", {
    cause: signal?.aborted === true ? signal.reason : fallback
  });
}
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

// src/index.ts
var name = "dsh-plugin-websearch";
var inject = ["web"];
var BASE_URL_ENV = "CRAWL4AI_BASE_URL";
var API_TOKEN_ENV = "CRAWL4AI_API_TOKEN";
var WEBSEARCH_SETTINGS_NAMESPACE = "websearch";
var Config = z.object({
  // No schema default, matching the upstream provider pattern: an empty value
  // must stay distinguishable from "explicitly set" so the launch environment
  // can carry the endpoint; the effective default fills in below.
  baseUrl: z.string(),
  engine: z.string().default(DEFAULT_ENGINE),
  serpUrl: z.string(),
  apiToken: z.string().role("secret"),
  timeoutMs: z.number().step(1).min(1e3).default(DEFAULT_TIMEOUT_MS)
});
function resolveOptions(ctx, config) {
  const environment = launchEnvironmentOf(ctx);
  const baseUrl = config.baseUrl !== void 0 && config.baseUrl.trim() !== "" ? config.baseUrl.trim() : environment.get(BASE_URL_ENV)?.value ?? DEFAULT_BASE_URL;
  const apiToken = config.apiToken !== void 0 && config.apiToken.length > 0 ? config.apiToken : environment.get(API_TOKEN_ENV)?.value;
  return {
    baseUrl,
    engine: config.engine ?? DEFAULT_ENGINE,
    ...config.serpUrl !== void 0 && config.serpUrl.trim() !== "" ? { serpUrlTemplate: config.serpUrl.trim() } : {},
    ...apiToken !== void 0 && apiToken.length > 0 ? { apiToken } : {},
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    recordRequest: (request) => {
      ctx.get("agents")?.currentInitiator()?.session.append(
        "web/generic-search-request",
        request
      );
    }
  };
}
function apply(ctx, config) {
  let current = () => config;
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEBSEARCH_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source;
      },
      // The registration carries no resolved value: the provider projects the
      // section per search, so a committed change needs no re-registration.
      onChange: () => {
      }
    });
  });
  ctx.web.registerSearchProvider(new GenericSearchProvider(() => resolveOptions(ctx, current())));
}
export {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_ENGINE,
  DEFAULT_TIMEOUT_MS,
  GENERIC_PROVIDER_ID,
  GenericSearchProvider,
  SEARCH_ENGINES,
  WEBSEARCH_SETTINGS_NAMESPACE,
  apply,
  buildCrawlRequestBody,
  buildSerpUrl,
  decodeEngineHref,
  extractMarkdownSources,
  inject,
  isInternalSource,
  lookupEngine,
  mapCrawlResponse,
  name,
  parseExtractedRows
};
