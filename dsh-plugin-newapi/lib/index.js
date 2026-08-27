// src/index.ts
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";

// src/newapi-client.ts
var QUOTA_PER_UNIT_FALLBACK = 5e5;
var REFRESH_COOKIE_NAME = "new_api_refresh";
var NewApiError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "NewApiError";
    this.status = status;
  }
};
function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}${path}`;
}
var BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function looksLikeJwt(value) {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}
var sharedTransport = {
  lastRequestAt: 0,
  rateLimitedUntil: 0
};
var NewApiClient = class {
  baseUrl;
  auth;
  timeoutMs;
  minRequestGapMs;
  onSessionRotated;
  cookies = /* @__PURE__ */ new Map();
  bearer;
  bearerExpiresAt = 0;
  userId;
  /** Serializes requests and enforces the minimum gap between them. */
  queueTail = Promise.resolve();
  serverInfoCache;
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
    this.timeoutMs = options.timeoutMs ?? 15e3;
    this.minRequestGapMs = options.minRequestGapMs ?? 200;
    this.onSessionRotated = options.onSessionRotated;
    this.seedAuthCookie(options.auth);
    const inlineId = options.auth?.userId;
    if (typeof inlineId === "number") this.userId = inlineId;
  }
  /** Apply an externally-provided credential (used by verify/adopt flows). */
  adopt(auth) {
    this.auth = auth;
    this.cookies.clear();
    this.bearer = void 0;
    this.bearerExpiresAt = 0;
    this.seedAuthCookie(auth);
  }
  /** Seed the private jar from a cookie-backed credential. */
  seedAuthCookie(auth) {
    if (auth?.kind === "session") this.cookies.set("session", auth.value);
    if (auth?.kind === "refresh") this.cookies.set(REFRESH_COOKIE_NAME, auth.value);
  }
  /** Current session cookie value, if one is held (set by login or adoption). */
  sessionValue() {
    return this.cookies.get("session");
  }
  /** Current value of whichever auth cookie backs the credential. */
  authCookieValue() {
    if (this.auth?.kind === "session") return this.cookies.get("session") ?? this.auth.value;
    if (this.auth?.kind === "refresh") return this.cookies.get(REFRESH_COOKIE_NAME) ?? this.auth.value;
    return this.cookies.get(REFRESH_COOKIE_NAME) ?? this.cookies.get("session");
  }
  captureCookies(response) {
    const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name2 = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") {
        this.cookies.delete(name2);
        continue;
      }
      const previous = this.cookies.get(name2);
      this.cookies.set(name2, value);
      if ((name2 === "session" || name2 === REFRESH_COOKIE_NAME) && previous !== void 0 && previous !== value && this.onSessionRotated !== void 0) {
        this.onSessionRotated(value);
      }
    }
  }
  buildHeaders(method, extra = {}) {
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": BROWSER_USER_AGENT,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      referer: `${this.baseUrl}/`,
      ...method === "POST" ? { origin: this.baseUrl } : {},
      ...extra
    };
    const bearer = this.bearer ?? (this.auth?.kind === "token" ? this.auth.value : void 0);
    if (bearer !== void 0) headers.authorization = `Bearer ${bearer}`;
    if (this.cookies.size > 0) headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.userId !== void 0) headers["new-api-user"] = String(this.userId);
    return headers;
  }
  /**
   * Serialized + rate-limited transport. Requests queue one at a time with a
   * minimum gap, and any 429 puts the whole client into a fail-fast cooldown
   * (Retry-After honored, else 10s) so no code path can pile onto a server
   * that is already rate-limiting us.
   */
  async request(path, init, signal) {
    if (Date.now() < sharedTransport.rateLimitedUntil) {
      throw new NewApiError(`newapi: rate-limit cooldown active, skipping ${path}`, 429);
    }
    const run = async () => {
      const gap = sharedTransport.lastRequestAt + this.minRequestGapMs - Date.now();
      if (gap > 0) await new Promise((resolve) => {
        setTimeout(resolve, gap);
      });
      sharedTransport.lastRequestAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("newapi request timeout")), this.timeoutMs);
      const onOuterAbort = () => controller.abort(new Error("aborted"));
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const response = await fetch(joinUrl(this.baseUrl, path), {
          method: init.method,
          headers: this.buildHeaders(init.method, init.body === void 0 ? {} : { "content-type": "application/json" }),
          ...init.body === void 0 ? {} : { body: JSON.stringify(init.body) },
          redirect: "manual",
          signal: controller.signal
        });
        this.captureCookies(response);
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after"));
          sharedTransport.rateLimitedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1e3 : 1e4);
          throw new NewApiError(`newapi: HTTP 429 for ${path}`, 429);
        }
        if (!response.ok) {
          let message = `newapi: HTTP ${String(response.status)} for ${path}`;
          try {
            const body = await response.json();
            if (typeof body.message === "string" && body.message !== "") message = body.message;
          } catch {
          }
          throw new NewApiError(message, response.status);
        }
        const envelope = await response.json();
        if (envelope.success === false) {
          throw new NewApiError(`newapi: ${envelope.message ?? "request failed"} (${path})`, response.status);
        }
        return { status: response.status, envelope };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    };
    const attempt = this.queueTail.then(run, run);
    this.queueTail = attempt.then(() => void 0, () => void 0);
    return attempt;
  }
  async get(path, signal) {
    const { envelope } = await this.request(path, { method: "GET" }, signal);
    return envelope.data;
  }
  async post(path, body, signal) {
    const { envelope } = await this.request(path, { method: "POST", body }, signal);
    return envelope.data;
  }
  learnUser(value) {
    const id = value?.id;
    if (typeof id === "number") this.userId = id;
  }
  // --- unauthenticated ------------------------------------------------------
  /** Server capabilities; no credential required (`GET /api/status`). Cached 60s per client. */
  async getServerInfo(signal) {
    if (this.serverInfoCache !== void 0 && Date.now() - this.serverInfoCache.at < 6e4) {
      return this.serverInfoCache.info;
    }
    const info = await this.fetchServerInfo(signal);
    this.serverInfoCache = { info, at: Date.now() };
    return info;
  }
  async fetchServerInfo(signal) {
    const data = await this.get("/api/status", signal);
    const providers = Array.isArray(data.custom_oauth_providers) ? data.custom_oauth_providers.filter((row) => typeof row?.slug === "string" && row.slug !== "").map((row) => ({
      slug: String(row.slug),
      name: typeof row.name === "string" && row.name !== "" ? row.name : String(row.slug),
      authorizationEndpoint: typeof row.authorization_endpoint === "string" && row.authorization_endpoint !== "" ? row.authorization_endpoint : void 0,
      clientId: typeof row.client_id === "string" && row.client_id !== "" ? row.client_id : void 0,
      scopes: typeof row.scopes === "string" && row.scopes !== "" ? row.scopes : void 0
    })) : [];
    const oauth = [...providers];
    if (data.github_oauth === true) oauth.push({ slug: "github", name: "GitHub" });
    if (data.linuxdo_oauth === true) oauth.push({ slug: "linuxdo", name: "LinuxDO" });
    if (data.oidc_enabled === true) oauth.push({ slug: "oidc", name: typeof data.oidc_display_name === "string" ? data.oidc_display_name : "OIDC" });
    if (data.wechat_login === true) oauth.push({ slug: "wechat", name: "WeChat" });
    const quotaPerUnit = typeof data.quota_per_unit === "number" && data.quota_per_unit > 0 ? data.quota_per_unit : QUOTA_PER_UNIT_FALLBACK;
    const usdExchangeRate = typeof data.usd_exchange_rate === "number" && data.usd_exchange_rate > 0 ? data.usd_exchange_rate : 0;
    return {
      systemName: typeof data.system_name === "string" && data.system_name !== "" ? data.system_name : "NewAPI",
      version: typeof data.version === "string" ? data.version : "",
      quotaPerUnit,
      usdExchangeRate,
      passwordLogin: data.password_login_enabled !== false,
      oauthProviders: oauth
    };
  }
  // --- login ----------------------------------------------------------------
  /**
   * Password login: POST /api/user/login captures the session cookie, then
   * `refresh()` mints the bearer and confirms the account.
   * @returns the authenticated user.
   */
  async loginWithPassword(username, password, signal) {
    await this.post(`/api/user/login?turnstile=`, { username, password }, signal);
    await this.refresh(signal);
    return this.getUser(signal);
  }
  /**
   * Begin a custom-provider OAuth login: POST /api/oauth/state binds a state
   * value to THIS client's session cookie, which the code exchange later
   * must present. The response data is the state string (or `{flow_token}`).
   */
  async createOAuthState(provider, intent = "login", signal) {
    const data = await this.post("/api/oauth/state", { provider, intent }, signal);
    if (typeof data === "string" && data !== "") return data;
    if (typeof data === "object" && data !== null && typeof data.flow_token === "string") return data.flow_token;
    throw new NewApiError("newapi: oauth state response had no state value");
  }
  /**
   * Complete the OAuth login: GET /api/oauth/<slug>?code&state with the same
   * session cookie that created the state. On success the server
   * authenticates (and usually rotates) that session, which this client's
   * cookie jar captures automatically — the client becomes session-authed.
   */
  async exchangeOAuthCode(slug, code, state, signal) {
    const query = `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    await this.get(`/api/oauth/${slug.replace(/[^A-Za-z0-9._-]/g, "")}?${query}`, signal);
    const session = this.sessionValue();
    if (session !== void 0) this.auth = { kind: "session", value: session };
  }
  /** Exchange the session cookie for a fresh short-lived bearer. */
  async refresh(signal) {
    const data = await this.post("/api/user/auth/refresh", void 0, signal);
    if (typeof data.access_token === "string" && looksLikeJwt(data.access_token)) {
      this.bearer = data.access_token;
      this.bearerExpiresAt = typeof data.access_expires_at === "number" ? data.access_expires_at : 0;
    }
    this.learnUser(data.user);
  }
  ensureFreshBearer(signal) {
    if (this.auth?.kind === "token") return Promise.resolve();
    const horizon = Math.floor(Date.now() / 1e3) + 60;
    if (this.bearer !== void 0 && this.bearerExpiresAt > horizon) return Promise.resolve();
    return this.refresh(signal);
  }
  // --- authenticated data ----------------------------------------------------
  /** Fetch the authenticated user profile (id, quota, group). */
  async getUser(signal) {
    await this.ensureFreshBearer(signal);
    const user = await this.get("/api/user/self", signal);
    this.learnUser(user);
    return user;
  }
  /** Fetch the user's API keys (tokens), following pagination. */
  async getTokens(signal) {
    await this.ensureFreshBearer(signal);
    const rows = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await this.get(
        `/api/token/?p=${String(page)}&size=100`,
        signal
      );
      const batch = Array.isArray(data) ? data : data?.items ?? [];
      rows.push(...batch);
      if (!Array.isArray(data) && batch.length === 0) break;
      if (Array.isArray(data) || batch.length < 100) break;
    }
    return rows;
  }
  /** Create a new API key (unlimited quota, never expiring). */
  async createToken(name2, signal) {
    await this.ensureFreshBearer(signal);
    await this.post("/api/token/", {
      name: name2,
      expired_time: -1,
      unlimited_quota: true,
      remain_quota: 0,
      model_limits_enabled: false,
      model_limits: "",
      group: "",
      cross_group_retry: false
    }, signal);
  }
  /** Fetch the full (unmasked) key value of one token — `POST /api/token/:id/key`. */
  async getTokenKey(id, signal) {
    await this.ensureFreshBearer(signal);
    const data = await this.post(`/api/token/${String(id)}/key`, void 0, signal);
    const key = data?.key;
    return typeof key === "string" ? key : "";
  }
  /**
   * Resolve the API key the plugin should use for chat: the first existing
   * token, or a freshly created one when the account has none.
   * @returns the chosen token row and its full key value.
   */
  async ensureApiKey(signal) {
    let tokens = await this.getTokens(signal);
    if (tokens.length === 0) {
      await this.createToken("DSH", signal);
      tokens = await this.getTokens(signal);
    }
    const token = tokens[0];
    if (token === void 0) throw new NewApiError("newapi: token creation produced no key");
    const key = await this.getTokenKey(token.id, signal);
    if (key === "") throw new NewApiError("newapi: server returned an empty key");
    return { token, key };
  }
  /** Fetch model ids visible to this account. */
  async getModels(signal) {
    await this.ensureFreshBearer(signal);
    const data = await this.get("/api/user/models", signal);
    return Array.isArray(data) ? data.filter((id) => typeof id === "string") : [];
  }
  /** Fetch pricing metadata (per-model prices, USD per 1M tokens). */
  async getPricing(signal) {
    await this.ensureFreshBearer(signal);
    const raw = await this.get("/api/pricing", signal);
    const result = /* @__PURE__ */ new Map();
    for (const row of extractPricingRows(raw)) {
      const id = typeof row.model_name === "string" ? row.model_name : typeof row.model === "string" ? row.model : void 0;
      if (id === void 0) continue;
      result.set(id, pricingFromRow(row));
    }
    return result;
  }
  /** Whether the current credential authenticates (used by verify/adopt). */
  async verify(signal) {
    return this.getUser(signal);
  }
};
function extractPricingRows(raw) {
  if (Array.isArray(raw)) return raw.filter((r) => typeof r === "object" && r !== null);
  if (typeof raw === "object" && raw !== null) {
    const data = raw.data;
    if (Array.isArray(data)) return data.filter((r) => typeof r === "object" && r !== null);
  }
  return [];
}
function toFiniteNumber(value) {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? n : void 0;
}
function pricingFromRow(row) {
  const modelPrice = toFiniteNumber(row.model_price);
  const outPrice = toFiniteNumber(row.model_out_price);
  const ratio = toFiniteNumber(row.model_ratio);
  const completion = toFiniteNumber(row.completion_ratio);
  const input = modelPrice !== void 0 && modelPrice > 0 ? modelPrice : ratio !== void 0 && ratio > 0 ? ratio * 2 : toFiniteNumber(row.input);
  const output = outPrice !== void 0 && outPrice > 0 ? outPrice : input !== void 0 ? input * (completion !== void 0 && completion > 0 ? completion : 1) : toFiniteNumber(row.output);
  return { input, output };
}
function mergeModels(ids, pricing) {
  return ids.map((id) => {
    const price = pricing.get(id);
    return {
      id,
      priced: price !== void 0,
      inputPrice: price?.input,
      outputPrice: price?.output
    };
  });
}
function usageFromUser(user, quotaPerUnit) {
  const unlimited = user.quota !== void 0 && user.quota < 0;
  const per = quotaPerUnit > 0 ? quotaPerUnit : QUOTA_PER_UNIT_FALLBACK;
  return {
    quotaUsed: user.used_quota === void 0 ? void 0 : user.used_quota / per,
    quotaRemaining: unlimited || user.quota === void 0 ? void 0 : user.quota / per,
    quotaTotal: unlimited || user.quota === void 0 || user.used_quota === void 0 ? void 0 : (user.quota + user.used_quota) / per,
    unlimited
  };
}

// src/index.ts
var DEFAULT_CONTEXT_WINDOW = 18e4;
var DEFAULT_ROUTE = "newapi";
var DEFAULT_API_KEY_ENV = "NEWAPI_API_KEY";
var SESSION_ENV = "NEWAPI_SESSION";
var DEFAULT_DISPLAY_NAME = "NewAPI";
var DEFAULT_BASE_URL = "http://172.24.204.251:4000";
var LOGIN_TIMEOUT_MS = 10 * 6e4;
var LOGIN_POLL_MS = 1e3;
var VERIFY_MIN_INTERVAL_MS = 2e3;
var CHANNEL = "/newapi";
var SETTINGS_NS = "newapi";
var LLM_PI_AI_NS = "llm-pi-ai";
var Config = z.object({
  baseUrl: z.string().default(""),
  /** How the stored credential authenticates: 'token' (Bearer) or 'session' (cookie). */
  authKind: z.string().default(""),
  /**
   * Settings-UI override for the username/password form, as a tri-state
   * string (schemastery schemas expose no optional booleans): '' follows the
   * loader row's `passwordLogin`, 'on'/'off' force it. Never a boolean, so
   * "unset" stays distinguishable from false.
   */
  passwordLogin: z.string().default(""),
  /** Display currency for quota/price figures: 'cny' (default) or 'usd'. */
  currency: z.string().default("cny"),
  /**
   * Per-model capability limits (contextWindow / maxTokens in tokens) as a
   * JSON object keyed by model id (schemastery here has no dict schema, hence
   * the string); merged into the llm-pi-ai profile on every models.sync so
   * DSH sizes requests correctly for models the gateway's catalog can't
   * describe (e.g. a 204800-token qwen3-cyber behind NewAPI).
   */
  modelLimits: z.string().default("{}"),
  /**
   * Context window (tokens) applied to every synced model that has no explicit
   * per-model limit; 0 disables the default. Users can change and save it.
   */
  defaultContextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW)
});
var name = "dsh-plugin-newapi";
var inject = ["settings", "credentials", "connection"];
function ok(value) {
  return { ok: true, value };
}
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}
function readModelLimits(raw) {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const limits = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { contextWindow, maxTokens } = entry;
      const clean = {};
      if (typeof contextWindow === "number" && contextWindow > 0) clean.contextWindow = Math.floor(contextWindow);
      if (typeof maxTokens === "number" && maxTokens > 0) clean.maxTokens = Math.floor(maxTokens);
      if (Object.keys(clean).length > 0) limits[id] = clean;
    }
    return limits;
  } catch {
    return {};
  }
}
function apply(ctx, config = {}) {
  const route = config.route ?? DEFAULT_ROUTE;
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;
  const ref = credentialRef(apiKeyEnv);
  const sessionRef = credentialRef(SESSION_ENV);
  const logger = ctx.logger;
  const fixedBaseUrl = normalizeBaseUrl(config.baseUrl ?? "").replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const scope = ctx.settings.register(SETTINGS_NS, Config, { base: {} });
  const stored = () => scope.get() ?? {};
  const currentBaseUrl = () => {
    const saved = stored().baseUrl?.trim() ?? "";
    return saved !== "" ? saved : fixedBaseUrl;
  };
  const currentPasswordLogin = () => {
    const saved = stored().passwordLogin;
    if (saved === "on") return true;
    if (saved === "off") return false;
    return config.passwordLogin === true;
  };
  const currentCurrency = () => stored().currency === "usd" ? "usd" : "cny";
  const currentDefaultContextWindow = () => {
    const saved = stored().defaultContextWindow;
    return typeof saved === "number" && saved >= 0 ? Math.floor(saved) : DEFAULT_CONTEXT_WINDOW;
  };
  const currentCredential = async () => {
    const hit = await ctx.credentials.resolve(sessionRef);
    if (typeof hit?.value !== "string" || hit.value.length === 0) return void 0;
    return { kind: stored().authKind === "session" ? "session" : "refresh", value: hit.value };
  };
  const describeError = (error) => {
    if (error instanceof NewApiError) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
  };
  function storedClient() {
    const client = new NewApiClient({
      baseUrl: currentBaseUrl(),
      auth: void 0,
      onSessionRotated: (value) => {
        void ctx.credentials.set(sessionRef, value).catch((error) => {
          logger.warn(`newapi: persisting rotated session failed: ${describeError(error)}`);
        });
      }
    });
    return client;
  }
  let electronModule;
  async function loadElectron() {
    if (electronModule !== void 0) return electronModule;
    try {
      const imported = await import("electron");
      electronModule = imported.session?.defaultSession?.cookies !== void 0 ? imported : null;
    } catch {
      electronModule = null;
    }
    return electronModule;
  }
  let nativeLogin;
  function settleNativeLogin(attempt) {
    clearTimeout(attempt.timer);
    clearInterval(attempt.ticker);
    if (attempt.status === "pending") {
      attempt.status = "error";
      attempt.error = attempt.error ?? "canceled";
    }
    const win = attempt.window;
    attempt.window = void 0;
    if (win !== void 0 && !win.isDestroyed()) win.close();
  }
  function clearNativeLogin() {
    if (nativeLogin === void 0) return;
    settleNativeLogin(nativeLogin);
    nativeLogin = void 0;
  }
  ctx.effect(() => () => {
    clearNativeLogin();
  }, "newapi: embedded login cleanup");
  async function persistLogin(client, baseUrl, user, kind) {
    await ctx.credentials.set(sessionRef, client.authCookieValue() ?? "");
    await scope.update({ baseUrl, authKind: kind });
    snapshotClient = void 0;
    snapshotClientKey = "";
    invalidateSnapshot();
    void user;
    try {
      const { key } = await client.ensureApiKey();
      await ctx.credentials.set(ref, key);
      logger.info("newapi: chat API key ensured and stored");
    } catch (error) {
      logger.warn(`newapi: ensuring the API key failed: ${describeError(error)}`);
    }
    try {
      const result = await endpoints["models.sync"]({}, void 0);
      logger.info(result.ok ? `newapi: auto-synced ${String(result.value.count ?? "?")} models to the chat catalog` : `newapi: auto model sync skipped (${result.error.code})`);
    } catch (error) {
      logger.warn(`newapi: auto model sync failed: ${describeError(error)}`);
    }
  }
  async function pollNativeCookie(attempt, jar) {
    if (attempt.busy || attempt.status !== "pending") return;
    let cookies;
    try {
      const [root, refreshPath] = await Promise.all([
        jar.get({ url: attempt.origin }),
        jar.get({ url: `${attempt.origin}/api/user/auth` })
      ]);
      cookies = [...root, ...refreshPath];
    } catch {
      return;
    }
    const pick = (name2) => cookies.find((cookie) => cookie.name === name2 && cookie.value !== "");
    const hit = pick("new_api_refresh") ?? pick("session");
    if (hit === void 0 || hit.value === attempt.lastVerified) return;
    if (Date.now() - attempt.lastVerifyAt < VERIFY_MIN_INTERVAL_MS) return;
    attempt.busy = true;
    attempt.lastVerifyAt = Date.now();
    const kind = hit.name === "new_api_refresh" ? "refresh" : "session";
    try {
      const client = new NewApiClient({ baseUrl: attempt.baseUrl });
      client.adopt({ kind, value: hit.value });
      const user = await client.getUser();
      await persistLogin(client, attempt.baseUrl, user, kind);
      attempt.user = redactUser(user);
      attempt.status = "ok";
      settleNativeLogin(attempt);
      logger.info(`newapi: embedded login captured the ${kind} cookie`);
    } catch (error) {
      attempt.verifyTries += 1;
      if (attempt.verifyTries >= 3) {
        attempt.lastVerified = hit.value;
        attempt.verifyTries = 0;
      }
      logger.debug(`newapi: captured cookie did not verify yet: ${describeError(error)}`);
    } finally {
      attempt.busy = false;
    }
  }
  async function resolveLoginUrl(baseUrl, info) {
    const provider = info.oauthProviders.find((row) => row.slug === "feishu" && row.authorizationEndpoint !== void 0 && row.clientId !== void 0) ?? info.oauthProviders.find((row) => row.authorizationEndpoint !== void 0 && row.clientId !== void 0);
    if (provider === void 0) return `${baseUrl}/login`;
    try {
      const state = await new NewApiClient({ baseUrl }).createOAuthState(provider.slug, "login");
      const authorize = new URL(provider.authorizationEndpoint);
      authorize.searchParams.set("client_id", provider.clientId);
      authorize.searchParams.set("redirect_uri", `${baseUrl}/oauth/${provider.slug}`);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("state", state);
      if (provider.scopes !== void 0) authorize.searchParams.set("scope", provider.scopes);
      return authorize.toString();
    } catch (error) {
      logger.warn(`newapi: building the provider authorize URL failed: ${describeError(error)}`);
      return `${baseUrl}/login`;
    }
  }
  async function startNativeLogin(baseUrlRaw) {
    clearNativeLogin();
    const baseUrl = normalizeBaseUrl(baseUrlRaw);
    let info;
    try {
      info = await new NewApiClient({ baseUrl }).getServerInfo();
    } catch (error) {
      return fail("unreachable", describeError(error));
    }
    if (info.oauthProviders.length === 0 && info.passwordLogin === false) {
      return fail("provider-unsupported", "this server exposes no usable sign-in method");
    }
    const electron = await loadElectron();
    const jar = electron?.session?.defaultSession?.cookies;
    if (electron === void 0 || jar === void 0) {
      return fail("capability-unavailable", "embedded sign-in needs the DSH Desktop app (Electron session access)");
    }
    const loginUrl = await resolveLoginUrl(baseUrl, info);
    const attempt = {
      baseUrl,
      origin: new URL(baseUrl).origin,
      timer: setTimeout(() => {
        if (attempt.status === "pending") {
          attempt.error = "login timed out";
          settleNativeLogin(attempt);
        }
      }, LOGIN_TIMEOUT_MS),
      ticker: setInterval(() => {
        void pollNativeCookie(attempt, jar);
      }, LOGIN_POLL_MS),
      status: "pending",
      lastVerified: "",
      verifyTries: 0,
      lastVerifyAt: 0,
      busy: false
    };
    nativeLogin = attempt;
    openLoginWindow(attempt, electron, loginUrl);
    void pollNativeCookie(attempt, jar);
    logger.info(`newapi: embedded login watching cookies for ${attempt.origin}`);
    return ok({ loginUrl });
  }
  function openLoginWindow(attempt, electron, loginUrl) {
    const BrowserWindow = electron.BrowserWindow;
    if (BrowserWindow === void 0) return;
    try {
      const win = new BrowserWindow({
        width: 480,
        height: 700,
        show: true,
        title: "NewAPI",
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      attempt.window = win;
      let lastUrl = loginUrl;
      win.webContents.on("did-navigate", (_event, url) => {
        lastUrl = url;
        logger.info(`newapi: login window navigated to ${url}`);
      });
      win.webContents.on("did-navigate-in-page", (_event, url) => {
        lastUrl = url;
        logger.info(`newapi: login window navigated (in-page) to ${url}`);
      });
      win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
        logger.warn(`newapi: login window failed to load ${validatedUrl}: ${errorDescription} (${errorCode})`);
      });
      win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
        logger.info(`newapi: login window console[${level}] ${sourceId}:${line}: ${message}`);
      });
      win.on("closed", () => {
        attempt.window = void 0;
        logger.info(`newapi: login window closed (last url: ${lastUrl}, status: ${attempt.status})`);
        if (nativeLogin === attempt && attempt.status === "pending") {
          attempt.error = "canceled";
          settleNativeLogin(attempt);
        }
      });
      win.loadURL(loginUrl).catch((error) => {
        logger.warn(`newapi: loading the login window failed: ${describeError(error)}`);
        if (nativeLogin === attempt && attempt.status === "pending") {
          attempt.error = "login window failed to open";
          settleNativeLogin(attempt);
        }
      });
    } catch (error) {
      logger.warn(`newapi: opening the login window failed: ${describeError(error)}`);
    }
  }
  const SNAPSHOT_TTL_MS = 3e4;
  const RATE_LIMIT_COOLDOWN_MS = 15e3;
  let snapshotClient;
  let snapshotClientKey = "";
  let snapshotCache;
  let snapshotInFlight;
  let rateLimitedUntil = 0;
  function snapshotClientFor(baseUrl, credential) {
    const key = `${baseUrl}\0${credential.kind}\0${credential.value}`;
    if (snapshotClient === void 0 || key !== snapshotClientKey) {
      snapshotClient = storedClient();
      snapshotClient.adopt(credential);
      snapshotClientKey = key;
    }
    return snapshotClient;
  }
  function invalidateSnapshot() {
    snapshotCache = void 0;
    rateLimitedUntil = 0;
  }
  async function fetchSnapshot(signal, force = false) {
    const now = Date.now();
    if (!force) {
      if (snapshotCache !== void 0 && now - snapshotCache.at < SNAPSHOT_TTL_MS) {
        return ok(snapshotCache.payload);
      }
      if (now < rateLimitedUntil) {
        if (snapshotCache !== void 0) return ok(snapshotCache.payload);
        return fail("rate-limited", `newapi: rate-limited by the server; retry in ${String(Math.ceil((rateLimitedUntil - now) / 1e3))}s`);
      }
      if (snapshotInFlight !== void 0) return snapshotInFlight;
    }
    const flight = (async () => {
      const baseUrl = currentBaseUrl();
      if (baseUrl === "") return fail("not-configured", "no NewAPI base URL configured");
      const credential = await currentCredential();
      if (credential === void 0) return fail("not-configured", "no NewAPI credential configured");
      const client = snapshotClientFor(baseUrl, credential);
      try {
        const server = await client.getServerInfo(signal);
        const user = redactUser(await client.getUser(signal));
        const [tokens, models, pricing] = await Promise.all([
          client.getTokens(signal).catch(() => []),
          client.getModels(signal),
          client.getPricing(signal).catch(() => /* @__PURE__ */ new Map())
        ]);
        return ok({
          baseUrl,
          server,
          user: redactUser(user),
          tokens: redactTokens(tokens),
          models: mergeModels(models, pricing),
          usage: usageFromUser(user, server.quotaPerUnit)
        });
      } catch (error) {
        if (error instanceof NewApiError && error.status === 429) {
          rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          return fail("rate-limited", "newapi: server rate limit (429) hit; wait a moment before retrying");
        }
        return fail("fetch-failed", describeError(error));
      }
    })();
    if (!force) {
      snapshotInFlight = flight;
      void flight.finally(() => {
        snapshotInFlight = void 0;
      });
    }
    const result = await flight;
    if (result.ok) snapshotCache = { payload: result.value, at: Date.now() };
    return result;
  }
  async function fetchUser(signal) {
    const cached = snapshotCache;
    if (cached !== void 0 && Date.now() - cached.at < SNAPSHOT_TTL_MS) return ok(cached.payload.user);
    if (Date.now() < rateLimitedUntil) {
      if (cached !== void 0) return ok(cached.payload.user);
      return fail("rate-limited", "newapi: rate-limited by the server; retry shortly");
    }
    const baseUrl = currentBaseUrl();
    if (baseUrl === "") return fail("not-configured", "no NewAPI base URL configured");
    const credential = await currentCredential();
    if (credential === void 0) return fail("not-configured", "no NewAPI credential configured");
    try {
      return ok(redactUser(await snapshotClientFor(baseUrl, credential).getUser(signal)));
    } catch (error) {
      if (error instanceof NewApiError && error.status === 429) rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      return fail("fetch-failed", describeError(error));
    }
  }
  function redactUser(user) {
    const clone = { ...user };
    delete clone.access_token;
    return clone;
  }
  function redactTokens(tokens) {
    return tokens.map((token) => ({
      ...token,
      key: token.key === void 0 ? void 0 : `***${token.key.slice(-4)}`
    }));
  }
  const serverStatusCache = /* @__PURE__ */ new Map();
  const endpoints = {
    /** Stored config + credential status; never the secret value. */
    "config.get": async () => {
      void ensureApiKeyStored();
      const credential = await currentCredential();
      let sessionConfigured = false;
      try {
        sessionConfigured = (await ctx.credentials.describe(sessionRef)).configured;
      } catch {
        sessionConfigured = credential !== void 0;
      }
      let apiKeyConfigured = false;
      try {
        apiKeyConfigured = (await ctx.credentials.describe(ref)).configured;
      } catch {
        apiKeyConfigured = false;
      }
      const storedConfig = stored();
      return ok({
        baseUrl: currentBaseUrl(),
        baseUrlDefault: fixedBaseUrl,
        /** True when the address differs from the built-in default. */
        baseUrlOverridden: storedConfig.baseUrl !== void 0 && storedConfig.baseUrl.trim() !== "" && storedConfig.baseUrl.trim() !== fixedBaseUrl,
        passwordLogin: currentPasswordLogin(),
        currency: currentCurrency(),
        modelLimits: readModelLimits(storedConfig.modelLimits),
        defaultContextWindow: currentDefaultContextWindow(),
        authKind: storedConfig.authKind ?? "",
        tokenConfigured: sessionConfigured && credential !== void 0,
        apiKeyConfigured,
        route,
        apiKeyEnv,
        displayName
      });
    },
    /** Persist settings-UI overrides: address, currency, password-login switch. */
    "config.set": async (payload) => {
      const input = payload ?? {};
      const patch = {};
      if (typeof input.baseUrl === "string") {
        const raw = input.baseUrl.trim();
        if (raw === "") {
          patch.baseUrl = "";
        } else {
          const normalized = normalizeBaseUrl(raw);
          if (normalized === "") return fail("invalid-argument", "baseUrl must be a valid http(s) URL");
          patch.baseUrl = normalized;
        }
      }
      if (typeof input.passwordLogin === "boolean") patch.passwordLogin = input.passwordLogin ? "on" : "off";
      if (input.currency === "cny" || input.currency === "usd") patch.currency = input.currency;
      if (typeof input.defaultContextWindow === "number" && Number.isFinite(input.defaultContextWindow)) {
        const rounded = Math.floor(input.defaultContextWindow);
        if (rounded < 0) return fail("invalid-argument", "defaultContextWindow must be a non-negative number of tokens");
        patch.defaultContextWindow = rounded;
      }
      if (Object.keys(patch).length === 0) return fail("invalid-argument", "nothing to save");
      await scope.update(patch);
      return ok({ baseUrl: currentBaseUrl(), passwordLogin: currentPasswordLogin(), currency: currentCurrency(), defaultContextWindow: currentDefaultContextWindow() });
    },
    /** Server capabilities for a (possibly unsaved) base URL; no auth needed. */
    "server.status": async (payload, signal) => {
      const fromPayload = readBaseUrl(payload);
      const baseUrl = fromPayload !== "" ? fromPayload : currentBaseUrl();
      if (baseUrl === "") return fail("invalid-argument", "baseUrl is required");
      const cached = serverStatusCache.get(baseUrl);
      if (cached !== void 0 && Date.now() - cached.at < 6e4) {
        return ok({ baseUrl, info: cached.info });
      }
      try {
        const info = await new NewApiClient({ baseUrl }).getServerInfo(signal);
        serverStatusCache.set(baseUrl, { info, at: Date.now() });
        return ok({ baseUrl, info });
      } catch (error) {
        return fail("unreachable", describeError(error));
      }
    },
    /**
     * Begin the embedded native login: the Host opens the server's own login
     * page in a dedicated top-level window; every sign-in method it offers
     * runs natively and the resulting session cookie lands in the Electron
     * default session, which this Host watches and captures automatically.
     */
    "login.native.start": async (payload) => {
      const fromPayload = readBaseUrl(payload);
      const baseUrl = fromPayload !== "" ? fromPayload : currentBaseUrl();
      if (baseUrl === "") return fail("invalid-argument", "baseUrl is required");
      return startNativeLogin(baseUrl);
    },
    /**
     * Poll the embedded login attempt started by `login.native.start`.
     * Terminal results (ok/error) stay observable until the client acks with
     * `login.native.cancel` (or starts a new attempt); 'idle' means no attempt
     * is (or ever was, within its ack window) in flight.
     */
    "login.native.status": async () => {
      if (nativeLogin === void 0) return ok({ status: "idle" });
      return ok({ status: nativeLogin.status, error: nativeLogin.error, user: nativeLogin.user });
    },
    /**
     * Acknowledge a terminal result / abort a pending embedded login: stop the
     * cookie watch, close the login window, and forget the attempt.
     */
    "login.native.cancel": async () => {
      clearNativeLogin();
      return ok({});
    },
    /** Password login (fully automatic): capture session, refresh, persist. */
    "login.password": async (payload, signal) => {
      const { baseUrl, username, password } = readPasswordPayload(payload);
      if (baseUrl === "" || username === "" || password === "") {
        return fail("invalid-argument", "baseUrl, username and password are required");
      }
      const normalized = normalizeBaseUrl(baseUrl);
      const client = new NewApiClient({
        baseUrl: normalized,
        onSessionRotated: void 0
      });
      try {
        const user = await client.loginWithPassword(username, password, signal);
        const kind = client.sessionValue() !== void 0 ? "session" : "refresh";
        if (client.authCookieValue() === void 0) return fail("login-failed", "server did not establish a session");
        await persistLogin(client, normalized, user, kind);
        return ok({ authKind: kind, user: redactUser(user) });
      } catch (error) {
        return fail("login-failed", describeError(error));
      }
    },
    /** Forget the stored credentials; keep the saved address/login settings. */
    "config.clear": async () => {
      await ctx.credentials.unset(ref);
      await ctx.credentials.unset(sessionRef);
      await scope.update({ authKind: "" });
      snapshotClient = void 0;
      snapshotClientKey = "";
      invalidateSnapshot();
      return ok({});
    },
    /**
     * User, tokens, models, usage, and server info in one call. Served from a
     * short TTL cache; pass `{force: true}` (manual refresh) to bypass it.
     */
    "snapshot.get": (payload, signal) => fetchSnapshot(signal, payload?.force === true),
    /** Cached-when-possible user-only view for the footer identity widget. */
    "user.get": (_payload, signal) => fetchUser(signal),
    /**
     * Create a fresh API key server-side and return its full value exactly
     * once (NewAPI never shows it again) plus the new token row id.
     */
    "tokens.create": async (payload, signal) => {
      const baseUrl = currentBaseUrl();
      if (baseUrl === "") return fail("not-configured", "no NewAPI base URL configured");
      const credential = await currentCredential();
      if (credential === void 0) return fail("not-configured", "no NewAPI credential configured");
      const rawName = payload?.name;
      const name2 = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim().slice(0, 64) : `DSH-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
      const client = snapshotClientFor(baseUrl, credential);
      try {
        const before = new Set((await client.getTokens(signal)).map((token) => token.id));
        await client.createToken(name2, signal);
        let created;
        for (let attempt = 0; attempt < 3 && created === void 0; attempt += 1) {
          const tokens = await client.getTokens(signal);
          created = tokens.find((token) => !before.has(token.id));
          if (created === void 0 && attempt === 2 && tokens.length === 1) created = tokens[0];
        }
        if (created === void 0) return fail("create-failed", "newapi did not list the created token");
        const key = await client.getTokenKey(created.id, signal);
        if (key === "") return fail("create-failed", "newapi returned an empty key");
        invalidateSnapshot();
        return ok({ id: created.id, name: name2, key });
      } catch (error) {
        return fail("create-failed", describeError(error));
      }
    },
    /** Fetch the full (unmasked) key of one token for click-to-reveal. */
    "tokens.revealKey": async (payload, signal) => {
      const id = payload?.id;
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
        return fail("invalid-argument", "id must be a positive integer");
      }
      const baseUrl = currentBaseUrl();
      if (baseUrl === "") return fail("not-configured", "no NewAPI base URL configured");
      const credential = await currentCredential();
      if (credential === void 0) return fail("not-configured", "no NewAPI credential configured");
      try {
        const key = await snapshotClientFor(baseUrl, credential).getTokenKey(id, signal);
        return ok({ id, key });
      } catch (error) {
        return fail("fetch-failed", describeError(error));
      }
    },
    /**
     * Sync models into the LLM catalog: writes the llm-pi-ai settings section
     * `providers.<route>` so the shipped pi-ai adapter registers the chat
     * route. The token is *referenced* (apiKeyEnv), never copied. Stored
     * per-model limits (contextWindow / maxTokens) ride along on each entry
     * so DSH sizes requests to the real model capability.
     */
    "models.sync": async (payload, signal) => {
      if (ctx.settings.get(LLM_PI_AI_NS) === void 0) {
        return fail("adapter-missing", "the llm-pi-ai settings namespace is not registered; install or enable @deepseek-ai/dsh-llm-pi-ai in this profile");
      }
      const limit = readSyncLimit(payload);
      const result = await fetchSnapshot(signal);
      if (!result.ok) return result;
      const snapshot = result.value;
      if (snapshot.models.length === 0) return fail("no-models", "newapi returned no visible models");
      const limits = readModelLimits(stored().modelLimits);
      const defaultContextWindow = currentDefaultContextWindow();
      const models = (limit === void 0 ? snapshot.models : snapshot.models.slice(0, limit)).map((model) => ({
        id: model.id,
        // Explicit per-model limits win; otherwise the default context window
        // (180k out of the box) sizes requests for models the gateway can't
        // describe. 0 disables the default.
        ...limits[model.id] ?? (defaultContextWindow > 0 ? { contextWindow: defaultContextWindow } : {})
      }));
      const baseURL = `${currentBaseUrl().replace(/\/+$/, "")}/v1`;
      const profile = {
        displayName,
        apiKeyEnv,
        api: "openai-completions",
        baseURL,
        models
      };
      await ctx.settings.update(LLM_PI_AI_NS, { providers: { [route]: profile } });
      return ok({ route, count: models.length, baseURL });
    },
    /**
     * Set (or clear, with non-positive/absent values) one model's capability
     * limits, persist them in the newapi settings namespace, and re-sync the
     * llm-pi-ai profile so the limits take effect immediately.
     */
    "models.setLimit": async (payload) => {
      const input = payload ?? {};
      if (typeof input.id !== "string" || input.id === "") {
        return fail("invalid-argument", "id is required");
      }
      const readLimit = (value) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
        const rounded = Math.floor(value);
        return rounded > 0 ? rounded : void 0;
      };
      const contextWindow = readLimit(input.contextWindow);
      const maxTokens = readLimit(input.maxTokens);
      const limits = readModelLimits(stored().modelLimits);
      const entry = { ...limits[input.id] };
      if (contextWindow !== void 0) entry.contextWindow = contextWindow;
      else delete entry.contextWindow;
      if (maxTokens !== void 0) entry.maxTokens = maxTokens;
      else delete entry.maxTokens;
      if (Object.keys(entry).length === 0) delete limits[input.id];
      else limits[input.id] = entry;
      await scope.update({ modelLimits: JSON.stringify(limits) });
      logger.info(`newapi: stored model limits for ${input.id} (${JSON.stringify(entry)})`);
      const synced = await endpoints["models.sync"]({}, void 0);
      if (!synced.ok) logger.warn(`newapi: re-sync after setting model limits failed (${synced.error.code})`);
      return ok({ id: input.id, limits: entry, synced: synced.ok });
    }
  };
  ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
    const handler = endpoints[endpoint];
    if (handler === void 0) return fail("not-found", `unknown endpoint ${endpoint}`);
    try {
      return await handler(payload, signal);
    } catch (error) {
      logger.warn(`newapi: ${endpoint} failed: ${describeError(error)}`);
      return fail("internal", describeError(error));
    }
  }, { authority: "loopback" });
  async function ensureApiKeyStored() {
    try {
      const described = await ctx.credentials.describe(ref);
      if (described.configured) return;
      const baseUrl = currentBaseUrl();
      const credential = await currentCredential();
      if (baseUrl === "" || credential === void 0) return;
      const client = snapshotClientFor(baseUrl, credential);
      const { key } = await client.ensureApiKey();
      if (key === "") return;
      await ctx.credentials.set(ref, key);
      logger.info("newapi: restored the missing chat API key from the stored session");
    } catch (error) {
      logger.warn(`newapi: restoring the chat API key failed: ${describeError(error)}`);
    }
  }
  void ensureApiKeyStored();
  logger.info(`newapi: ready (route=${route}, apiKeyEnv=${apiKeyEnv})`);
}
function readBaseUrl(payload) {
  if (typeof payload !== "object" || payload === null) return "";
  const raw = payload.baseUrl;
  return typeof raw === "string" ? raw.trim() : "";
}
function readPasswordPayload(payload) {
  if (typeof payload !== "object" || payload === null) return { baseUrl: "", username: "", password: "" };
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  return { baseUrl: readBaseUrl(payload), username, password };
}
function normalizeBaseUrl(raw) {
  let value = raw.replace(/\/+$/, "");
  if (value.endsWith("/v1")) value = value.slice(0, -3).replace(/\/+$/, "");
  return value;
}
function readSyncLimit(payload) {
  if (typeof payload !== "object" || payload === null) return void 0;
  const raw = payload.limit;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return void 0;
  return raw;
}
export {
  apply,
  inject,
  name
};
