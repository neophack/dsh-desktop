/**
 * NewAPI HTTP client (Host-side only; uses Node's global fetch).
 *
 * Targets new-api v1.0.0-rc.x wire shapes, with defensive fallbacks for
 * older one-api-style deployments:
 *
 * - Management endpoints live under `<base>/api`; responses use the
 *   `{success, message, data}` envelope.
 * - Auth model (rc.25): a `session` cookie (set by password login or the
 *   in-browser SSO callback) plus a short-lived JWT obtained from
 *   `POST /api/user/auth/refresh`, sent as `Authorization: Bearer`.
 *   Long-lived personal access tokens ("访问令牌", shown once on the personal
 *   settings page) are also accepted as Bearer.
 * - OAuth SSO (e.g. Feishu as a custom_oauth_provider) always redirects back
 *   to the NewAPI server itself, so a non-browser client cannot complete it;
 *   the plugin opens the console login page and asks the user to bridge a
 *   credential back (access token or session cookie value).
 */
import type { NewApiModel, NewApiToken, NewApiUser, NewApiUsage } from './types.ts'

export const QUOTA_PER_UNIT_FALLBACK = 500_000

export interface NewApiAuth {
  /** Long-lived personal access token; sent as Bearer. */
  kind: 'token'
  value: string
}

export interface NewApiSessionAuth {
  /** Session cookie value (a JWT); sent as the `session` cookie. */
  kind: 'session'
  value: string
}

export interface NewApiRefreshAuth {
  /**
   * `new_api_refresh` cookie (new-api ≥ rc.2x): an HttpOnly rotating refresh
   * credential scoped to `/api/user/auth`, exchanged for a short-lived bearer
   * via `POST /api/user/auth/refresh`.
   */
  kind: 'refresh'
  value: string
}

export type NewApiCredential = NewApiAuth | NewApiSessionAuth | NewApiRefreshAuth

/** Cookie name backing `kind: 'refresh'` credentials. */
export const REFRESH_COOKIE_NAME = 'new_api_refresh'

export interface OAuthProviderInfo {
  name: string
  slug: string
  /** Custom providers carry the OAuth endpoints needed for an embedded flow. */
  authorizationEndpoint?: string
  clientId?: string
  scopes?: string
}

export interface NewApiServerInfo {
  systemName: string
  version: string
  quotaPerUnit: number
  usdExchangeRate: number
  passwordLogin: boolean
  oauthProviders: OAuthProviderInfo[]
}

export interface NewApiClientOptions {
  /** Console origin, e.g. `http://172.24.204.251:4000` (no trailing slash, no `/v1`). */
  baseUrl: string
  /** Credential; `{kind:'token'}` needs no session. */
  auth?: NewApiCredential
  /** Request timeout. */
  timeoutMs?: number
  /** Minimum spacing between any two requests (429 safety); default 200ms. */
  minRequestGapMs?: number
  /** Called when the server rotates the session cookie during a refresh. */
  onSessionRotated?: (value: string) => void
}

export class NewApiError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'NewApiError'
    this.status = status
  }
}

interface Envelope<T> {
  success?: boolean
  message?: string
  data?: T
  /** one-api style extras */
  url?: string
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * Chrome-on-Windows User-Agent, byte-identical to what the embedded login
 * window (Electron/Chromium) sends, so Host-side requests and the browser
 * share one fingerprint class on the server.
 */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** A JWT-shaped string (three dot-separated base64url segments). */
function looksLikeJwt(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 3 && parts.every((p) => p.length > 0)
}

/**
 * Transport state shared by every NewApiClient in this process. The plugin
 * keeps several clients alive at once (snapshot client, per-tick login-watch
 * clients, probes); per-instance gaps/cooldowns let them collectively exceed
 * the server's rate limit — and once a 429 lands, only the offending instance
 * backed off, so the others kept hammering (and the server's own login page
 * went 429 too). One global cadence + cooldown fixes both.
 */
const sharedTransport = {
  lastRequestAt: 0,
  rateLimitedUntil: 0,
  /** Consecutive 429 strikes; drives the exponential cooldown. */
  rateLimitStrikes: 0,
  /**
   * Shared short-lived bearer: every NewApiClient in this process exchanges
   * the SAME refresh cookie, so one refresh must serve them all. Per-instance
   * bearers made each client (snapshot, login-watch, probes) mint its own
   * token, multiplying /api/user/auth/refresh calls — a CriticalRateLimit
   * path on new-api servers and the dominant source of plugin-only 429s.
   */
  bearer: undefined as string | undefined,
  bearerExpiresAt: 0,
}

/** Remaining global rate-limit cooldown in ms (0 when none). */
export function sharedCooldownRemaining(): number {
  return Math.max(0, sharedTransport.rateLimitedUntil - Date.now())
}

/**
 * Cooldown after a 429: 15s doubling per consecutive strike, capped at 5min,
   * so a server with a longer limit window than our previous fixed 15s no
   * longer gets re-hammered the moment the cooldown lapses (the "always 429"
   * loop). A successful request resets the strikes.
   */
function rateLimitCooldownMs(): number {
  const strikes = Math.min(sharedTransport.rateLimitStrikes, 5)
  return Math.min(15_000 * 2 ** strikes, 300_000)
}

export class NewApiClient {
  private readonly baseUrl: string
  private auth: NewApiCredential | undefined
  private readonly timeoutMs: number
  private readonly minRequestGapMs: number
  private readonly onSessionRotated: ((value: string) => void) | undefined
  private readonly cookies = new Map<string, string>()
  private bearer: string | undefined
  private bearerExpiresAt = 0
  private userId: number | undefined
  /** Serializes requests and enforces the minimum gap between them. */
  private queueTail: Promise<void> = Promise.resolve()
  private serverInfoCache: { info: NewApiServerInfo, at: number } | undefined

  constructor(options: NewApiClientOptions) {
    this.baseUrl = options.baseUrl
    this.auth = options.auth
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.minRequestGapMs = options.minRequestGapMs ?? 200
    this.onSessionRotated = options.onSessionRotated
    this.seedAuthCookie(options.auth)
    const inlineId = (options.auth as { userId?: number } | undefined)?.userId
    if (typeof inlineId === 'number') this.userId = inlineId
  }

  /** Apply an externally-provided credential (used by verify/adopt flows). */
  adopt(auth: NewApiCredential): void {
    this.auth = auth
    this.cookies.clear()
    this.bearer = undefined
    this.bearerExpiresAt = 0
    // The shared bearer belongs to the previous credential; drop it so no
    // sibling client keeps authenticating as the old session.
    sharedTransport.bearer = undefined
    sharedTransport.bearerExpiresAt = 0
    this.seedAuthCookie(auth)
  }

  /** Seed the private jar from a cookie-backed credential. */
  private seedAuthCookie(auth: NewApiCredential | undefined): void {
    if (auth?.kind === 'session') this.cookies.set('session', auth.value)
    if (auth?.kind === 'refresh') this.cookies.set(REFRESH_COOKIE_NAME, auth.value)
  }

  /** Current session cookie value, if one is held (set by login or adoption). */
  sessionValue(): string | undefined {
    return this.cookies.get('session')
  }

  /** Current value of whichever auth cookie backs the credential. */
  authCookieValue(): string | undefined {
    if (this.auth?.kind === 'session') return this.cookies.get('session') ?? this.auth.value
    if (this.auth?.kind === 'refresh') return this.cookies.get(REFRESH_COOKIE_NAME) ?? this.auth.value
    // Password login leaves `auth` unset; the jar holds whatever the server set.
    return this.cookies.get(REFRESH_COOKIE_NAME) ?? this.cookies.get('session')
  }

  private captureCookies(response: Response): void {
    const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    for (const line of raw) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '') {
        this.cookies.delete(name)
        continue
      }
      const previous = this.cookies.get(name)
      this.cookies.set(name, value)
      // Surface session/refresh rotation so the caller can persist the new value.
      if ((name === 'session' || name === REFRESH_COOKIE_NAME) && previous !== undefined && previous !== value && this.onSessionRotated !== undefined) {
        this.onSessionRotated(value)
      }
    }
  }

  private buildHeaders(method: 'GET' | 'POST', extra: Record<string, string> = {}): Record<string, string> {
    // Header fingerprint mirrors Chrome's same-origin XHR against the console
    // SPA exactly (UA, accept, accept-language, origin/referer, sec-fetch-*);
    // Node's bare fetch sends none of these, which fingerprint-based rate
    // limiters flag as a non-browser client and 429.
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': BROWSER_USER_AGENT,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      referer: `${this.baseUrl}/`,
      ...(method === 'POST' ? { origin: this.baseUrl } : {}),
      ...extra,
    }
    const bearer = this.bearer ?? (this.auth?.kind === 'token' ? this.auth.value : undefined)
    if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`
    if (this.cookies.size > 0) headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    if (this.userId !== undefined) headers['new-api-user'] = String(this.userId)
    return headers
  }

  /**
   * Serialized + rate-limited transport. Requests queue one at a time with a
   * minimum gap, and any 429 puts the whole client into a fail-fast cooldown
   * (Retry-After honored, else 10s) so no code path can pile onto a server
   * that is already rate-limiting us.
   */
  private async request<T>(path: string, init: { method: 'GET' | 'POST', body?: unknown, skipEnvelope?: boolean }, signal?: AbortSignal): Promise<{ status: number, envelope: Envelope<T> }> {
    if (Date.now() < sharedTransport.rateLimitedUntil) {
      throw new NewApiError(`newapi: rate-limit cooldown active, skipping ${path}`, 429)
    }
    const run = async (): Promise<{ status: number, envelope: Envelope<T> }> => {
      const gap = sharedTransport.lastRequestAt + this.minRequestGapMs - Date.now()
      if (gap > 0) await new Promise((resolve) => { setTimeout(resolve, gap) })
      sharedTransport.lastRequestAt = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('newapi request timeout')), this.timeoutMs)
      const onOuterAbort = () => controller.abort(new Error('aborted'))
      signal?.addEventListener('abort', onOuterAbort, { once: true })
      try {
        const response = await fetch(joinUrl(this.baseUrl, path), {
          method: init.method,
          headers: this.buildHeaders(init.method, init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          redirect: 'manual',
          signal: controller.signal,
        })
        this.captureCookies(response)
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after'))
          sharedTransport.rateLimitStrikes += 1
          const cooldown = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : rateLimitCooldownMs()
          sharedTransport.rateLimitedUntil = Math.max(sharedTransport.rateLimitedUntil, Date.now() + cooldown)
          throw new NewApiError(`newapi: HTTP 429 for ${path}`, 429)
        }
        sharedTransport.rateLimitStrikes = 0
        if (!response.ok) {
          let message = `newapi: HTTP ${String(response.status)} for ${path}`
          try {
            const body = (await response.json()) as Envelope<T>
            if (typeof body.message === 'string' && body.message !== '') message = body.message
          } catch { /* keep HTTP-level message */ }
          throw new NewApiError(message, response.status)
        }
        const envelope = (await response.json()) as Envelope<T>
        if (envelope.success === false) {
          throw new NewApiError(`newapi: ${envelope.message ?? 'request failed'} (${path})`, response.status)
        }
        return { status: response.status, envelope }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onOuterAbort)
      }
    }
    const attempt = this.queueTail.then(run, run)
    this.queueTail = attempt.then(() => undefined, () => undefined)
    return attempt
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const { envelope } = await this.request<T>(path, { method: 'GET' }, signal)
    return envelope.data as T
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const { envelope } = await this.request<T>(path, { method: 'POST', body }, signal)
    return envelope.data as T
  }

  private learnUser(value: unknown): void {
    const id = (value as { id?: unknown } | undefined)?.id
    if (typeof id === 'number') this.userId = id
  }

  // --- unauthenticated ------------------------------------------------------

  /** Server capabilities; no credential required (`GET /api/status`). Cached 60s per client. */
  async getServerInfo(signal?: AbortSignal): Promise<NewApiServerInfo> {
    if (this.serverInfoCache !== undefined && Date.now() - this.serverInfoCache.at < 60_000) {
      return this.serverInfoCache.info
    }
    const info = await this.fetchServerInfo(signal)
    this.serverInfoCache = { info, at: Date.now() }
    return info
  }

  private async fetchServerInfo(signal?: AbortSignal): Promise<NewApiServerInfo> {
    const data = await this.get<Record<string, unknown>>('/api/status', signal)
    const providers = Array.isArray(data.custom_oauth_providers)
      ? (data.custom_oauth_providers as Array<Record<string, unknown>>)
          .filter((row) => typeof row?.slug === 'string' && row.slug !== '')
          .map((row) => ({
            slug: String(row.slug),
            name: typeof row.name === 'string' && row.name !== '' ? row.name : String(row.slug),
            authorizationEndpoint: typeof row.authorization_endpoint === 'string' && row.authorization_endpoint !== '' ? row.authorization_endpoint : undefined,
            clientId: typeof row.client_id === 'string' && row.client_id !== '' ? row.client_id : undefined,
            scopes: typeof row.scopes === 'string' && row.scopes !== '' ? row.scopes : undefined,
          }))
      : []
    const oauth: OAuthProviderInfo[] = [...providers]
    if (data.github_oauth === true) oauth.push({ slug: 'github', name: 'GitHub' })
    if (data.linuxdo_oauth === true) oauth.push({ slug: 'linuxdo', name: 'LinuxDO' })
    if (data.oidc_enabled === true) oauth.push({ slug: 'oidc', name: typeof data.oidc_display_name === 'string' ? data.oidc_display_name : 'OIDC' })
    if (data.wechat_login === true) oauth.push({ slug: 'wechat', name: 'WeChat' })
    const quotaPerUnit = typeof data.quota_per_unit === 'number' && data.quota_per_unit > 0 ? data.quota_per_unit : QUOTA_PER_UNIT_FALLBACK
    const usdExchangeRate = typeof data.usd_exchange_rate === 'number' && data.usd_exchange_rate > 0 ? data.usd_exchange_rate : 0
    return {
      systemName: typeof data.system_name === 'string' && data.system_name !== '' ? data.system_name : 'NewAPI',
      version: typeof data.version === 'string' ? data.version : '',
      quotaPerUnit,
      usdExchangeRate,
      passwordLogin: data.password_login_enabled !== false,
      oauthProviders: oauth,
    }
  }

  // --- login ----------------------------------------------------------------

  /**
   * Password login: POST /api/user/login captures the session cookie, then
   * `refresh()` mints the bearer and confirms the account.
   * @returns the authenticated user.
   */
  async loginWithPassword(username: string, password: string, signal?: AbortSignal): Promise<NewApiUser> {
    await this.post<unknown>(`/api/user/login?turnstile=`, { username, password }, signal)
    await this.refresh(signal)
    return this.getUser(signal)
  }

  /**
   * Begin a custom-provider OAuth login: POST /api/oauth/state binds a state
   * value to THIS client's session cookie, which the code exchange later
   * must present. The response data is the state string (or `{flow_token}`).
   */
  async createOAuthState(provider: string, intent: 'login' | 'bind' = 'login', signal?: AbortSignal): Promise<string> {
    const data = await this.post<string | { flow_token?: string } | null>('/api/oauth/state', { provider, intent }, signal)
    if (typeof data === 'string' && data !== '') return data
    if (typeof data === 'object' && data !== null && typeof data.flow_token === 'string') return data.flow_token
    throw new NewApiError('newapi: oauth state response had no state value')
  }

  /**
   * Complete the OAuth login: GET /api/oauth/<slug>?code&state with the same
   * session cookie that created the state. On success the server
   * authenticates (and usually rotates) that session, which this client's
   * cookie jar captures automatically — the client becomes session-authed.
   */
  async exchangeOAuthCode(slug: string, code: string, state: string, signal?: AbortSignal): Promise<void> {
    const query = `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
    await this.get<unknown>(`/api/oauth/${slug.replace(/[^A-Za-z0-9._-]/g, '')}?${query}`, signal)
    const session = this.sessionValue()
    if (session !== undefined) this.auth = { kind: 'session', value: session }
  }

  /** Exchange the session cookie for a fresh short-lived bearer. */
  async refresh(signal?: AbortSignal): Promise<void> {
    const data = await this.post<{
      access_token?: string
      access_expires_at?: number
      user?: unknown
      session?: unknown
    }>('/api/user/auth/refresh', undefined, signal)
    if (typeof data.access_token === 'string' && looksLikeJwt(data.access_token)) {
      this.bearer = data.access_token
      this.bearerExpiresAt = typeof data.access_expires_at === 'number' ? data.access_expires_at : 0
      // Publish to the shared slot so sibling clients reuse this bearer
      // instead of each minting (and rate-limiting) their own.
      sharedTransport.bearer = this.bearer
      sharedTransport.bearerExpiresAt = this.bearerExpiresAt
    }
    this.learnUser(data.user)
  }

  private ensureFreshBearer(signal?: AbortSignal): Promise<void> {
    if (this.auth?.kind === 'token') return Promise.resolve()
    const horizon = Math.floor(Date.now() / 1000) + 60
    if (this.bearer !== undefined && this.bearerExpiresAt > horizon) return Promise.resolve()
    // Adopt a still-valid bearer another client in this process refreshed.
    if (sharedTransport.bearer !== undefined && sharedTransport.bearerExpiresAt > horizon) {
      this.bearer = sharedTransport.bearer
      this.bearerExpiresAt = sharedTransport.bearerExpiresAt
      return Promise.resolve()
    }
    return this.refresh(signal)
  }

  // --- authenticated data ----------------------------------------------------

  /** Fetch the authenticated user profile (id, quota, group). */
  async getUser(signal?: AbortSignal): Promise<NewApiUser> {
    await this.ensureFreshBearer(signal)
    const user = await this.get<NewApiUser>('/api/user/self', signal)
    this.learnUser(user)
    return user
  }

  /** Fetch the user's API keys (tokens), following pagination. */
  async getTokens(signal?: AbortSignal): Promise<NewApiToken[]> {
    await this.ensureFreshBearer(signal)
    const rows: NewApiToken[] = []
    for (let page = 1; page <= 20; page += 1) {
      const data = await this.get<{ items?: NewApiToken[] } | NewApiToken[] | null>(
        `/api/token/?p=${String(page)}&size=100`,
        signal,
      )
      const batch = Array.isArray(data) ? data : (data?.items ?? [])
      rows.push(...batch)
      if (!Array.isArray(data) && batch.length === 0) break
      if (Array.isArray(data) || batch.length < 100) break
    }
    return rows
  }

  /** Create a new API key (unlimited quota, never expiring). */
  async createToken(name: string, signal?: AbortSignal): Promise<void> {
    await this.ensureFreshBearer(signal)
    await this.post<unknown>('/api/token/', {
      name,
      expired_time: -1,
      unlimited_quota: true,
      remain_quota: 0,
      model_limits_enabled: false,
      model_limits: '',
      group: '',
      cross_group_retry: false,
    }, signal)
  }

  /** Fetch the full (unmasked) key value of one token — `POST /api/token/:id/key`. */
  async getTokenKey(id: number, signal?: AbortSignal): Promise<string> {
    await this.ensureFreshBearer(signal)
    const data = await this.post<{ key?: string } | null>(`/api/token/${String(id)}/key`, undefined, signal)
    const key = (data as { key?: unknown } | null)?.key
    return typeof key === 'string' ? key : ''
  }

  /**
   * Resolve the API key the plugin should use for chat: the first existing
   * token, or a freshly created one when the account has none.
   * @returns the chosen token row and its full key value.
   */
  async ensureApiKey(signal?: AbortSignal): Promise<{ token: NewApiToken, key: string }> {
    let tokens = await this.getTokens(signal)
    if (tokens.length === 0) {
      await this.createToken('DSH', signal)
      tokens = await this.getTokens(signal)
    }
    const token = tokens[0]
    if (token === undefined) throw new NewApiError('newapi: token creation produced no key')
    const key = await this.getTokenKey(token.id, signal)
    if (key === '') throw new NewApiError('newapi: server returned an empty key')
    return { token, key }
  }

  /** Fetch model ids visible to this account. */
  async getModels(signal?: AbortSignal): Promise<string[]> {
    await this.ensureFreshBearer(signal)
    const data = await this.get<string[]>('/api/user/models', signal)
    return Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string') : []
  }

  /** Fetch pricing metadata (per-model prices, USD per 1M tokens). */
  async getPricing(signal?: AbortSignal): Promise<Map<string, { input?: number, output?: number }>> {
    await this.ensureFreshBearer(signal)
    const raw = await this.get<unknown>('/api/pricing', signal)
    const result = new Map<string, { input?: number, output?: number }>()
    for (const row of extractPricingRows(raw)) {
      const id = typeof row.model_name === 'string' ? row.model_name : typeof row.model === 'string' ? row.model : undefined
      if (id === undefined) continue
      result.set(id, pricingFromRow(row))
    }
    return result
  }

  /** Whether the current credential authenticates (used by verify/adopt). */
  async verify(signal?: AbortSignal): Promise<NewApiUser> {
    return this.getUser(signal)
  }
}

function extractPricingRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
  if (typeof raw === 'object' && raw !== null) {
    const data = (raw as { data?: unknown }).data
    if (Array.isArray(data)) return data.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
  }
  return []
}

function toFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * Derive USD-per-1M-token prices from a new-api pricing row. Per-call priced
 * models (quota_type 1 / model_price > 0) carry explicit prices; ratio-priced
 * models use the new-api convention ratio 1 = $2 per 1M input tokens, with
 * output = input × completion_ratio (default 1).
 */
function pricingFromRow(row: Record<string, unknown>): { input?: number, output?: number } {
  const modelPrice = toFiniteNumber(row.model_price)
  const outPrice = toFiniteNumber(row.model_out_price)
  const ratio = toFiniteNumber(row.model_ratio)
  const completion = toFiniteNumber(row.completion_ratio)
  const input = modelPrice !== undefined && modelPrice > 0
    ? modelPrice
    : ratio !== undefined && ratio > 0
      ? ratio * 2
      : toFiniteNumber(row.input)
  const output = outPrice !== undefined && outPrice > 0
    ? outPrice
    : input !== undefined
      ? input * (completion !== undefined && completion > 0 ? completion : 1)
      : toFiniteNumber(row.output)
  return { input, output }
}

/** Merge visible model ids with pricing rows into display models. */
export function mergeModels(ids: string[], pricing: Map<string, { input?: number, output?: number }>): NewApiModel[] {
  return ids.map((id) => {
    const price = pricing.get(id)
    return {
      id,
      priced: price !== undefined,
      inputPrice: price?.input,
      outputPrice: price?.output,
    }
  })
}

/** Normalize quota into display usage, honoring the server's quota_per_unit. */
export function usageFromUser(user: NewApiUser, quotaPerUnit: number): NewApiUsage {
  const unlimited = user.quota !== undefined && user.quota < 0
  const per = quotaPerUnit > 0 ? quotaPerUnit : QUOTA_PER_UNIT_FALLBACK
  return {
    quotaUsed: user.used_quota === undefined ? undefined : user.used_quota / per,
    quotaRemaining: unlimited || user.quota === undefined ? undefined : user.quota / per,
    quotaTotal:
      unlimited || user.quota === undefined || user.used_quota === undefined
        ? undefined
        : (user.quota + user.used_quota) / per,
    unlimited,
  }
}
