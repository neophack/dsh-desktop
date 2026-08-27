/**
 * Host entry for dsh-plugin-newapi.
 *
 * Responsibilities:
 * 1. Own a settings namespace (`newapi`) holding the console base URL and the
 *    resolved auth kind. Secrets never live here — the credential (personal
 *    access token or session-cookie value) is stored through the credentials
 *    service under a ref named by config (`apiKeyEnv`, default NEWAPI_API_KEY).
 * 2. Expose a loopback-fenced Connection RPC channel `/newapi` for the bundled
 *    settings page: server capability probing, password login, SSO bridging
 *    (open the console login page; the user pastes back an access token or
 *    session value, auto-detected and verified), and the enriched snapshot
 *    (user, tokens, models, pricing, quota usage).
 *
 * The plugin deliberately does NOT register its own LlmAdapter: the shipped
 * pi-ai adapter already serves OpenAI-compatible gateways. Syncing writes the
 * provider profile through the official settings seam, so every existing
 * consumer (chat model selector, catalog, retry policies) keeps working.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { NewApiClient, NewApiError, mergeModels, sharedCooldownRemaining, usageFromUser } from './newapi-client.ts'
import type { NewApiServerInfo, NewApiToken, NewApiUser } from './newapi-client.ts'
import type { NewApiSnapshot } from './types.ts'

export interface PluginConfig {
  /** LLM provider route id this plugin manages (settings key under llm-pi-ai). */
  route?: string
  /** Credential ref storing the NewAPI API key (sk-...) used for chat. */
  apiKeyEnv?: string
  /** Display name for the route. */
  displayName?: string
  /**
   * Fixed NewAPI console origin from the loader row (e.g.
   * `http://172.24.204.251:4000`). When set it overrides the runtime setting
   * and the UI stops asking for a server address.
   */
  baseUrl?: string
  /** Show the username/password form in addition to the embedded sign-in. */
  passwordLogin?: boolean
}

/** Default context window (tokens) applied to every model without explicit limits. */
const DEFAULT_CONTEXT_WINDOW = 180_000
const DEFAULT_ROUTE = 'newapi'
const DEFAULT_API_KEY_ENV = 'NEWAPI_API_KEY'
const SESSION_ENV = 'NEWAPI_SESSION'
const DEFAULT_DISPLAY_NAME = 'NewAPI'
/** Fallback console origin so a bare install can sign in without any setup. */
const DEFAULT_BASE_URL = 'http://172.24.204.251:4000'
const LOGIN_TIMEOUT_MS = 10 * 60_000
/** Cookie-watch cadence; slow is fine — the user is busy scanning a QR. */
const LOGIN_POLL_MS = 1000
/** Minimum spacing between server-side cookie verifications (429 safety). */
const VERIFY_MIN_INTERVAL_MS = 2000
const CHANNEL = '/newapi'
const SETTINGS_NS = 'newapi'
const LLM_PI_AI_NS = 'llm-pi-ai'

const Config = z.object({
  baseUrl: z.string().default(''),
  /** How the stored credential authenticates: 'token' (Bearer) or 'session' (cookie). */
  authKind: z.string().default(''),
  /**
   * Settings-UI override for the username/password form, as a tri-state
   * string (schemastery schemas expose no optional booleans): '' follows the
   * loader row's `passwordLogin`, 'on'/'off' force it. Never a boolean, so
   * "unset" stays distinguishable from false.
   */
  passwordLogin: z.string().default(''),
  /** Display currency for quota/price figures: 'cny' (default) or 'usd'. */
  currency: z.string().default('cny'),
  /**
   * Per-model capability limits (contextWindow / maxTokens in tokens) as a
   * JSON object keyed by model id (schemastery here has no dict schema, hence
   * the string); merged into the llm-pi-ai profile on every models.sync so
   * DSH sizes requests correctly for models the gateway's catalog can't
   * describe (e.g. a 204800-token qwen3-cyber behind NewAPI).
   */
  modelLimits: z.string().default('{}'),
  /**
   * Context window (tokens) applied to every synced model that has no explicit
   * per-model limit; 0 disables the default. Users can change and save it.
   */
  defaultContextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
})

export const name = 'dsh-plugin-newapi'
export const inject = ['settings', 'credentials', 'connection']

type RpcResult<T> = { ok: true, value: T } | { ok: false, error: { code: string, message: string } }

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail(code: string, message: string): RpcResult<never> {
  // `details` is required by the client connection's response-envelope schema;
  // omitting it makes every failed RPC throw a ZodError in the renderer.
  return { ok: false, error: { code, message, details: {} } }
}

interface StoredConfig {
  baseUrl?: string
  authKind?: string
  passwordLogin?: string
  /** JSON string: Record<modelId, { contextWindow?: number, maxTokens?: number }>. */
  modelLimits?: string
  defaultContextWindow?: number
}

type ModelLimits = Record<string, { contextWindow?: number, maxTokens?: number }>

/** Parse the stored per-model limits JSON; corrupt values collapse to empty. */
function readModelLimits(raw: string | undefined): ModelLimits {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const limits: ModelLimits = {}
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue
      const { contextWindow, maxTokens } = entry as { contextWindow?: unknown, maxTokens?: unknown }
      const clean: { contextWindow?: number, maxTokens?: number } = {}
      if (typeof contextWindow === 'number' && contextWindow > 0) clean.contextWindow = Math.floor(contextWindow)
      if (typeof maxTokens === 'number' && maxTokens > 0) clean.maxTokens = Math.floor(maxTokens)
      if (Object.keys(clean).length > 0) limits[id] = clean
    }
    return limits
  } catch {
    return {}
  }
}

export function apply(ctx: Context, config: PluginConfig = {}): void {
  const route = config.route ?? DEFAULT_ROUTE
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const displayName = config.displayName ?? DEFAULT_DISPLAY_NAME
  const ref = credentialRef(apiKeyEnv)
  const sessionRef = credentialRef(SESSION_ENV)
  const logger = ctx.logger
  /** Loader-row origin: the built-in default the settings UI may override. */
  const fixedBaseUrl = normalizeBaseUrl(config.baseUrl ?? '').replace(/\/+$/, '') || DEFAULT_BASE_URL

  const scope = ctx.settings.register(SETTINGS_NS, Config, { base: {} })

  const stored = (): StoredConfig => (scope.get() as StoredConfig | undefined) ?? {}
  /** Saved address wins over the built-in default; empty means "use default". */
  const currentBaseUrl = (): string => {
    const saved = stored().baseUrl?.trim() ?? ''
    return saved !== '' ? saved : fixedBaseUrl
  }
  /** Settings override wins ('on'/'off'); '' falls back to the loader row. */
  const currentPasswordLogin = (): boolean => {
    const saved = stored().passwordLogin
    if (saved === 'on') return true
    if (saved === 'off') return false
    return config.passwordLogin === true
  }
  /** Display currency; anything other than 'usd' means the CNY default. */
  const currentCurrency = (): 'cny' | 'usd' => (stored().currency === 'usd' ? 'usd' : 'cny')
  /** Fallback context window for models without explicit limits; 0 = none. */
  const currentDefaultContextWindow = (): number => {
    const saved = stored().defaultContextWindow
    return typeof saved === 'number' && saved >= 0 ? Math.floor(saved) : DEFAULT_CONTEXT_WINDOW
  }

  const currentCredential = async (): Promise<{ kind: 'token' | 'session' | 'refresh', value: string } | undefined> => {
    const hit = await ctx.credentials.resolve(sessionRef)
    if (typeof hit?.value !== 'string' || hit.value.length === 0) return undefined
    // Stored kind: legacy one-api servers used a `session` cookie; new-api
    // rc.2x+ uses the rotating `new_api_refresh` cookie. Default to refresh.
    return { kind: stored().authKind === 'session' ? 'session' : 'refresh', value: hit.value }
  }

  const describeError = (error: unknown): string => {
    if (error instanceof NewApiError) return error.message
    if (error instanceof Error) return error.message
    return String(error)
  }

  /** Client bound to the stored config; persists server-side session rotation. */
  function storedClient(): NewApiClient {
    const client = new NewApiClient({
      baseUrl: currentBaseUrl(),
      auth: undefined,
      onSessionRotated: (value) => {
        void ctx.credentials.set(sessionRef, value).catch((error: unknown) => {
          logger.warn(`newapi: persisting rotated session failed: ${describeError(error)}`)
        })
      },
    })
    return client
  }

  // --- embedded native login ---------------------------------------------------
  //
  // NewAPI hardcodes the OAuth redirect_uri from its ServerAddress setting at
  // the token exchange, and Feishu enforces authorize/exchange equality, so no
  // plugin-owned callback can ever complete the code exchange. Instead the
  // Host opens the server's OWN login page in a dedicated top-level window:
  // every sign-in method it offers (Feishu QR, password, ...) runs natively at
  // the server origin and its `session` cookie lands in the Electron default
  // session — the same session this Host process lives in. The Host then
  // watches `electron.session.defaultSession.cookies` for that cookie,
  // verifies it against the server, and persists it. No copy/paste, no server
  // changes.
  //
  // Why a top-level window instead of an embedded iframe: after the provider
  // redirects back, the NewAPI SPA exchanges the code from JavaScript, so the
  // `session` Set-Cookie arrives on an XHR inside a cross-site context when
  // embedded under the app origin. Chromium drops SameSite-Lax cookies there
  // (and plain-http origins cannot opt out via SameSite=None), so the capture
  // never fires. A top-level navigation is exactly the case Lax cookies ARE
  // written for, and the child window shares the default session either way.

  interface ElectronCookie { name: string, value: string }
  interface ElectronSessionJar { get(filter: { url: string }): Promise<ElectronCookie[]> }
  interface ElectronWebContents {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ambient shim mirrors Electron's own loosely-typed event args without importing electron's types.
    on: (event: string, listener: (...args: any[]) => void) => unknown
    openDevTools: (options?: { mode?: string }) => void
  }
  interface ElectronBrowserWindow {
    on: (event: string, listener: () => void) => unknown
    loadURL: (url: string) => Promise<void>
    close: () => void
    isDestroyed: () => boolean
    webContents: ElectronWebContents
  }
  interface ElectronModule {
    session?: { defaultSession?: { cookies?: ElectronSessionJar } }
    BrowserWindow?: new (options: Record<string, unknown>) => ElectronBrowserWindow
  }

  let electronModule: ElectronModule | undefined | null

  /** Resolve Electron from the Host process; null when not inside the desktop app. */
  async function loadElectron(): Promise<ElectronModule | null> {
    if (electronModule !== undefined) return electronModule
    try {
      const imported = (await import('electron')) as unknown as ElectronModule
      electronModule = imported.session?.defaultSession?.cookies !== undefined ? imported : null
    } catch {
      electronModule = null
    }
    return electronModule
  }

  interface NativeLogin {
    baseUrl: string
    origin: string
    timer: NodeJS.Timeout
    ticker: NodeJS.Timeout
    status: 'pending' | 'ok' | 'error'
    error?: string
    user?: NewApiUser
    lastVerified: string
    /** Verification attempts against the current unverified cookie value. */
    verifyTries: number
    /** Timestamp of the last server-side verification attempt. */
    lastVerifyAt: number
    busy: boolean
    window?: ElectronBrowserWindow
  }

  let nativeLogin: NativeLogin | undefined

  /**
   * Settle an attempt: stop its timers, close its login window, and mark a
   * still-pending attempt as canceled. The settled attempt STAYS in
   * `nativeLogin` so the client's next `login.native.status` poll can observe
   * the terminal ok/error — clearing it here made the result unobservable and
   * left the login UI stuck forever. The client acks with
   * `login.native.cancel` (or a new start), which is what clears it.
   */
  function settleNativeLogin(attempt: NativeLogin): void {
    clearTimeout(attempt.timer)
    clearInterval(attempt.ticker)
    if (attempt.status === 'pending') {
      attempt.status = 'error'
      attempt.error = attempt.error ?? 'canceled'
    }
    const win = attempt.window
    attempt.window = undefined
    if (win !== undefined && !win.isDestroyed()) win.close()
  }

  /** Settle and forget the current attempt (explicit ack / replace / unload). */
  function clearNativeLogin(): void {
    if (nativeLogin === undefined) return
    settleNativeLogin(nativeLogin)
    nativeLogin = undefined
  }

  ctx.effect(() => () => {
    clearNativeLogin()
  }, 'newapi: embedded login cleanup')

  /**
   * Persist a verified login: the auth cookie (rotating `new_api_refresh`,
   * or `session` on legacy servers) plus the chat API key — the first
   * existing token, or a freshly created one when the account has none
   * (`ensureApiKey`).
   */
  async function persistLogin(client: NewApiClient, baseUrl: string, user: NewApiUser, kind: 'session' | 'refresh'): Promise<void> {
    await ctx.credentials.set(sessionRef, client.authCookieValue() ?? '')
    await scope.update({ baseUrl, authKind: kind } satisfies { baseUrl: string, authKind: string })
    // A new credential invalidates any cached snapshot and its client.
    snapshotClient = undefined
    snapshotClientKey = ''
    invalidateSnapshot()
    void user
    try {
      const { key } = await client.ensureApiKey()
      await ctx.credentials.set(ref, key)
      logger.info('newapi: chat API key ensured and stored')
    } catch (error) {
      // The session already gives plan/usage data; only chat needs the key.
      logger.warn(`newapi: ensuring the API key failed: ${describeError(error)}`)
    }
    // Sync models right away so the chat model selector gains the NewAPI
    // provider group without a manual "sync" click; failures are non-fatal
    // (the settings page still offers a manual retry).
    try {
      const result = await endpoints['models.sync']({}, undefined)
      logger.info(result.ok
        ? `newapi: auto-synced ${String((result.value as { count?: number }).count ?? '?')} models to the chat catalog`
        : `newapi: auto model sync skipped (${result.error.code})`)
    } catch (error) {
      logger.warn(`newapi: auto model sync failed: ${describeError(error)}`)
    }
  }

  /**
   * One watch tick: read the auth cookies for the login origin, verify fresh
   * values against the server, persist the credential on success. new-api
   * rc.2x+ authenticates the browser with the rotating `new_api_refresh`
   * cookie (HttpOnly, SameSite=Strict, **path-scoped to /api/user/auth**, so
   * the jar must be queried at that path too — a bare-origin query can never
   * path-match it); legacy one-api servers use a root-path `session` cookie.
   * A value that fails verification is retried a few times before being
   * marked stale (the cookie often lands a moment before the server-side
   * session is fully usable).
   */
  async function pollNativeCookie(attempt: NativeLogin, jar: ElectronSessionJar): Promise<void> {
    if (attempt.busy || attempt.status !== 'pending') return
    let cookies: ElectronCookie[]
    try {
      // Query the origin AND the refresh path; Electron path-matches cookies
      // against the query URL, so each query only sees its own scope.
      const [root, refreshPath] = await Promise.all([
        jar.get({ url: attempt.origin }),
        jar.get({ url: `${attempt.origin}/api/user/auth` }),
      ])
      cookies = [...root, ...refreshPath]
    } catch {
      return
    }
    const pick = (name: string): ElectronCookie | undefined =>
      cookies.find((cookie) => cookie.name === name && cookie.value !== '')
    const hit = pick('new_api_refresh') ?? pick('session')
    if (hit === undefined || hit.value === attempt.lastVerified) return
    // The watch ticks every second, but hammering /api/user/self with
    // verification calls can rate-limit the server; space them out.
    if (Date.now() - attempt.lastVerifyAt < VERIFY_MIN_INTERVAL_MS) return
    attempt.busy = true
    attempt.lastVerifyAt = Date.now()
    const kind: 'session' | 'refresh' = hit.name === 'new_api_refresh' ? 'refresh' : 'session'
    try {
      const client = new NewApiClient({ baseUrl: attempt.baseUrl })
      client.adopt({ kind, value: hit.value })
      const user = await client.getUser()
      await persistLogin(client, attempt.baseUrl, user, kind)
      attempt.user = redactUser(user)
      attempt.status = 'ok'
      settleNativeLogin(attempt)
      logger.info(`newapi: embedded login captured the ${kind} cookie`)
    } catch (error) {
      // Not (yet) an authenticated cookie: retry the same value a few times,
      // then mark it verified-stale so the watch waits for a rotation.
      attempt.verifyTries += 1
      if (attempt.verifyTries >= 3) {
        attempt.lastVerified = hit.value
        attempt.verifyTries = 0
      }
      logger.debug(`newapi: captured cookie did not verify yet: ${describeError(error)}`)
    } finally {
      attempt.busy = false
    }
  }

  /**
   * Build the direct provider authorize URL: mint the OAuth state (login
   * intents are not session-bound server-side) and point the redirect back at
   * the server's own callback, so the exchange always succeeds. Feishu first,
   * any custom provider with endpoints second; the console login page is the
   * fallback.
   */
  async function resolveLoginUrl(baseUrl: string, info: NewApiServerInfo): Promise<string> {
    const provider = info.oauthProviders.find((row) => row.slug === 'feishu' && row.authorizationEndpoint !== undefined && row.clientId !== undefined)
      ?? info.oauthProviders.find((row) => row.authorizationEndpoint !== undefined && row.clientId !== undefined)
    if (provider === undefined) return `${baseUrl}/login`
    try {
      const state = await new NewApiClient({ baseUrl }).createOAuthState(provider.slug, 'login')
      const authorize = new URL(provider.authorizationEndpoint as string)
      authorize.searchParams.set('client_id', provider.clientId as string)
      authorize.searchParams.set('redirect_uri', `${baseUrl}/oauth/${provider.slug}`)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('state', state)
      if (provider.scopes !== undefined) authorize.searchParams.set('scope', provider.scopes)
      return authorize.toString()
    } catch (error) {
      logger.warn(`newapi: building the provider authorize URL failed: ${describeError(error)}`)
      return `${baseUrl}/login`
    }
  }

  async function startNativeLogin(baseUrlRaw: string): Promise<RpcResult<{ loginUrl: string }>> {
    // Replace any previous attempt (settling keeps its terminal result only
    // until this replacement clears it — the new attempt takes over).
    clearNativeLogin()
    const baseUrl = normalizeBaseUrl(baseUrlRaw)
    let info: NewApiServerInfo
    try {
      info = await new NewApiClient({ baseUrl }).getServerInfo()
    } catch (error) {
      return fail('unreachable', describeError(error))
    }
    if (info.oauthProviders.length === 0 && info.passwordLogin === false) {
      return fail('provider-unsupported', 'this server exposes no usable sign-in method')
    }
    const electron = await loadElectron()
    const jar = electron?.session?.defaultSession?.cookies
    if (electron === undefined || jar === undefined) {
      return fail('capability-unavailable', 'embedded sign-in needs the DSH Desktop app (Electron session access)')
    }
    const loginUrl = await resolveLoginUrl(baseUrl, info)
    const attempt: NativeLogin = {
      baseUrl,
      origin: new URL(baseUrl).origin,
      timer: setTimeout(() => {
        if (attempt.status === 'pending') {
          attempt.error = 'login timed out'
          settleNativeLogin(attempt)
        }
      }, LOGIN_TIMEOUT_MS),
      ticker: setInterval(() => { void pollNativeCookie(attempt, jar) }, LOGIN_POLL_MS),
      status: 'pending',
      lastVerified: '',
      verifyTries: 0,
      lastVerifyAt: 0,
      busy: false,
    }
    nativeLogin = attempt
    openLoginWindow(attempt, electron, loginUrl)
    void pollNativeCookie(attempt, jar)
    logger.info(`newapi: embedded login watching cookies for ${attempt.origin}`)
    return ok({ loginUrl })
  }

  /**
   * Open the top-level sign-in window for an attempt (see the SameSite note
   * above). Closing the window before the cookie is captured cancels the
   * attempt; capture/timeout settle it and close the window in turn.
   */
  function openLoginWindow(attempt: NativeLogin, electron: ElectronModule, loginUrl: string): void {
    const BrowserWindow = electron.BrowserWindow
    if (BrowserWindow === undefined) return
    try {
      const win = new BrowserWindow({
        width: 480,
        height: 700,
        show: true,
        title: 'NewAPI',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      })
      attempt.window = win
      let lastUrl = loginUrl
      win.webContents.on('did-navigate', (_event, url) => {
        lastUrl = url
        logger.info(`newapi: login window navigated to ${url}`)
      })
      win.webContents.on('did-navigate-in-page', (_event, url) => {
        lastUrl = url
        logger.info(`newapi: login window navigated (in-page) to ${url}`)
      })
      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
        logger.warn(`newapi: login window failed to load ${validatedUrl}: ${errorDescription} (${errorCode})`)
      })
      win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        logger.info(`newapi: login window console[${level}] ${sourceId}:${line}: ${message}`)
      })
      win.on('closed', () => {
        attempt.window = undefined
        logger.info(`newapi: login window closed (last url: ${lastUrl}, status: ${attempt.status})`)
        if (nativeLogin === attempt && attempt.status === 'pending') {
          attempt.error = 'canceled'
          settleNativeLogin(attempt)
        }
      })
      win.loadURL(loginUrl).catch((error: unknown) => {
        logger.warn(`newapi: loading the login window failed: ${describeError(error)}`)
        if (nativeLogin === attempt && attempt.status === 'pending') {
          attempt.error = 'login window failed to open'
          settleNativeLogin(attempt)
        }
      })
    } catch (error) {
      logger.warn(`newapi: opening the login window failed: ${describeError(error)}`)
    }
  }

  // --- snapshot cache ----------------------------------------------------------
  //
  // Every full snapshot costs 6+ NewAPI requests (status, refresh, self,
  // tokens, models, pricing) and several UI entry points trigger one on mount,
  // which rate-limited servers answer with 429. Serve snapshots from a short
  // TTL cache, merge concurrent callers into one in-flight fetch, and back off
  // briefly after a 429 (returning the stale cache while it lasts).

  const SNAPSHOT_TTL_MS = 30_000
  const RATE_LIMIT_COOLDOWN_MS = 15_000

  let snapshotClient: NewApiClient | undefined
  let snapshotClientKey = ''
  let snapshotCache: { payload: SnapshotPayload, at: number } | undefined
  let snapshotInFlight: Promise<RpcResult<SnapshotPayload>> | undefined
  let rateLimitedUntil = 0

  // --- persisted snapshot cache -----------------------------------------------
  //
  // The snapshot also survives restarts and offline spells: every successful
  // fetch is mirrored to a JSON file on disk (keyed by base URL, since the
  // address can change accounts) and reloaded at startup. While offline the
  // UIs then serve the last known data instead of an error, and a window
  // opening shows it instantly while a refresh runs in the background.

  const CACHE_DIR = process.env.DSH_NEWAPI_CACHE_DIR ?? path.join(homedir(), '.dsh', 'cache')
  const CACHE_FILE = path.join(CACHE_DIR, 'newapi-snapshots.json')
  /** baseUrl -> { payload, at }; loaded once, written through on success. */
  let persistedSnapshots: Record<string, { payload: SnapshotPayload, at: number }> | undefined

  async function loadPersistedSnapshots(): Promise<void> {
    try {
      const raw = await readFile(CACHE_FILE, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      persistedSnapshots = parsed as Record<string, { payload: SnapshotPayload, at: number }>
      // Seed the in-memory cache for the configured address so the first
      // window open after a (re)start serves data without hitting the server.
      const hit = persistedSnapshots[currentBaseUrl()]
      if (hit !== undefined && snapshotCache === undefined) snapshotCache = hit
    } catch {
      persistedSnapshots = {}
    }
  }

  async function persistSnapshot(baseUrl: string, payload: SnapshotPayload): Promise<void> {
    try {
      if (persistedSnapshots === undefined) persistedSnapshots = {}
      persistedSnapshots[baseUrl] = { payload, at: Date.now() }
      await mkdir(CACHE_DIR, { recursive: true })
      await writeFile(CACHE_FILE, JSON.stringify(persistedSnapshots), 'utf8')
    } catch (error) {
      logger.warn(`newapi: persisting the snapshot cache failed: ${describeError(error)}`)
    }
  }

  /** Forget every persisted snapshot (credential changed / signed out). */
  async function dropPersistedSnapshots(): Promise<void> {
    persistedSnapshots = {}
    try {
      await rm(CACHE_FILE, { force: true })
    } catch {
      // Best-effort; a stale file is overwritten on the next persist.
    }
  }

  void loadPersistedSnapshots()

  /**
   * Reuse the snapshot client across calls so its short-lived bearer survives;
   * `adopt` resets the bearer, so only re-seed when the credential changed.
   */
  function snapshotClientFor(baseUrl: string, credential: { kind: 'token' | 'session' | 'refresh', value: string }): NewApiClient {
    const key = `${baseUrl}\0${credential.kind}\0${credential.value}`
    if (snapshotClient === undefined || key !== snapshotClientKey) {
      snapshotClient = storedClient()
      snapshotClient.adopt(credential)
      snapshotClientKey = key
    }
    return snapshotClient
  }

  function invalidateSnapshot(): void {
    snapshotCache = undefined
    rateLimitedUntil = 0
    void dropPersistedSnapshots()
  }

  /** Serve the cached snapshot flagged as stale (offline / cooling down). */
  function staleSnapshot(): RpcResult<SnapshotPayload> | undefined {
    if (snapshotCache === undefined) return undefined
    return ok({ ...snapshotCache.payload, stale: true, cachedAt: snapshotCache.at })
  }

  /**
   * Perform one full network fetch; shared by the direct path (no cache yet /
   * manual refresh) and the background refresh behind a stale cache.
   */
  function refreshSnapshot(signal: AbortSignal | undefined): Promise<RpcResult<SnapshotPayload>> {
    const flight = (async (): Promise<RpcResult<SnapshotPayload>> => {
      const baseUrl = currentBaseUrl()
      if (baseUrl === '') return fail('not-configured', 'no NewAPI base URL configured')
      // Cooldown check must live HERE, not only in fetchSnapshot: the stale
      // cache serves a background refresh through this function on every
      // non-force call, and skipping the check let UI polling pile a full
      // 5-request burst onto the server every few seconds DURING the cooldown
      // — the self-sustaining "always 429" loop.
      const cooldown = Math.max(rateLimitedUntil - Date.now(), sharedCooldownRemaining())
      if (cooldown > 0) return fail('rate-limited', `newapi: rate-limit cooldown active (${String(Math.ceil(cooldown / 1000))}s left)`)
      const credential = await currentCredential()
      if (credential === undefined) return fail('not-configured', 'no NewAPI credential configured')
      const client = snapshotClientFor(baseUrl, credential)
      try {
        const server = await client.getServerInfo(signal)
        // User first: also confirms the credential is live.
        const user = redactUser(await client.getUser(signal))
        const [tokens, models, pricing] = await Promise.all([
          client.getTokens(signal).catch((): NewApiToken[] => []),
          client.getModels(signal),
          client.getPricing(signal).catch(() => new Map<string, { input?: number, output?: number }>()),
        ])
        return ok({
          baseUrl,
          server,
          user: redactUser(user),
          tokens: redactTokens(tokens),
          models: mergeModels(models, pricing),
          usage: usageFromUser(user, server.quotaPerUnit),
        })
      } catch (error) {
        if (error instanceof NewApiError && error.status === 429) {
          // Mirror the transport's exponential cooldown (Retry-After honored
          // there) so the host gate and the transport back off in lockstep.
          rateLimitedUntil = Date.now() + Math.max(RATE_LIMIT_COOLDOWN_MS, sharedCooldownRemaining())
          return fail('rate-limited', 'newapi: server rate limit (429) hit; wait a moment before retrying')
        }
        return fail('fetch-failed', describeError(error))
      }
    })()
    return flight
  }

  /**
   * Full snapshot; errors collapse into one typed failure for the UI.
   *
   * Cache policy: a fresh cache serves directly; a stale cache is returned
   * immediately (flagged `stale`) while one refresh runs in the background —
   * the caller can re-poll and will join that in-flight refresh. When even
   * the fetch fails (offline server), the stale cache is served instead of an
   * error, so the UIs keep showing the last known data.
   */
  async function fetchSnapshot(signal: AbortSignal | undefined, force = false): Promise<RpcResult<SnapshotPayload>> {
    const now = Date.now()
    if (!force) {
      if (snapshotCache !== undefined && now - snapshotCache.at < SNAPSHOT_TTL_MS) {
        return ok(snapshotCache.payload)
      }
      if (now < rateLimitedUntil) {
        // Cooling down after a 429: serve the stale cache rather than piling on.
        const stale = staleSnapshot()
        if (stale !== undefined) return stale
        return fail('rate-limited', `newapi: rate-limited by the server; retry in ${String(Math.ceil((rateLimitedUntil - now) / 1000))}s`)
      }
      if (snapshotInFlight !== undefined) return snapshotInFlight
      if (snapshotCache !== undefined) {
        // Stale: hand it out right away and refresh in the background.
        const background = refreshSnapshot(undefined)
        snapshotInFlight = background
        void background.finally(() => { snapshotInFlight = undefined })
        return staleSnapshot() as RpcResult<SnapshotPayload>
      }
    }
    const flight = refreshSnapshot(signal)
    if (!force) {
      snapshotInFlight = flight
      void flight.finally(() => { snapshotInFlight = undefined })
    }
    const result = await flight
    if (result.ok) {
      snapshotCache = { payload: result.value, at: Date.now() }
      void persistSnapshot(result.value.baseUrl, result.value)
      return result
    }
    // Offline (or the fetch failed): fall back to the last known data, and
    // age the in-memory cache so later non-force calls also take the
    // stale-serve path (retrying in the background) instead of treating the
    // unfetchable data as fresh for the rest of the TTL.
    const stale = staleSnapshot()
    if (stale !== undefined) {
      if (snapshotCache !== undefined) snapshotCache.at = 0
      return stale
    }
    return result
  }

  /** Light user-only view for widgets that just need the signed-in identity. */
  async function fetchUser(signal: AbortSignal | undefined): Promise<RpcResult<NewApiUser>> {
    const cached = snapshotCache
    if (cached !== undefined && Date.now() - cached.at < SNAPSHOT_TTL_MS) return ok(cached.payload.user)
    if (Date.now() < rateLimitedUntil || sharedCooldownRemaining() > 0) {
      if (cached !== undefined) return ok(cached.payload.user)
      return fail('rate-limited', 'newapi: rate-limited by the server; retry shortly')
    }
    const baseUrl = currentBaseUrl()
    if (baseUrl === '') return fail('not-configured', 'no NewAPI base URL configured')
    const credential = await currentCredential()
    if (credential === undefined) return fail('not-configured', 'no NewAPI credential configured')
    try {
      return ok(redactUser(await snapshotClientFor(baseUrl, credential).getUser(signal)))
    } catch (error) {
      if (error instanceof NewApiError && error.status === 429) rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
      // Offline: keep the footer identity on the last known user instead of
      // dropping back to the "sign in" label.
      if (cached !== undefined) return ok(cached.payload.user)
      return fail('fetch-failed', describeError(error))
    }
  }

  /** Secrets must never reach the renderer. */
  function redactUser(user: NewApiUser): NewApiUser {
    const clone = { ...user }
    delete clone.access_token
    return clone
  }

  /** Never ship full key material to the renderer; keep only a masked tail. */
  function redactTokens(tokens: NewApiToken[]): NewApiToken[] {
    return tokens.map((token) => ({
      ...token,
      key: token.key === undefined ? undefined : `***${token.key.slice(-4)}`,
    }))
  }

  type Handler = (payload: unknown, signal: AbortSignal | undefined) => Promise<RpcResult<unknown>>

  /** Short-lived cache for `server.status` probes, keyed by base URL. */
  const serverStatusCache = new Map<string, { info: NewApiServerInfo, at: number }>()

  const endpoints: Record<string, Handler> = {
    /** Stored config + credential status; never the secret value. */
    'config.get': async () => {
      // Cheap re-check: re-derives the chat key if it ever goes missing.
      void ensureApiKeyStored()
      const credential = await currentCredential()
      let sessionConfigured = false
      try {
        sessionConfigured = (await ctx.credentials.describe(sessionRef)).configured
      } catch {
        sessionConfigured = credential !== undefined
      }
      let apiKeyConfigured = false
      try {
        apiKeyConfigured = (await ctx.credentials.describe(ref)).configured
      } catch {
        apiKeyConfigured = false
      }
      const storedConfig = stored()
      return ok({
        baseUrl: currentBaseUrl(),
        baseUrlDefault: fixedBaseUrl,
        /** True when the address differs from the built-in default. */
        baseUrlOverridden: storedConfig.baseUrl !== undefined && storedConfig.baseUrl.trim() !== '' && storedConfig.baseUrl.trim() !== fixedBaseUrl,
        passwordLogin: currentPasswordLogin(),
        currency: currentCurrency(),
        modelLimits: readModelLimits(storedConfig.modelLimits),
        defaultContextWindow: currentDefaultContextWindow(),
        authKind: storedConfig.authKind ?? '',
        tokenConfigured: sessionConfigured && credential !== undefined,
        apiKeyConfigured,
        route,
        apiKeyEnv,
        displayName,
      })
    },

    /** Persist settings-UI overrides: address, currency, password-login switch. */
    'config.set': async (payload) => {
      const input = (payload ?? {}) as { baseUrl?: unknown, passwordLogin?: unknown, currency?: unknown, defaultContextWindow?: unknown }
      const patch: { baseUrl?: string, passwordLogin?: string, currency?: string, defaultContextWindow?: number } = {}
      if (typeof input.baseUrl === 'string') {
        const raw = input.baseUrl.trim()
        if (raw === '') {
          // Empty = revert to the built-in default.
          patch.baseUrl = ''
        } else {
          const normalized = normalizeBaseUrl(raw)
          if (normalized === '') return fail('invalid-argument', 'baseUrl must be a valid http(s) URL')
          patch.baseUrl = normalized
        }
      }
      if (typeof input.passwordLogin === 'boolean') patch.passwordLogin = input.passwordLogin ? 'on' : 'off'
      if (input.currency === 'cny' || input.currency === 'usd') patch.currency = input.currency
      if (typeof input.defaultContextWindow === 'number' && Number.isFinite(input.defaultContextWindow)) {
        const rounded = Math.floor(input.defaultContextWindow)
        if (rounded < 0) return fail('invalid-argument', 'defaultContextWindow must be a non-negative number of tokens')
        patch.defaultContextWindow = rounded
      }
      if (Object.keys(patch).length === 0) return fail('invalid-argument', 'nothing to save')
      await scope.update(patch as { baseUrl?: string, authKind?: string, passwordLogin?: string, currency?: string, defaultContextWindow?: number })
      return ok({ baseUrl: currentBaseUrl(), passwordLogin: currentPasswordLogin(), currency: currentCurrency(), defaultContextWindow: currentDefaultContextWindow() })
    },

    /** Server capabilities for a (possibly unsaved) base URL; no auth needed. */
    'server.status': async (payload, signal) => {
      const fromPayload = readBaseUrl(payload)
      const baseUrl = fromPayload !== '' ? fromPayload : currentBaseUrl()
      if (baseUrl === '') return fail('invalid-argument', 'baseUrl is required')
      // Probes fire on every settings-page mount; serve a short cache instead
      // of re-hitting /api/status each time.
      const cached = serverStatusCache.get(baseUrl)
      if (cached !== undefined && Date.now() - cached.at < 60_000) {
        return ok({ baseUrl, info: cached.info })
      }
      try {
        const info = await new NewApiClient({ baseUrl }).getServerInfo(signal)
        serverStatusCache.set(baseUrl, { info, at: Date.now() })
        return ok({ baseUrl, info })
      } catch (error) {
        return fail('unreachable', describeError(error))
      }
    },

    /**
     * Begin the embedded native login: the Host opens the server's own login
     * page in a dedicated top-level window; every sign-in method it offers
     * runs natively and the resulting session cookie lands in the Electron
     * default session, which this Host watches and captures automatically.
     */
    'login.native.start': async (payload) => {
      const fromPayload = readBaseUrl(payload)
      const baseUrl = fromPayload !== '' ? fromPayload : currentBaseUrl()
      if (baseUrl === '') return fail('invalid-argument', 'baseUrl is required')
      return startNativeLogin(baseUrl)
    },

    /**
     * Poll the embedded login attempt started by `login.native.start`.
     * Terminal results (ok/error) stay observable until the client acks with
     * `login.native.cancel` (or starts a new attempt); 'idle' means no attempt
     * is (or ever was, within its ack window) in flight.
     */
    'login.native.status': async () => {
      if (nativeLogin === undefined) return ok({ status: 'idle' })
      return ok({ status: nativeLogin.status, error: nativeLogin.error, user: nativeLogin.user })
    },

    /**
     * Acknowledge a terminal result / abort a pending embedded login: stop the
     * cookie watch, close the login window, and forget the attempt.
     */
    'login.native.cancel': async () => {
      clearNativeLogin()
      return ok({})
    },

    /** Password login (fully automatic): capture session, refresh, persist. */
    'login.password': async (payload, signal) => {
      const { baseUrl, username, password } = readPasswordPayload(payload)
      if (baseUrl === '' || username === '' || password === '') {
        return fail('invalid-argument', 'baseUrl, username and password are required')
      }
      const normalized = normalizeBaseUrl(baseUrl)
      const client = new NewApiClient({
        baseUrl: normalized,
        onSessionRotated: undefined,
      })
      try {
        const user = await client.loginWithPassword(username, password, signal)
        // The login response seeds whichever auth cookie this server uses.
        const kind: 'session' | 'refresh' = client.sessionValue() !== undefined ? 'session' : 'refresh'
        if (client.authCookieValue() === undefined) return fail('login-failed', 'server did not establish a session')
        await persistLogin(client, normalized, user, kind)
        return ok({ authKind: kind, user: redactUser(user) })
      } catch (error) {
        return fail('login-failed', describeError(error))
      }
    },

    /** Forget the stored credentials; keep the saved address/login settings. */
    'config.clear': async () => {
      await ctx.credentials.unset(ref)
      await ctx.credentials.unset(sessionRef)
      await scope.update({ authKind: '' } as { baseUrl?: string, authKind?: string, passwordLogin?: string })
      // Credentials are gone: drop the chat route too so the selector stops
      // offering key-less models (models.sync re-adds it after the next login).
      await removeRouteFromCatalog('signed out')
      snapshotClient = undefined
      snapshotClientKey = ''
      invalidateSnapshot()
      return ok({})
    },

    /**
     * User, tokens, models, usage, and server info in one call. Served from a
     * short TTL cache; pass `{force: true}` (manual refresh) to bypass it.
     */
    'snapshot.get': (payload, signal) => fetchSnapshot(signal, (payload as { force?: unknown } | null)?.force === true),

    /** Cached-when-possible user-only view for the footer identity widget. */
    'user.get': (_payload, signal) => fetchUser(signal),

    /**
     * Create a fresh API key server-side and return its full value exactly
     * once (NewAPI never shows it again) plus the new token row id.
     */
    'tokens.create': async (payload, signal) => {
      const baseUrl = currentBaseUrl()
      if (baseUrl === '') return fail('not-configured', 'no NewAPI base URL configured')
      const credential = await currentCredential()
      if (credential === undefined) return fail('not-configured', 'no NewAPI credential configured')
      const rawName = (payload as { name?: unknown } | null)?.name
      const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim().slice(0, 64) : `DSH-${new Date().toISOString().slice(0, 10)}`
      const client = snapshotClientFor(baseUrl, credential)
      try {
        const before = new Set((await client.getTokens(signal)).map((token) => token.id))
        await client.createToken(name, signal)
        let created: NewApiToken | undefined
        // The new row can take a moment to appear in the listing.
        for (let attempt = 0; attempt < 3 && created === undefined; attempt += 1) {
          const tokens = await client.getTokens(signal)
          created = tokens.find((token) => !before.has(token.id))
          if (created === undefined && attempt === 2 && tokens.length === 1) created = tokens[0]
        }
        if (created === undefined) return fail('create-failed', 'newapi did not list the created token')
        const key = await client.getTokenKey(created.id, signal)
        if (key === '') return fail('create-failed', 'newapi returned an empty key')
        invalidateSnapshot()
        return ok({ id: created.id, name, key })
      } catch (error) {
        return fail('create-failed', describeError(error))
      }
    },

    /** Fetch the full (unmasked) key of one token for click-to-reveal. */
    'tokens.revealKey': async (payload, signal) => {
      const id = (payload as { id?: unknown } | null)?.id
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        return fail('invalid-argument', 'id must be a positive integer')
      }
      const baseUrl = currentBaseUrl()
      if (baseUrl === '') return fail('not-configured', 'no NewAPI base URL configured')
      const credential = await currentCredential()
      if (credential === undefined) return fail('not-configured', 'no NewAPI credential configured')
      try {
        const key = await snapshotClientFor(baseUrl, credential).getTokenKey(id, signal)
        return ok({ id, key })
      } catch (error) {
        return fail('fetch-failed', describeError(error))
      }
    },

    /**
     * Sync models into the LLM catalog: writes the llm-pi-ai settings section
     * `providers.<route>` so the shipped pi-ai adapter registers the chat
     * route. The token is *referenced* (apiKeyEnv), never copied. Stored
     * per-model limits (contextWindow / maxTokens) ride along on each entry
     * so DSH sizes requests to the real model capability.
     */
    'models.sync': async (payload, signal) => {
      if (ctx.settings.get(LLM_PI_AI_NS) === undefined) {
        return fail('adapter-missing', 'the llm-pi-ai settings namespace is not registered; install or enable @deepseek-ai/dsh-llm-pi-ai in this profile')
      }
      const limit = readSyncLimit(payload)
      const result = await fetchSnapshot(signal)
      if (!result.ok) return result
      const snapshot = result.value
      if (snapshot.models.length === 0) return fail('no-models', 'newapi returned no visible models')
      const limits = readModelLimits(stored().modelLimits)
      const defaultContextWindow = currentDefaultContextWindow()
      const models = (limit === undefined ? snapshot.models : snapshot.models.slice(0, limit)).map((model) => ({
        id: model.id,
        // Explicit per-model limits win; otherwise the default context window
        // (180k out of the box) sizes requests for models the gateway can't
        // describe. 0 disables the default.
        ...(limits[model.id] ?? (defaultContextWindow > 0 ? { contextWindow: defaultContextWindow } : {})),
      }))
      // The OpenAI-compatible endpoint is the console origin plus /v1; string
      // concatenation preserves any base path a subpath deployment carries.
      const baseURL = `${currentBaseUrl().replace(/\/+$/, '')}/v1`
      const profile = {
        displayName,
        apiKeyEnv,
        api: 'openai-completions',
        baseURL,
        models,
      }
      await ctx.settings.update(LLM_PI_AI_NS, { providers: { [route]: profile } })
      return ok({ route, count: models.length, baseURL })
    },

    /**
     * Set (or clear, with non-positive/absent values) one model's capability
     * limits, persist them in the newapi settings namespace, and re-sync the
     * llm-pi-ai profile so the limits take effect immediately.
     */
    'models.setLimit': async (payload) => {
      const input = (payload ?? {}) as { id?: unknown, contextWindow?: unknown, maxTokens?: unknown }
      if (typeof input.id !== 'string' || input.id === '') {
        return fail('invalid-argument', 'id is required')
      }
      const readLimit = (value: unknown): number | undefined => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
        const rounded = Math.floor(value)
        return rounded > 0 ? rounded : undefined
      }
      const contextWindow = readLimit(input.contextWindow)
      const maxTokens = readLimit(input.maxTokens)
      const limits: ModelLimits = readModelLimits(stored().modelLimits)
      const entry: { contextWindow?: number, maxTokens?: number } = { ...limits[input.id] }
      if (contextWindow !== undefined) entry.contextWindow = contextWindow
      else delete entry.contextWindow
      if (maxTokens !== undefined) entry.maxTokens = maxTokens
      else delete entry.maxTokens
      if (Object.keys(entry).length === 0) delete limits[input.id]
      else limits[input.id] = entry
      await scope.update({ modelLimits: JSON.stringify(limits) } as { baseUrl?: string, authKind?: string, passwordLogin?: string, currency?: string, modelLimits?: string })
      logger.info(`newapi: stored model limits for ${input.id} (${JSON.stringify(entry)})`)
      // Apply right away; a sync failure leaves the limits stored for the
      // next sync (e.g. after login), so it's non-fatal here.
      const synced = await endpoints['models.sync']({}, undefined)
      if (!synced.ok) logger.warn(`newapi: re-sync after setting model limits failed (${synced.error.code})`)
      return ok({ id: input.id, limits: entry, synced: synced.ok })
    },
  }

  ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
    const handler = endpoints[endpoint]
    if (handler === undefined) return fail('not-found', `unknown endpoint ${endpoint}`)
    try {
      return await handler(payload, signal)
    } catch (error) {
      logger.warn(`newapi: ${endpoint} failed: ${describeError(error)}`)
      return fail('internal', describeError(error))
    }
  }, { authority: 'loopback' })

  /**
   * Hide the chat models while they cannot work: when the chat API key is
   * missing, the synced `llm-pi-ai` route would still show its models in the
   * chat selector and fail every request with MISSING_CREDENTIAL. Remove the
   * route (a path-addressed `unset` — sparse `update` patches can never delete
   * a key) so the selector drops the group until the next `models.sync` after
   * a successful login/key restore re-adds it.
   */
  async function removeRouteFromCatalog(reason: string): Promise<void> {
    try {
      const section = ctx.settings.get(LLM_PI_AI_NS) as { providers?: Record<string, unknown> } | undefined
      if (section?.providers === undefined || !(route in section.providers)) return
      const mutate = (ctx.settings as unknown as {
        mutate?: (ns: string, ops: Array<{ op: 'unset', path: string[] }>) => Promise<void>
      }).mutate
      if (mutate === undefined) {
        logger.warn('newapi: settings service exposes no mutate; cannot hide the key-less route')
        return
      }
      await mutate(LLM_PI_AI_NS, [{ op: 'unset', path: ['providers', route] }])
      logger.info(`newapi: removed the key-less route "${route}" from the chat model catalog (${reason})`)
    } catch (error) {
      logger.warn(`newapi: removing the key-less route failed: ${describeError(error)}`)
    }
  }

  /**
   * Self-heal a lost chat API key: the credential store can lose NEWAPI_API_KEY
   * (e.g. an unclean shutdown across app instances) while the session cookie
   * survives; rebuild the key from that session so chat keeps working without
   * a manual re-login.
   */
  async function ensureApiKeyStored(): Promise<void> {
    try {
      const described = await ctx.credentials.describe(ref)
      if (described.configured) return
      const baseUrl = currentBaseUrl()
      const credential = await currentCredential()
      if (baseUrl === '' || credential === undefined) return
      const client = snapshotClientFor(baseUrl, credential)
      const { key } = await client.ensureApiKey()
      if (key === '') return
      await ctx.credentials.set(ref, key)
      logger.info('newapi: restored the missing chat API key from the stored session')
    } catch (error) {
      logger.warn(`newapi: restoring the chat API key failed: ${describeError(error)}`)
    }
  }

  /**
   * Startup catalog guard: after the key self-heal had its chance, hide the
   * route again when the chat API key is still missing, so the model selector
   * never offers models that would fail with MISSING_CREDENTIAL.
   */
  async function hideRouteWhenKeyMissing(): Promise<void> {
    try {
      const described = await ctx.credentials.describe(ref)
      if (described.configured) return
      await removeRouteFromCatalog('api key missing at startup')
    } catch (error) {
      logger.warn(`newapi: startup catalog guard failed: ${describeError(error)}`)
    }
  }

  void (async () => {
    await ensureApiKeyStored()
    await hideRouteWhenKeyMissing()
  })()

  logger.info(`newapi: ready (route=${route}, apiKeyEnv=${apiKeyEnv})`)
}

interface SnapshotPayload extends NewApiSnapshot {
  baseUrl: string
  server: NewApiServerInfo
  /** True when this is cached data served while a refresh runs / failed. */
  stale?: boolean
  /** Unix ms timestamp of the cached data (present with `stale`). */
  cachedAt?: number
}

function readBaseUrl(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const raw = (payload as { baseUrl?: unknown }).baseUrl
  return typeof raw === 'string' ? raw.trim() : ''
}

function readPasswordPayload(payload: unknown): { baseUrl: string, username: string, password: string } {
  if (typeof payload !== 'object' || payload === null) return { baseUrl: '', username: '', password: '' }
  const username = typeof (payload as { username?: unknown }).username === 'string' ? (payload as { username: string }).username.trim() : ''
  const password = typeof (payload as { password?: unknown }).password === 'string' ? (payload as { password: string }).password : ''
  return { baseUrl: readBaseUrl(payload), username, password }
}

/**
 * Normalize a user-entered console URL: tolerate a trailing `/v1` (copied from
 * the OpenAI-compatible endpoint) and trailing slashes. Management endpoints
 * always live directly under `<origin>/api`.
 */
function normalizeBaseUrl(raw: string): string {
  let value = raw.replace(/\/+$/, '')
  if (value.endsWith('/v1')) value = value.slice(0, -3).replace(/\/+$/, '')
  return value
}

function readSyncLimit(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = (payload as { limit?: unknown }).limit
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return undefined
  return raw
}
