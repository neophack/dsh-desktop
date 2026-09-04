/**
 * Browser entry for dsh-plugin-websearch: a Settings page right after the
 * NewAPI entry (order 16 sits between the order-15 sections and agent
 * presets' 20) that edits the Host plugin's `websearch` settings section
 * through the shared settingsScope service — no private RPC channel, so the
 * page works against the ordinary settings document alone.
 *
 * Fields stage locally and commit on one explicit save: baseUrl / engine /
 * apiToken / timeoutMs. A field left blank (or reverted to the shipped
 * default) is UNSET rather than written, so the section re-inherits the
 * composition layer from the loader row (the product's Crawl4AI address and
 * bing preset) instead of accumulating copies of the default.
 */
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const NS = 'settings.websearch'

/** Settings namespace the Host plugin installs (src/index.ts). */
const SETTINGS_NAMESPACE = 'websearch'

/** Engine preset ids the Host provider accepts. */
const ENGINES = ['bing', 'duckduckgo'] as const

/** Effective section shape the Host schema resolves. */
interface WebSearchSectionView {
  baseUrl?: string
  engine?: string
  serpUrl?: string
  apiToken?: string
  timeoutMs?: number
}

/** Structural view of SettingsScopeSnapshot (the client bundle is untyped). */
interface ScopeSnapshotView {
  status: 'loading' | 'ready' | 'unavailable'
  value: WebSearchSectionView | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/** Structural view of one bound SettingsScope. */
interface BoundScope {
  getSnapshot(): ScopeSnapshotView
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** One secret position the Host redacted out of a namespace view. */
interface SecretView {
  path: string[]
  set: boolean
}

/** One namespace row of the shared describe mirror's view. */
interface NamespaceRowView {
  ns: string
  secrets: SecretView[]
}

/** Structural view of the shared describe mirror face. */
interface DescribeFace {
  getSnapshot(): { status: string, view?: { namespaces: readonly NamespaceRowView[] } }
  subscribe(listener: () => void): () => void
  ensure?: () => void
}

/** Looser structural typing for the client Cordis context (bundle is untyped). */
interface ClientCtx {
  effect: (setup: () => () => void, label?: string) => () => void
  settingsScope: { bind(spec: { namespace: string }): BoundScope, describe(): DescribeFace }
  slots: {
    inject: (key: string, callback: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: (props: SectionProps) => JSX.Element | null) => () => void
  }
  locale: {
    register: (ns: string, dicts: Record<string, Record<string, string>>) => () => void
    bind: (ns: string) => (key: string, params?: Record<string, string | number>) => string
  }
}

export const inject = ['slots', 'locale', 'settingsScope']

/** Props the settings shell binds from this section's injected face. */
interface SectionProps {
  t?: (key: string, params?: Record<string, string | number>) => string
  scope?: BoundScope
  describe?: DescribeFace
}

const NOOP_T: NonNullable<SectionProps['t']> = (key) => key

export function apply(ctx: ClientCtx): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'websearch: copy dictionaries')
  ctx.effect(injectSettingsStyle, 'websearch: settings page styles')
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
  const describe = ctx.settingsScope.describe()
  describe.ensure?.()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'websearch',
    order: 16,
    label: () => t('nav'),
    inject: () => ({ t, scope, describe }),
  }, WebSearchSettings))
}

const zh: Record<string, string> = {
  nav: '网页搜索',
  intro: '通过自建 Crawl4AI 服务器抓取搜索引擎结果页, 为对话提供网页搜索; 此处可修改服务器地址、引擎与访问令牌。',
  serverGroup: 'Crawl4AI 服务器',
  baseUrl: '服务器地址',
  baseUrlHint: '默认 {url}; 清空则恢复默认。',
  apiToken: '访问令牌',
  apiTokenHint: '服务器开启鉴权时必填 (对应 CRAWL4AI_API_TOKEN); 令牌不会回显。',
  apiTokenSet: '已配置',
  apiTokenUnset: '未配置',
  clearToken: '清除令牌',
  searchGroup: '搜索',
  engine: '搜索引擎',
  engineHint: '结果页被抓取的引擎; 排版变化导致无结果时可切换另一个。',
  engineBing: '必应 (Bing)',
  engineDuckduckgo: 'DuckDuckGo',
  timeout: '超时 (毫秒)',
  timeoutHint: '单次搜索请求的超时, 默认 60000; 最小 1000。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalidTimeout: '超时需为不小于 1000 的整数',
  save: '保存设置',
  saving: '保存中...',
  saved: '设置已保存。',
  saveFailed: '保存失败: {message}',
  unavailable: '网页搜索服务未启用 (未加载 dsh-plugin-websearch)。',
  readonly: '设置文档当前只读, 无法保存。',
}

const en: Record<string, string> = {
  nav: 'Web search',
  intro: 'Web search for chat runs through a self-hosted Crawl4AI server; adjust the server address, engine, and access token here.',
  serverGroup: 'Crawl4AI server',
  baseUrl: 'Server URL',
  baseUrlHint: 'Default {url}; clearing the field restores the default.',
  apiToken: 'Access token',
  apiTokenHint: 'Required when the server enforces authentication (its CRAWL4AI_API_TOKEN); the stored token is never echoed back.',
  apiTokenSet: 'Configured',
  apiTokenUnset: 'Not set',
  clearToken: 'Clear token',
  searchGroup: 'Search',
  engine: 'Search engine',
  engineHint: 'The engine whose results page is crawled; switch engines when a markup change yields no results.',
  engineBing: 'Bing',
  engineDuckduckgo: 'DuckDuckGo',
  timeout: 'Timeout (ms)',
  timeoutHint: 'Per-request timeout, default 60000; minimum 1000.',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidTimeout: 'Timeout must be an integer of at least 1000',
  save: 'Save settings',
  saving: 'Saving...',
  saved: 'Settings saved.',
  saveFailed: 'Save failed: {message}',
  unavailable: 'The web search service is not enabled (dsh-plugin-websearch not loaded).',
  readonly: 'The settings document is read-only right now; nothing can be saved.',
}

const SETTINGS_STYLE_TAG = 'dsh-plugin-websearch/settings-styles'

const SETTINGS_CSS = `
.dshWebsearchSettings {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: min(100%, 880px);
  padding: 2px 0 36px;
  color: var(--dsw-alias-label-primary);
}
.dshWebsearchSettingsHeader h2,
.dshWebsearchSettingsGroup h3 { margin: 0; font-weight: 600; }
.dshWebsearchSettingsHeader h2 { font-size: 22px; line-height: 1.35; letter-spacing: -0.015em; }
.dshWebsearchSettingsGroup h3 { font-size: 15px; line-height: 1.4; letter-spacing: -0.01em; }
.dshWebsearchSettingsHeader p,
.dshWebsearchSettingsHint {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.dshWebsearchSettingsGroup {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshWebsearchSettingsCard {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshWebsearchSettingsField {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dshWebsearchSettingsLabel {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
}
.dshWebsearchSettingsBadge {
  padding: 1px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 400;
}
.dshWebsearchSettingsInput,
.dshWebsearchSettingsSelect {
  width: 100%;
  min-height: 36px;
  box-sizing: border-box;
  padding: 7px 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dshWebsearchSettingsInput:focus-visible,
.dshWebsearchSettingsSelect:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
}
.dshWebsearchSettingsTokenRow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dshWebsearchSettingsTokenRow .dshWebsearchSettingsInput { flex: 1; }
.dshWebsearchSettingsButton {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 5px 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.dshWebsearchSettingsButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshWebsearchSettingsButton:disabled { cursor: default; opacity: .55; }
.dshWebsearchSettingsFooter {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 12px;
  border-top: 1px dashed var(--dsw-alias-border-l1);
}
.dshWebsearchSettingsSave {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 5px 16px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill, #4a6cf7));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
}
.dshWebsearchSettingsSave:hover:not(:disabled) { filter: brightness(1.06); }
.dshWebsearchSettingsSave:disabled { cursor: default; opacity: .55; }
.dshWebsearchSettingsSaved { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
.dshWebsearchSettingsError { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dshWebsearchSettingsUnavailable {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
`

function injectSettingsStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css="${SETTINGS_STYLE_TAG}"]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.pluginCss = SETTINGS_STYLE_TAG
  tag.textContent = SETTINGS_CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

/** One bound scope observed as React state (the app's React may predate useSyncExternalStore). */
function useScopeSnapshot(scope: BoundScope): ScopeSnapshotView {
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => { setSnapshot(scope.getSnapshot()) }), [scope])
  return snapshot
}

/** This namespace's row on the shared describe mirror (secrets never ride values). */
function describeRowOf(describe: DescribeFace | undefined): NamespaceRowView | undefined {
  return describe?.getSnapshot().view?.namespaces.find(candidate => candidate.ns === SETTINGS_NAMESPACE)
}

/** Observe the describe mirror's row for the websearch namespace. */
function useDescribeRow(describe: DescribeFace | undefined): NamespaceRowView | undefined {
  const [row, setRow] = useState<NamespaceRowView | undefined>(() => describeRowOf(describe))
  useEffect(() => describe?.subscribe(() => { setRow(describeRowOf(describe)) }), [describe])
  return row
}

/** True when the user layer carries a field (presence, not value, marks an override). */
function userHasField(user: unknown, field: string): boolean {
  return typeof user === 'object' && user !== null && field in (user as Record<string, unknown>)
}

/**
 * The websearch settings page: staged form over the `websearch` section.
 * Drafts seed once from the effective section and re-seed directly from the
 * settled snapshot after each successful save.
 */
function WebSearchSettings(props: SectionProps): JSX.Element | null {
  const t = props.t ?? NOOP_T
  const scope = props.scope
  const snapshot = useScopeSnapshot(scope ?? FALLBACK_SCOPE)
  const describeRow = useDescribeRow(props.describe)
  /** Secrets are stripped from every wire value; presence lives on the describe row. */
  const tokenConfigured = describeRow?.secrets.some(secret => secret.path[0] === 'apiToken' && secret.set) === true
  const effective = snapshot.value
  const [baseUrl, setBaseUrl] = useState('')
  const [engine, setEngine] = useState<string>('bing')
  const [timeout, setTimeoutText] = useState('')
  const [token, setToken] = useState('')
  /** Explicitly staged token clear; typing over it cancels the clear. */
  const [tokenCleared, setTokenCleared] = useState(false)
  const [seeded, setSeeded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const seededRef = useRef(false)

  const baseSection = snapshot.base as WebSearchSectionView | undefined
  const defaultEngine = typeof baseSection?.engine === 'string' ? baseSection.engine : 'bing'
  const defaultBaseUrl = typeof baseSection?.baseUrl === 'string' ? baseSection.baseUrl : 'http://172.24.204.251:21235'

  const seed = (section: WebSearchSectionView): void => {
    setBaseUrl(section.baseUrl ?? '')
    setEngine(section.engine ?? defaultEngine)
    setTimeoutText(section.timeoutMs !== undefined ? String(section.timeoutMs) : '')
    setToken('')
    setTokenCleared(false)
    setSeeded(true)
  }

  useEffect(() => {
    if (scope === undefined || snapshot.status !== 'ready' || effective === undefined) return
    if (seededRef.current) return
    seededRef.current = true
    seed(effective)
  }, [snapshot.status, effective, scope, defaultEngine])

  if (scope === undefined) return null
  if (snapshot.status === 'unavailable') {
    return (
      <div className="dshWebsearchSettings">
        <p className="dshWebsearchSettingsUnavailable">{t('unavailable')}</p>
      </div>
    )
  }
  if (snapshot.status === 'loading' || !seeded) {
    return <div className="dshWebsearchSettings" aria-busy="true" />
  }

  const disabled = !snapshot.writable || busy
  const trimmedTimeout = timeout.trim()
  let timeoutInvalid = false
  if (trimmedTimeout !== '') {
    const parsedTimeout = Number.parseInt(trimmedTimeout, 10)
    timeoutInvalid = !Number.isFinite(parsedTimeout) || parsedTimeout < 1000
  }
  const trimmedBaseUrl = baseUrl.trim()
  const tokenStaged = token.trim() !== ''
  const changed = trimmedBaseUrl !== (effective.baseUrl ?? '')
    || engine !== (effective.engine ?? defaultEngine)
    || trimmedTimeout !== (effective.timeoutMs !== undefined ? String(effective.timeoutMs) : '')
    || tokenStaged
    || tokenCleared
  const blocked = disabled || timeoutInvalid || !changed

  /** One explicit save: changed fields are set, cleared ones unset. */
  const save = (): void => {
    if (blocked) return
    setBusy(true)
    setError(undefined)
    void (async () => {
      try {
        if (trimmedBaseUrl === '') await scope.unset('baseUrl')
        else if (trimmedBaseUrl !== (effective.baseUrl ?? '')) await scope.set('baseUrl', trimmedBaseUrl)
        if (engine !== (effective.engine ?? defaultEngine)) await scope.set('engine', engine)
        if (trimmedTimeout === '') await scope.unset('timeoutMs')
        else if (trimmedTimeout !== (effective.timeoutMs !== undefined ? String(effective.timeoutMs) : '')) {
          await scope.set('timeoutMs', Number.parseInt(trimmedTimeout, 10))
        }
        if (tokenCleared && !tokenStaged) await scope.unset('apiToken')
        else if (tokenStaged) await scope.set('apiToken', token.trim())
        const fresh = scope.getSnapshot().value
        if (fresh !== undefined) seed(fresh)
        setJustSaved(true)
      } catch (cause: unknown) {
        setError(t('saveFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <div className="dshWebsearchSettings">
      <header className="dshWebsearchSettingsHeader">
        <h2>{t('nav')}</h2>
        <p>{t('intro')}</p>
      </header>

      <section className="dshWebsearchSettingsGroup">
        <h3>{t('serverGroup')}</h3>
        <div className="dshWebsearchSettingsCard">
          <label className="dshWebsearchSettingsField">
            <span className="dshWebsearchSettingsLabel">
              {t('baseUrl')}
              {userHasField(snapshot.user, 'baseUrl') ? <span className="dshWebsearchSettingsBadge">{t('overridden')}</span> : null}
            </span>
            <input
              className="dshWebsearchSettingsInput"
              value={baseUrl}
              placeholder={defaultBaseUrl}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => { setBaseUrl(event.target.value); setJustSaved(false) }}
            />
            <span className="dshWebsearchSettingsHint">{t('baseUrlHint', { url: defaultBaseUrl })}</span>
          </label>
          <div className="dshWebsearchSettingsField">
            <span className="dshWebsearchSettingsLabel">
              {t('apiToken')}
              <span className="dshWebsearchSettingsBadge">
                {tokenCleared || !tokenConfigured ? t('apiTokenUnset') : t('apiTokenSet')}
              </span>
            </span>
            <div className="dshWebsearchSettingsTokenRow">
              <input
                className="dshWebsearchSettingsInput"
                type="password"
                value={token}
                placeholder={tokenCleared || !tokenConfigured ? '' : '••••••••'}
                disabled={disabled}
                autoComplete="off"
                onChange={(event) => { setToken(event.target.value); setTokenCleared(false); setJustSaved(false) }}
              />
              {tokenConfigured ? (
                <button
                  type="button"
                  className="dshWebsearchSettingsButton"
                  disabled={disabled}
                  onClick={() => { setToken(''); setTokenCleared(!tokenCleared); setJustSaved(false) }}
                >
                  {t('clearToken')}
                </button>
              ) : null}
            </div>
            <span className="dshWebsearchSettingsHint">{t('apiTokenHint')}</span>
          </div>
        </div>
      </section>

      <section className="dshWebsearchSettingsGroup">
        <h3>{t('searchGroup')}</h3>
        <div className="dshWebsearchSettingsCard">
          <label className="dshWebsearchSettingsField">
            <span className="dshWebsearchSettingsLabel">
              {t('engine')}
              {userHasField(snapshot.user, 'engine') ? <span className="dshWebsearchSettingsBadge">{t('overridden')}</span> : null}
            </span>
            <select
              className="dshWebsearchSettingsSelect"
              value={engine}
              disabled={disabled}
              onChange={(event) => { setEngine(event.target.value); setJustSaved(false) }}
            >
              {ENGINES.map((id) => (
                <option key={id} value={id}>{id === 'bing' ? t('engineBing') : t('engineDuckduckgo')}</option>
              ))}
            </select>
            <span className="dshWebsearchSettingsHint">{t('engineHint')}</span>
          </label>
          <label className="dshWebsearchSettingsField">
            <span className="dshWebsearchSettingsLabel">
              {t('timeout')}
              {userHasField(snapshot.user, 'timeoutMs') ? <span className="dshWebsearchSettingsBadge">{t('overridden')}</span> : null}
            </span>
            <input
              className="dshWebsearchSettingsInput"
              value={timeout}
              inputMode="numeric"
              disabled={disabled}
              onChange={(event) => { setTimeoutText(event.target.value); setJustSaved(false) }}
            />
            <span className="dshWebsearchSettingsHint" style={timeoutInvalid ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined}>
              {timeoutInvalid ? t('invalidTimeout') : t('timeoutHint')}
            </span>
          </label>
        </div>
      </section>

      <div className="dshWebsearchSettingsCard">
        <div className="dshWebsearchSettingsFooter">
          <button type="button" className="dshWebsearchSettingsSave" disabled={blocked} onClick={save}>
            {busy ? t('saving') : t('save')}
          </button>
          {justSaved && error === undefined ? <span className="dshWebsearchSettingsSaved" role="status">{t('saved')}</span> : null}
          {error !== undefined ? <span className="dshWebsearchSettingsError" role="alert">{error}</span> : null}
          {!snapshot.writable ? <span className="dshWebsearchSettingsError">{t('readonly')}</span> : null}
        </div>
      </div>
    </div>
  )
}

/** Sentinel scope for the missing-inject render pass: permanently loading. */
const FALLBACK_SCOPE: BoundScope = {
  getSnapshot: () => ({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }),
  subscribe: () => () => {},
  set: async () => {},
  unset: async () => {},
}
