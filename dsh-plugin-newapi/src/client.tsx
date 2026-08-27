/**
 * Browser entry for dsh-plugin-newapi.
 *
 * Two surfaces share one session hook but are designed separately:
 *
 * - Popup (sidebar footer modal): a compact, flat sign-in + usage card. It
 *   shows the account, a quota usage progress bar, and per-token usage bars;
 *   no server configuration or model tables. When not signed in it jumps
 *   straight into the embedded provider (Feishu) sign-in flow.
 * - Settings page (settings.section): the full management surface — server
 *   address override, probe, password-login switch, currency, account
 *   details, API keys, model catalog with per-model limits, and model sync.
 *
 * Both talk to the Host half through the loopback-fenced `/newapi` Connection
 * RPC channel. Model sync writes the official `llm-pi-ai` settings namespace,
 * so the chat model selector picks the route up through the normal catalog;
 * no private APIs.
 *
 * Login UX notes: NewAPI's OAuth redirect_uri is registered server-side, so
 * the Host runs the whole flow itself — it mints the OAuth state in its
 * private cookie jar, opens the provider's authorize page in a dedicated
 * top-level login window (a top-level redirect is the only reliable way the
 * NewAPI session cookie lands in the Electron default session; cross-site
 * iframe XHR Set-Cookies are dropped), and watches that session. When the
 * redirect lands, the Host completes the code exchange and captures the
 * authenticated session automatically; no copy-paste involved.
 */
import { jsx, jsxs } from 'react/jsx-runtime'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Button, IconUserOutline16, Input, Modal, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'

const NS = 'settings.newapi'
const CHANNEL = '/newapi'

type RpcResult<T> = { ok: true, value: T } | { ok: false, error: { code: string, message: string } }

interface ConfigView {
  baseUrl: string
  /** Built-in default origin from the loader row ('' when none). */
  baseUrlDefault: string
  /** True when the saved address differs from the built-in default. */
  baseUrlOverridden: boolean
  /** Effective username/password switch (settings override > loader row). */
  passwordLogin: boolean
  /** Display currency for quota/price figures (default cny). */
  currency: Currency
  /** Per-model capability limits (tokens), persisted host-side. */
  modelLimits: Record<string, { contextWindow?: number, maxTokens?: number }>
  /** Context window (tokens) applied to every model without explicit limits; 0 = none. */
  defaultContextWindow: number
  authKind: string
  tokenConfigured: boolean
  apiKeyConfigured: boolean
  route: string
  apiKeyEnv: string
  displayName: string
}

interface ServerInfoView {
  systemName: string
  version: string
  quotaPerUnit: number
  usdExchangeRate: number
  passwordLogin: boolean
  oauthProviders: Array<{ slug: string, name: string }>
}

interface ServerStatusView {
  baseUrl: string
  info: ServerInfoView
}

interface TokenRow {
  id: number
  name?: string
  key?: string
  status?: number
  quota?: number
  used_quota?: number
  expired_time?: number
  models?: string
  group?: string
}

interface ModelRow {
  id: string
  priced?: boolean
  inputPrice?: number
  outputPrice?: number
}

interface UsageView {
  quotaUsed?: number
  quotaRemaining?: number
  quotaTotal?: number
  unlimited?: boolean
}

interface SnapshotView {
  baseUrl: string
  server: ServerInfoView
  user?: { id: number, username?: string, display_name?: string, email?: string, group?: string, request_count?: number }
  tokens: TokenRow[]
  models: ModelRow[]
  usage: UsageView
  /** True when this is cached data served while a refresh runs / failed. */
  stale?: boolean
  /** Unix ms timestamp of the cached data (present with `stale`). */
  cachedAt?: number
}

const QUOTA_PER_UNIT = 500_000

type Currency = 'cny' | 'usd'

/** Format a USD-denominated amount in the selected display currency. */
function money(value: number | undefined, currency: Currency, rate: number): string {
  if (value === undefined) return '--'
  if (currency === 'cny' && rate > 0) return `¥${(value * rate).toFixed(2)}`
  return `$${value.toFixed(2)}`
}

function formatPrice(value: number | undefined, currency: Currency, rate: number): string {
  return money(value, currency, rate)
}

function formatQuota(quota: number | undefined, quotaPerUnit: number, currency: Currency, rate: number): string {
  if (quota === undefined) return '--'
  if (quota < 0) return 'unlimited'
  return money(quota / (quotaPerUnit > 0 ? quotaPerUnit : QUOTA_PER_UNIT), currency, rate)
}

function formatDate(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return '--'
  return new Date(seconds * 1000).toLocaleDateString()
}

function formatCachedAt(ms: number | undefined): string {
  if (ms === undefined) return '--'
  return new Date(ms).toLocaleString()
}

/** Offline / background-refresh notice shown above data served from cache. */
function StaleNote(props: { snapshot: SnapshotView | undefined, t: NonNullable<SectionProps['t']> }): JSX.Element | null {
  if (props.snapshot?.stale !== true) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' }}>
      <StateDot state="warning" />
      {props.t('staleCache', { time: formatCachedAt(props.snapshot.cachedAt) })}
    </span>
  )
}

/** Looser structural typing for the client Cordis context (bundle is untyped). */
interface ClientCtx {
  effect: (setup: () => () => void, label?: string) => () => void
  get: (key: string) => unknown
  slots: {
    inject: (key: string, callback: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: (props: SectionProps) => JSX.Element | null) => () => void
  }
  locale: {
    register: (ns: string, dicts: Record<string, Record<string, string>>) => () => void
    bind: (ns: string) => (key: string, params?: Record<string, string | number>) => string
  }
}

export const inject = ['slots', 'locale', 'connection']

interface SectionProps {
  call?: <T>(endpoint: string, payload?: unknown) => Promise<RpcResult<T>>
  t?: (key: string, params?: Record<string, string | number>) => string
  /** Footer entry: when not signed in yet, jump straight into the embedded
   *  provider (Feishu) sign-in instead of showing the config form first. */
  autoLogin?: boolean
  /** Show the server-config form (address, probe, password-login switch).
   *  Settings page only — the login modal stays a pure sign-in surface. */
  showConfig?: boolean
  /** Called once a sign-in succeeded (footer modal closes itself). */
  onAuthenticated?: () => void
}

const FOOTER_STYLE_TAG = 'dsh-plugin-newapi/sidebar-footer-row'

/**
 * The sidebar shell stacks its footer as two block rows (footerActions above
 * settingsArea), which leaves the login button stranded on its own line above
 * Settings. Merge the two rows into one row and spread it edge to edge — the
 * login action hugs the left edge, the Settings trigger the right one — while
 * both shrink to content width, so the footer reads `[login] ...... [settings]`.
 * Scoped to the slot anchors (module CSS class names are hashed, so :has()
 * chains address them structurally); removing the tag restores the shell.
 */
function injectFooterRowStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css="${FOOTER_STYLE_TAG}"]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.pluginCss = FOOTER_STYLE_TAG
  tag.textContent = [
    // footArea (the only div whose grandchild is the footer.action anchor): row,
    // login (DOM-first) pinned left, Settings pinned right.
    'div:has(> div > [data-slot="sidebar.footer.action"]){flex-direction:row !important;justify-content:space-between;align-items:center;}',
    // Both footer rows shrink to content so the pair can sit at opposite edges.
    'div:has(> [data-slot="sidebar.footer.action"]),div:has(> [data-slot="sidebar.settings"]){width:auto !important;}',
    // Popup waiting-spinner keyframes.
    '@keyframes dsh-newapi-spin{to{transform:rotate(360deg)}}',
  ].join('\n')
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'newapi: copy dictionaries')
  ctx.effect(injectFooterRowStyle, 'newapi: sidebar footer row layout')
  const connection = ctx.get('connection') as {
    rpc: { call: <T>(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<RpcResult<T>> }
  }
  // The wire envelope requires a present `payload` member (JSON.stringify
  // drops undefined keys), so default to an empty object rather than undefined.
  // Transport/schema failures surface as typed failures instead of throwing,
  // so one bad call can never abort the section's mount effect.
  const call = async <T,>(endpoint: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<RpcResult<T>> => {
    try {
      return await connection.rpc.call<T>(CHANNEL, endpoint, payload, signal)
    } catch (error) {
      return { ok: false, error: { code: 'transport', message: error instanceof Error ? error.message : String(error) } }
    }
  }
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'newapi',
    order: 15,
    label: () => t('nav'),
    inject: () => ({ call, t, showConfig: true }),
  }, NewApiSettings))
  // Sidebar footer seat: the shell stacks this list slot in a row above the
  // Settings trigger; injectFooterRowStyle merges the two rows into one
  // right-aligned `[login] [settings]` row (and shrinks Settings to content
  // width), matching the collapsed rail behavior unchanged.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'newapi-login',
    order: 10,
    locale: NS,
    inject: () => ({ call, t }),
  }, NewApiFooterButton))
}

const zh: Record<string, string> = {
  nav: 'NewAPI',
  footerLabel: '登录 NewAPI',
  close: '关闭',
  intro: '连接 NewAPI 网关: 支持飞书等 SSO 登录引导, 管理密钥、查看可用模型与套餐用量, 并同步到对话模型选择器。',
  baseUrl: '服务器地址',
  baseUrlPlaceholder: 'http://172.24.204.251:4000',
  defaultServer: '默认服务器: {url}; 修改后点「保存设置」, 清空则恢复默认。',
  enablePasswordLogin: '启用用户名密码登录',
  currencyLabel: '币种',
  currencyCny: '人民币 (¥)',
  currencyUsd: '美元 ($)',
  defaultContextWindowLabel: '默认上下文',
  defaultContextWindowHint: '所有未单独设置的模型默认 180000 (180k) tokens; 填 0 关闭, 保存后需重新同步模型生效。',
  saveSettings: '保存设置',
  settingsSaved: '设置已保存。',
  loadFailed: '加载配置失败, 请重试。',
  probe: '检测服务器',
  probing: '检测中...',
  probed: '已连接服务器 {name} ({version})',
  login: '登录',
  loginPassword: '密码登录',
  username: '用户名',
  password: '密码',
  loginButton: '登录',
  loggingIn: '登录中...',
  loginOk: '登录成功: {user}',
  ssoButton: '使用{provider}登录',
  embeddedWaiting: '已在独立窗口打开 {provider} 登录; 请在窗口中完成授权 (扫码或账号登录), 成功后插件自动获取凭据、套餐用量, 并自动确保一个 API key (没有就新建, 有就用第一个), 无需复制粘贴。',
  embeddedWindowHint: '请在弹出的登录窗口中完成 {provider} 授权',
  embeddedReopen: '重新打开登录窗口',
  embeddedCancel: '取消登录',
  embeddedCaptureNote: '登录窗口关闭或点击「取消登录」会中止本次登录, 可随时重试。',
  embeddedFailed: '登录未完成或已超时, 请重试。',
  saved: '已连接',
  notConfigured: '尚未登录。',
  clear: '退出登录',
  cleared: '已清除',
  refresh: '刷新',
  loading: '加载中...',
  account: '账户',
  usernameLabel: '用户',
  email: '邮箱',
  group: '分组',
  requests: '请求数',
  quotaUsed: '已用',
  quotaRemaining: '剩余',
  quotaTotal: '总量',
  unlimited: '不限量',
  tokens: 'API 密钥(令牌)',
  tokenName: '名称',
  tokenKey: '密钥',
  tokenQuota: '额度',
  tokenUsed: '已用',
  tokenExpires: '过期时间',
  tokenModels: '可用模型',
  tokenAllModels: '全部模型',
  noTokens: '没有可用的令牌。请在 NewAPI 控制台创建。',
  noTokensHint: '没有可用的令牌, 点击右上角「创建密钥」直接新建一个。',
  createToken: '创建密钥',
  revealKey: '显示',
  copyKey: '复制',
  keyCreatedOnce: '新密钥「{name}」已创建, 完整密钥仅此一次显示:',
  keyCopied: '密钥已复制到剪贴板。',
  keyCopyFailed: '复制失败, 请手动选择复制。',
  models: '支持的模型',
  modelsCount: '{count} 个模型',
  modelId: '模型 ID',
  modelInput: '输入价 / 1M',
  modelOutput: '输出价 / 1M',
  sync: '同步模型到对话',
  syncing: '同步中...',
  synced: '已同步 {count} 个模型到提供方「{route}」; 对话的模型选择器中即可选择。',
  syncNeedsConfig: '请先完成登录。',
  syncLimit: '数量上限(可选)',
  modelLimits: '上下文 / 最大输出',
  editLimit: '设置',
  saveLimit: '保存',
  cancelLimit: '取消',
  contextWindow: '上下文长度',
  maxOutputTokens: '最大输出',
  limitHint: '单位: token; 清空两项则删除该模型的限制',
  limitSaved: '已保存 {model} 的限制并重新同步',
  defaultLimitDisplay: '默认 {window}',
  failure: '操作失败',
  staleCache: '网络不可用或服务器无法连接, 正在显示缓存数据 (更新于 {time})',
  // Popup-only copy.
  popupOpenSettings: '完整设置',  popupUsageTitle: '套餐用量',
  popupTokenUsage: '密钥用量',
  popupRequests: '{count} 次请求',
  popupServer: '服务器',
  popupSignedInAs: '已登录',
  // Init key-setup dialog copy.
  initTitle: '设置 NewAPI',
  initHint: '尚未配置 NewAPI 密钥, 对话中的 NewAPI 模型暂不可见。完成登录后插件会自动获取/创建密钥并同步模型, 本弹窗随之自动关闭。',
}

const en: Record<string, string> = {
  nav: 'NewAPI',
  footerLabel: 'Sign in NewAPI',
  close: 'Close',
  intro: 'Connect a NewAPI gateway: SSO login guidance (Feishu and friends), manage keys, browse supported models and quota usage, and sync them into the chat model selector.',
  baseUrl: 'Server URL',
  baseUrlPlaceholder: 'http://172.24.204.251:4000',
  defaultServer: 'Default server: {url}; edit and press Save settings — clearing the field restores the default.',
  enablePasswordLogin: 'Enable username/password sign-in',
  currencyLabel: 'Currency',
  currencyCny: 'CNY (¥)',
  currencyUsd: 'USD ($)',
  defaultContextWindowLabel: 'Default context',
  defaultContextWindowHint: 'Every model without explicit limits defaults to 180000 (180k) tokens; 0 disables. Save, then re-sync models to apply.',
  saveSettings: 'Save settings',
  settingsSaved: 'Settings saved.',
  loadFailed: 'Failed to load settings; please retry.',
  probe: 'Probe server',
  probing: 'Probing...',
  probed: 'Connected to {name} ({version})',
  login: 'Sign in',
  loginPassword: 'Password sign-in',
  username: 'Username',
  password: 'Password',
  loginButton: 'Sign in',
  loggingIn: 'Signing in...',
  loginOk: 'Signed in as {user}',
  ssoButton: 'Sign in with {provider}',
  embeddedWaiting: 'The {provider} sign-in page opened in its own window; finish the authorization (scan the QR code or sign in) there. The plugin then captures the credential and plan usage automatically and ensures an API key (created if none, first one otherwise) — no copy-paste.',
  embeddedWindowHint: 'Finish the {provider} authorization in the window that just opened',
  embeddedReopen: 'Reopen the sign-in window',
  embeddedCancel: 'Cancel sign-in',
  embeddedCaptureNote: 'Closing the sign-in window or pressing Cancel aborts this attempt; retry any time.',
  embeddedFailed: 'Sign-in did not complete (or timed out); please retry.',
  saved: 'Connected',
  notConfigured: 'Not signed in yet.',
  clear: 'Sign out',
  cleared: 'Cleared',
  refresh: 'Refresh',
  loading: 'Loading...',
  account: 'Account',
  usernameLabel: 'User',
  email: 'Email',
  group: 'Group',
  requests: 'Requests',
  quotaUsed: 'Used',
  quotaRemaining: 'Remaining',
  quotaTotal: 'Total',
  unlimited: 'Unlimited',
  tokens: 'API keys (tokens)',
  tokenName: 'Name',
  tokenKey: 'Key',
  tokenQuota: 'Quota',
  tokenUsed: 'Used',
  tokenExpires: 'Expires',
  tokenModels: 'Models',
  tokenAllModels: 'All models',
  noTokens: 'No tokens. Create one in the NewAPI console.',
  noTokensHint: 'No tokens yet — click "Create key" above to make one right here.',
  createToken: 'Create key',
  revealKey: 'Reveal',
  copyKey: 'Copy',
  keyCreatedOnce: 'Key "{name}" created — shown only once:',
  keyCopied: 'Key copied to clipboard.',
  keyCopyFailed: 'Copy failed; select and copy manually.',
  models: 'Supported models',
  modelsCount: '{count} models',
  modelId: 'Model ID',
  modelInput: 'Input / 1M',
  modelOutput: 'Output / 1M',
  sync: 'Sync models to chat',
  syncing: 'Syncing...',
  synced: 'Synced {count} models to provider "{route}"; pick them from the chat model selector.',
  syncNeedsConfig: 'Sign in first.',
  syncLimit: 'Limit (optional)',
  modelLimits: 'Context / Max out',
  editLimit: 'Set',
  saveLimit: 'Save',
  cancelLimit: 'Cancel',
  contextWindow: 'Context window',
  maxOutputTokens: 'Max output',
  limitHint: 'In tokens; empty both to remove the limit',
  limitSaved: 'Saved limits for {model} and re-synced',
  defaultLimitDisplay: 'default {window}',
  failure: 'Operation failed',
  staleCache: 'Network unavailable or server unreachable — showing cached data (updated {time})',
  // Popup-only copy.
  popupOpenSettings: 'All settings',
  popupUsageTitle: 'Plan usage',
  popupTokenUsage: 'Key usage',
  popupRequests: '{count} requests',
  popupServer: 'Server',
  popupSignedInAs: 'Signed in',
  // Init key-setup dialog copy.
  initTitle: 'Set up NewAPI',
  initHint: 'No NewAPI credential yet, so the NewAPI models stay hidden in the chat selector. Finish the sign-in and the plugin captures/creates the key and syncs the models automatically — this dialog then closes by itself.',
}

/** Flat card wrapper: layer-1 surface, hairline border, 12px radius. */
const cardStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 16,
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
} as const

const cardTitleStyle = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--dsw-alias-label-tertiary, inherit)',
} as const

/**
 * Flat usage progress bar: a hairline pill track on layer-2 with a brand
 * fill; the percent label sits on the same row so the bar itself stays a
 * pure 6px slab. Used ratio is clamped to [0, 1]; warn color past 80%.
 */
function UsageBar(props: { used: number | undefined, total: number | undefined }): JSX.Element {
  const { used, total } = props
  const known = used !== undefined && total !== undefined && total > 0
  const ratio = known ? Math.min(1, Math.max(0, used / total)) : 0
  const warn = known && ratio >= 0.8
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={known ? 100 : undefined}
        aria-valuenow={known ? Math.round(ratio * 100) : undefined}
        style={{
          flex: 1, height: 6, borderRadius: 3, overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.18))',
        }}
      >
        <div style={{
          width: known ? `${Math.round(ratio * 100)}%` : 0,
          height: '100%', borderRadius: 3, transition: 'width 240ms ease',
          background: warn
            ? 'var(--dsw-alias-state-warn-primary, #e6a700)'
            : 'var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill, #4a6cf7))',
        }} />
      </div>
      <span style={{
        fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      }}>
        {known ? `${Math.round(ratio * 100)}%` : '--'}
      </span>
    </div>
  )
}

interface FooterProps {
  wide?: boolean
  call?: <T>(endpoint: string, payload?: unknown) => Promise<RpcResult<T>>
  t?: (key: string, params?: Record<string, string | number>) => string
}

/**
 * Sidebar footer entry next to the Settings trigger: opens the compact popup
 * (sign-in + usage card) in a modal, so the login flow is reachable without
 * hunting for the settings section first. Once signed in, the button label
 * swaps from "Sign in NewAPI" to the account display name.
 */
function NewApiFooterButton(props: FooterProps): JSX.Element | null {
  const { wide, call, t } = props
  const [open, setOpen] = useState(false)
  const [userName, setUserName] = useState<string | undefined>(undefined)
  /**
   * Initialization key-setup dialog: when the app first renders and no
   * credential is stored yet, the sign-in popup opens by itself (it jumps
   * straight into the embedded provider login). It closes automatically the
   * moment NewAPI is configured — via a login completed here, or because the
   * Host restored/installed the key on its own — so the user is never left
   * with a stale prompt.
   */
  const [initOpen, setInitOpen] = useState(false)

  /** Light identity refresh: a cached-when-possible user-only fetch. */
  const refreshUser = async (): Promise<void> => {
    if (call === undefined) return
    const result = await call<SnapshotView['user']>('user.get')
    setUserName(result.ok && result.value !== undefined
      ? ([result.value.display_name, result.value.username].find((s) => typeof s === 'string' && s !== '') ?? String(result.value.id))
      : undefined)
  }

  /** True when NewAPI has both the session and the chat API key ready. */
  const isConfigured = async (): Promise<boolean> => {
    if (call === undefined) return true
    const result = await call<ConfigView>('config.get')
    return result.ok && result.value.tokenConfigured && result.value.apiKeyConfigured
  }

  useEffect(() => {
    void (async () => {
      await refreshUser()
      if (await isConfigured()) return
      setInitOpen(true)
    })()
  }, [])

  // While the init dialog is up, watch for NewAPI becoming configured from
  // anywhere (this popup's login, another window, Host-side self-heal) and
  // close it as soon as the credential pair is complete.
  useEffect(() => {
    if (!initOpen || call === undefined) return
    const timer = setInterval(() => {
      void (async () => {
        if (await isConfigured()) setInitOpen(false)
      })()
    }, 3000)
    return () => { clearInterval(timer) }
  }, [initOpen])

  if (call === undefined || t === undefined) return null

  const close = (): void => {
    setOpen(false)
    void refreshUser()
  }
  const closeInit = (): void => {
    setInitOpen(false)
    void refreshUser()
  }

  const label = userName !== undefined ? userName : t('footerLabel')
  return (
    <Fragment>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        style={wide === false
          ? {
              boxSizing: 'border-box', cursor: 'pointer', flex: 'none',
              width: 36, height: 36, margin: '4px 0', padding: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--dsw-alias-label-primary)', background: 'transparent',
              border: 'none', borderRadius: '50%', fontFamily: 'inherit',
            }
          : {
              boxSizing: 'border-box', cursor: 'pointer', flex: 'none',
              height: 42, margin: '4px 6px 4px 0', padding: '0 10px 0 8px',
              display: 'inline-flex', alignItems: 'center', gap: 8,
              color: 'var(--dsw-alias-label-primary)', background: 'transparent',
              border: 'none', borderRadius: 12, fontFamily: 'inherit',
              fontSize: 14, lineHeight: '22px', whiteSpace: 'nowrap', overflow: 'hidden',
            }}
      >
        <IconUserOutline16 size={16} />
        {wide !== false && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>{label}</span>}
      </button>
      <Modal open={open} onClose={close} title={t('nav')} closeLabel={t('close')}>
        <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <NewApiPopup call={call} t={t} autoLogin onAuthenticated={close} />
        </div>
      </Modal>
      <Modal open={initOpen} onClose={closeInit} title={t('initTitle')} closeLabel={t('close')}>
        <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, inherit)' }}>
            {t('initHint')}
          </p>
          <NewApiPopup call={call} t={t} autoLogin onAuthenticated={closeInit} />
        </div>
      </Modal>
    </Fragment>
  )
}

/**
 * Hooks below must run unconditionally on every render (Rules of Hooks), so
 * the "not wired up yet" bail-out can't sit before them as an early return —
 * `call`/`t` fall back to harmless no-ops here and the real absence check
 * moves to just before the returned JSX, after every hook has run.
 */
const NOOP_CALL: NonNullable<SectionProps['call']> = async () =>
  ({ ok: false, error: { code: 'unavailable', message: 'newapi: RPC channel not available' } })
const NOOP_T: NonNullable<SectionProps['t']> = (key) => key

interface SessionApi {
  config: ConfigView | undefined
  configLoaded: boolean
  baseUrl: string
  setBaseUrl: (value: string) => void
  passwordLoginOn: boolean
  setPasswordLoginOn: (value: boolean) => void
  currency: Currency
  setCurrency: (value: Currency) => void
  /** Raw input string for the default context window (persisted on save). */
  defaultContextWindow: string
  setDefaultContextWindow: (value: string) => void
  server: ServerInfoView | undefined
  snapshot: SnapshotView | undefined
  configured: boolean
  busy: boolean
  syncing: boolean
  message: string | undefined
  error: string | undefined
  setBusy: (value: boolean) => void
  setError: (value: string | undefined) => void
  setMessage: (value: string | undefined) => void
  setSyncing: (value: boolean) => void
  embedded: { loginUrl: string } | undefined
  username: string
  setUsername: (value: string) => void
  password: string
  setPassword: (value: string) => void
  loadConfig: () => Promise<ConfigView | undefined>
  probeOnce: (url: string) => Promise<void>
  onProbe: () => Promise<void>
  onEmbeddedLogin: () => Promise<void>
  startEmbeddedLogin: (url: string) => Promise<void>
  onEmbeddedCancel: () => Promise<void>
  onPasswordLogin: () => Promise<void>
  onSaveSettings: () => Promise<void>
  onClear: () => Promise<void>
  onRefresh: () => Promise<void>
}

/**
 * Shared session state + actions for both surfaces (popup and settings page):
 * config load, server probe, embedded/password login lifecycle, snapshot
 * refresh. Presentational concerns stay with the callers.
 */
function useNewApiSession(
  call: NonNullable<SectionProps['call']>,
  t: NonNullable<SectionProps['t']>,
  options: { autoLogin?: boolean, onAuthenticated?: () => void } = {},
): SessionApi {
  const { autoLogin, onAuthenticated } = options

  const [config, setConfig] = useState<ConfigView | undefined>(undefined)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [passwordLoginOn, setPasswordLoginOn] = useState(false)
  const [currency, setCurrency] = useState<Currency>('cny')
  const [defaultContextWindow, setDefaultContextWindow] = useState('')
  const [server, setServer] = useState<ServerInfoView | undefined>(undefined)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [embedded, setEmbedded] = useState<{ loginUrl: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<SnapshotView | undefined>(undefined)
  const [syncing, setSyncing] = useState(false)

  const loadConfig = async (): Promise<ConfigView | undefined> => {
    const result = await call<ConfigView>('config.get')
    if (result.ok) {
      setConfig(result.value)
      setBaseUrl((current) => current === '' && result.value.baseUrl !== '' ? result.value.baseUrl : current)
      setPasswordLoginOn(result.value.passwordLogin)
      setCurrency(result.value.currency)
      if (result.value.defaultContextWindow !== undefined) {
        setDefaultContextWindow((current) => current === '' ? String(result.value.defaultContextWindow) : current)
      }
      return result.value
    }
    setError(`${t('loadFailed')} (${result.error.code}: ${result.error.message})`)
    return undefined
  }

  const applySnapshot = (value: SnapshotView): void => {
    setSnapshot(value)
    setServer(value.server)
  }

  /**
   * Load the snapshot. When the Host served a stale cache (offline server or
   * a background refresh still running), re-poll until the data turns fresh
   * or the retries run out — the extra calls join the Host-side in-flight
   * refresh, so they cost nothing extra.
   */
  const loadSnapshot = async (): Promise<void> => {
    const result = await call<SnapshotView>('snapshot.get')
    if (!result.ok) return
    applySnapshot(result.value)
    if (result.value.stale !== true) return
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 3000) })
      const next = await call<SnapshotView>('snapshot.get')
      if (!next.ok) continue
      applySnapshot(next.value)
      if (next.value.stale !== true) break
    }
  }

  /** One-shot server probe so the fixed-address setup still surfaces status. */
  const probeOnce = async (url: string): Promise<void> => {
    const result = await call<ServerStatusView>('server.status', { baseUrl: url })
    if (result.ok) setServer(result.value.info)
  }

  /** Ask the Host to begin the embedded login: it opens the provider (Feishu)
   *  authorize page in a dedicated login window and captures the session
   *  cookie automatically the moment the sign-in there succeeds. */
  const startEmbeddedLogin = async (url: string): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    const result = await call<{ loginUrl: string }>('login.native.start', { baseUrl: url })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setEmbedded(result.value)
  }

  useEffect(() => {
    void (async () => {
      const loaded = await loadConfig()
      setConfigLoaded(true)
      if (loaded !== undefined && loaded.baseUrl !== '') await probeOnce(loaded.baseUrl)
      await loadSnapshot()
      // Footer entry + not signed in + a usable address: open the provider
      // authorize page immediately — no config form in between.
      if (autoLogin === true && loaded !== undefined && !loaded.tokenConfigured && loaded.baseUrl !== '') {
        await startEmbeddedLogin(loaded.baseUrl)
      }
    })()
  }, [])

  // Poll the Host while an embedded login is in flight: the user signs in on
  // the server's own page in the dedicated login window, and the Host reports
  // the moment its cookie watch captures and verifies the session. Terminal
  // results stay observable until we ack with `login.native.cancel`; the
  // branches below ack on completion, and the unmount effect acks when the
  // section goes away mid-login (modal closed), which stops the Host watch
  // and closes its login window.
  const embeddedRef = useRef<{ loginUrl: string } | undefined>(undefined)
  useEffect(() => { embeddedRef.current = embedded }, [embedded])
  useEffect(() => () => {
    if (embeddedRef.current !== undefined) void call('login.native.cancel')
  }, [])

  useEffect(() => {
    if (embedded === undefined) return
    let alive = true
    const timer = setInterval(() => {
      void (async () => {
        const result = await call<{ status: string, error?: string, user?: { username?: string, display_name?: string } }>('login.native.status')
        if (!alive || !result.ok) return
        if (result.value.status === 'ok') {
          alive = false
          clearInterval(timer)
          setEmbedded(undefined)
          embeddedRef.current = undefined
          setMessage(t('loginOk', { user: result.value.user?.display_name ?? result.value.user?.username ?? '?' }))
          await loadConfig()
          await loadSnapshot()
          await call('login.native.cancel')
          onAuthenticated?.()
        } else if (result.value.status === 'error') {
          alive = false
          clearInterval(timer)
          setEmbedded(undefined)
          embeddedRef.current = undefined
          const raw = result.value.error ?? ''
          setError(raw !== '' && raw !== 'canceled' ? raw : t('embeddedFailed'))
          await call('login.native.cancel')
        }
      })()
    }, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [embedded])

  const configured = config !== undefined && config.baseUrl !== '' && config.tokenConfigured

  const onProbe = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    const result = await call<ServerStatusView>('server.status', { baseUrl })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setServer(result.value.info)
    if (result.value.baseUrl !== '' && baseUrl === '') setBaseUrl(result.value.baseUrl)
    setMessage(t('probed', { name: result.value.info.systemName, version: result.value.info.version }))
  }

  const onEmbeddedLogin = async (): Promise<void> => startEmbeddedLogin(baseUrl)

  const onEmbeddedCancel = async (): Promise<void> => {
    setEmbedded(undefined)
    embeddedRef.current = undefined
    await call('login.native.cancel')
  }

  const onPasswordLogin = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    const result = await call<{ authKind: string, user: { username?: string, display_name?: string } }>('login.password', { baseUrl, username, password })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setPassword('')
    setMessage(t('loginOk', { user: result.value.user.display_name ?? result.value.user.username ?? '?' }))
    await loadConfig()
    await loadSnapshot()
    onAuthenticated?.()
  }

  /** Persist the settings form (address override + password-login switch). */
  const onSaveSettings = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    const trimmed = baseUrl.trim()
    const parsedWindow = Number.parseInt(defaultContextWindow.trim() === '' ? '0' : defaultContextWindow.trim(), 10)
    const payload: Record<string, unknown> = { baseUrl: trimmed, passwordLogin: passwordLoginOn, currency }
    if (Number.isFinite(parsedWindow) && parsedWindow >= 0) payload.defaultContextWindow = parsedWindow
    const result = await call<ConfigView & { currency?: Currency }>('config.set', payload)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setConfig(result.value)
    if (result.value.currency === 'cny' || result.value.currency === 'usd') setCurrency(result.value.currency)
    if (result.value.defaultContextWindow !== undefined) setDefaultContextWindow(String(result.value.defaultContextWindow))
    setMessage(t('settingsSaved'))
    if (result.value.baseUrl !== '') await probeOnce(result.value.baseUrl)
  }

  const onClear = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    await call('config.clear')
    setBusy(false)
    setSnapshot(undefined)
    setServer(undefined)
    setMessage(t('cleared'))
    await loadConfig()
  }

  const onRefresh = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const result = await call<SnapshotView>('snapshot.get', { force: true })
    setBusy(false)
    // Offline: the Host falls back to the stale cache instead of failing, so
    // the surface keeps showing the last known data (flagged stale).
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    applySnapshot(result.value)
    if (result.value.stale === true) setError(t('staleCache', { time: formatCachedAt(result.value.cachedAt) }))
  }

  return {
    config, configLoaded, baseUrl, setBaseUrl, passwordLoginOn, setPasswordLoginOn,
    currency, setCurrency, defaultContextWindow, setDefaultContextWindow, server, snapshot, configured, busy, syncing, message, error,
    setBusy, setError, setMessage, setSyncing,
    embedded, username, setUsername, password, setPassword,
    loadConfig, probeOnce, onProbe, onEmbeddedLogin, startEmbeddedLogin, onEmbeddedCancel,
    onPasswordLogin, onSaveSettings, onClear, onRefresh,
  }
}

/** Shared inline status strip: one-line error/message feedback above the card stack. */
function StatusStrip(props: { error: string | undefined, message: string | undefined, t: NonNullable<SectionProps['t']> }): JSX.Element | null {
  const { error, message, t } = props
  if (error === undefined && message === undefined) return null
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4, margin: 0,
      fontSize: 13, lineHeight: '20px',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
      borderRadius: 10, padding: '8px 12px',
    }}>
      {error !== undefined && (
        <span role="alert" style={{ color: 'var(--dsw-alias-state-error-primary, #d33)' }}>
          {t('failure')}: {error}
        </span>
      )}
      {message !== undefined && (
        <span style={{ color: 'var(--dsw-alias-state-success-primary, #3a3)' }}>{message}</span>
      )}
    </div>
  )
}

/**
 * Compact popup surface: flat, card-based. When signed out it is a pure
 * sign-in surface (SSO-first, password when enabled); when signed in it
 * shows the account summary, a quota usage progress bar, and per-token
 * usage bars. Full management stays on the settings page.
 */
function NewApiPopup(props: SectionProps): JSX.Element | null {
  const { autoLogin, onAuthenticated } = props
  const call = props.call ?? NOOP_CALL
  const t = props.t ?? NOOP_T
  const session = useNewApiSession(call, t, { autoLogin, onAuthenticated })
  const {
    config, configLoaded, baseUrl, server, snapshot, configured, busy,
    message, error, embedded, username, setUsername, password, setPassword,
    passwordLoginOn, currency, loadConfig, onEmbeddedLogin, startEmbeddedLogin,
    onEmbeddedCancel, onPasswordLogin, onClear, onRefresh,
  } = session

  const exchangeRate = snapshot?.server.usdExchangeRate ?? 0
  const oauthProviders = server?.oauthProviders ?? []
  /** Provider shown on the primary button: Feishu when offered, else generic. */
  const feishuName = oauthProviders.find((provider) => provider.slug === 'feishu')?.name
    ?? (oauthProviders[0] !== undefined ? oauthProviders[0].name : '')
  const providerLabel = feishuName !== '' ? feishuName : 'NewAPI'

  if (props.call === undefined || props.t === undefined) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 380, maxWidth: '100%' }}>
      <StatusStrip error={error} message={message} t={t} />

      {config === undefined
        ? (
            <section style={{ ...cardStyle, alignItems: 'center', padding: '32px 16px', gap: 8 }}>
              <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' }}>
                {configLoaded ? t('loadFailed') : t('loading')}
              </span>
              {configLoaded && <Button size="sm" disabled={busy} onClick={() => void loadConfig()}>{t('refresh')}</Button>}
            </section>
          )
        : embedded !== undefined
          ? (
              <section style={cardStyle}>
                <h4 style={cardTitleStyle}>{t('login')}</h4>
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 12, padding: '28px 16px', borderRadius: 10,
                  border: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
                  background: 'var(--dsw-alias-bg-layer-1, transparent)', textAlign: 'center',
                }}>
                  <span
                    aria-hidden
                    style={{
                      width: 22, height: 22, borderRadius: '50%',
                      border: '2px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.4))',
                      borderTopColor: 'var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill, #4a6cf7))',
                      animation: 'dsh-newapi-spin 900ms linear infinite',
                    }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{t('embeddedWindowHint', { provider: providerLabel })}</span>
                  <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: '18px' }}>
                    {t('embeddedWaiting', { provider: providerLabel })}
                  </span>
                  <Button size="sm" disabled={busy} onClick={() => void startEmbeddedLogin(baseUrl)}>
                    {t('embeddedReopen')}
                  </Button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Button size="sm" onClick={() => void onEmbeddedCancel()}>{t('embeddedCancel')}</Button>
                  <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' }}>{t('embeddedCaptureNote')}</span>
                </div>
              </section>
            )
          : !configured
            ? (
              <section style={cardStyle}>
                <h4 style={cardTitleStyle}>{t('login')}</h4>
                <Button
                  variant="primary"
                  disabled={busy || baseUrl.trim() === ''}
                  onClick={() => void onEmbeddedLogin()}
                  style={{ justifyContent: 'center' }}
                >
                  {t('ssoButton', { provider: providerLabel })}
                </Button>
                {passwordLoginOn && server?.passwordLogin === true && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' }}>{t('loginPassword')}</span>
                    <Input
                      value={username}
                      placeholder={t('username')}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Input
                      value={password}
                      type="password"
                      placeholder={t('password')}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
                      autoComplete="off"
                    />
                    <Button
                      size="sm"
                      disabled={busy || baseUrl.trim() === '' || username.trim() === '' || password === ''}
                      onClick={() => void onPasswordLogin()}
                    >
                      {busy ? t('loggingIn') : t('loginButton')}
                    </Button>
                  </div>
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' }}>
                  <StateDot state="warning" />
                  {t('notConfigured')}
                </span>
              </section>
            )
            : (
              <>
                {/* Cached-data notice while offline / background refresh */}
                <StaleNote snapshot={snapshot} t={t} />

                {/* Account summary */}
                <section style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                      width: 34, height: 34, borderRadius: '50%', flex: 'none',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      background: 'var(--dsw-alias-button-primary-fill, #4a6cf7)',
                      color: 'var(--dsw-alias-label-primary-foreground, #fff)',
                    }}>
                      <IconUserOutline16 size={16} />
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {snapshot?.user?.display_name ?? snapshot?.user?.username ?? String(snapshot?.user?.id ?? '--')}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {snapshot?.user?.email ?? ''}
                      </span>
                    </div>
                    {snapshot?.user?.group !== undefined && snapshot.user.group !== '' && <Pill>{snapshot.user.group}</Pill>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <StateDot state="done" />
                      {t('popupSignedInAs')}
                    </span>
                    {snapshot?.user?.request_count !== undefined && (
                      <span>{t('popupRequests', { count: snapshot.user.request_count })}</span>
                    )}
                  </div>
                </section>

                {/* Plan usage with progress bar */}
                <section style={cardStyle}>
                  <h4 style={cardTitleStyle}>{t('popupUsageTitle')}</h4>
                  <UsageBar used={snapshot?.usage.quotaUsed} total={snapshot?.usage.quotaTotal} />
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' }}>
                    <span>{t('quotaUsed')}: <b style={{ fontVariantNumeric: 'tabular-nums' }}>{money(snapshot?.usage.quotaUsed, currency, exchangeRate)}</b></span>
                    <span>{t('quotaRemaining')}: <b style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {snapshot?.usage.unlimited === true ? t('unlimited') : money(snapshot?.usage.quotaRemaining, currency, exchangeRate)}
                    </b></span>
                  </div>
                </section>

                {/* Per-token usage as plain rows — no progress bars here. */}
                {snapshot !== undefined && snapshot.tokens.length > 0 && (
                  <section style={cardStyle}>
                    <h4 style={cardTitleStyle}>{t('popupTokenUsage')}</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {snapshot.tokens.map((row) => (
                        <div key={row.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {row.name ?? String(row.id)}
                          </span>
                          <span style={{ flex: 1, minWidth: 12, borderBottom: '1px dotted var(--dsw-alias-border-l2, rgba(128,128,128,0.35))' }} />
                          <span style={{ flex: 'none', color: 'var(--dsw-alias-label-tertiary, inherit)' }}>
                            {t('tokenQuota')}: {formatQuota(row.quota, snapshot.server.quotaPerUnit, currency, exchangeRate)}
                          </span>
                          <span style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
                            {t('quotaUsed')}: {formatQuota(row.used_quota, snapshot.server.quotaPerUnit, currency, exchangeRate)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                  <Button size="sm" disabled={busy} onClick={() => void onRefresh()}>{t('refresh')}</Button>
                  <Button size="sm" disabled={busy} onClick={() => void onClear()}>{t('clear')}</Button>
                </div>
              </>
            )}
    </div>
  )
}

/**
 * Full settings page: server config form, account details, API key table,
 * model catalog with per-model limits, and model sync — everything the
 * popup deliberately omits.
 */
function NewApiSettings(props: SectionProps): JSX.Element | null {
  const call = props.call ?? NOOP_CALL
  const t = props.t ?? NOOP_T
  const session = useNewApiSession(call, t)
  const {
    config, configLoaded, baseUrl, setBaseUrl, passwordLoginOn, setPasswordLoginOn,
    currency, setCurrency, defaultContextWindow, setDefaultContextWindow,
    server, snapshot, configured, busy, syncing, message, error,
    setBusy, setError, setMessage, setSyncing,
    username, setUsername, password, setPassword, embedded, loadConfig,
    onProbe, onEmbeddedLogin, startEmbeddedLogin, onEmbeddedCancel, onPasswordLogin,
    onSaveSettings, onClear, onRefresh,
  } = session

  const [syncLimit, setSyncLimit] = useState('')
  /** Inline per-model limit editor ({ id } plus raw input strings). */
  const [editing, setEditing] = useState<{ id: string, contextWindow: string, maxTokens: string } | undefined>(undefined)
  const limits = config?.modelLimits ?? {}
  /** Full keys revealed on demand, keyed by token id. */
  const [revealed, setRevealed] = useState<Record<number, string>>({})
  /** A freshly created key, shown once with a copy affordance. */
  const [createdKey, setCreatedKey] = useState<{ name: string, key: string } | undefined>(undefined)

  const onSaveLimit = async (): Promise<void> => {
    if (editing === undefined) return
    const parse = (raw: string): number => {
      const n = Number.parseInt(raw, 10)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    setBusy(true)
    setError(undefined)
    const result = await call<{ id: string }>('models.setLimit', {
      id: editing.id,
      contextWindow: parse(editing.contextWindow),
      maxTokens: parse(editing.maxTokens),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setMessage(t('limitSaved', { model: editing.id }))
    setEditing(undefined)
    await loadConfig()
  }

  const onRevealKey = async (id: number): Promise<void> => {
    if (revealed[id] !== undefined) return
    const result = await call<{ id: number, key: string }>('tokens.revealKey', { id })
    if (result.ok && result.value.key !== '') setRevealed((prev) => ({ ...prev, [id]: result.value.key }))
    else if (!result.ok) setError(result.error.message)
  }

  const onCreateToken = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    const result = await call<{ id: number, name: string, key: string }>('tokens.create', {})
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setCreatedKey({ name: result.value.name, key: result.value.key })
    const refreshed = await call<SnapshotView>('snapshot.get', { force: true })
    if (refreshed.ok) applySnapshot(refreshed.value)
  }

  const onCopyKey = async (key: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(key)
      setMessage(t('keyCopied'))
    } catch {
      setError(t('keyCopyFailed'))
    }
  }

  const onSync = async (): Promise<void> => {
    if (!configured) {
      setError(t('syncNeedsConfig'))
      return
    }
    setSyncing(true)
    setError(undefined)
    setMessage(undefined)
    const limit = Number.parseInt(syncLimit, 10)
    const payload = Number.isFinite(limit) && limit > 0 ? { limit } : {}
    const result = await call<{ route: string, count: number, baseURL: string }>('models.sync', payload)
    setSyncing(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setMessage(t('synced', { count: result.value.count, route: result.value.route }))
  }

  const models = useMemo(() => snapshot?.models ?? [], [snapshot])
  const exchangeRate = snapshot?.server.usdExchangeRate ?? 0
  const oauthProviders = server?.oauthProviders ?? []
  /** Provider shown on the primary button: Feishu when offered, else generic. */
  const feishuName = oauthProviders.find((provider) => provider.slug === 'feishu')?.name
    ?? (oauthProviders[0] !== undefined ? oauthProviders[0].name : '')
  const providerLabel = feishuName !== '' ? feishuName : 'NewAPI'

  if (props.call === undefined || props.t === undefined) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('intro')}</p>

      <StatusStrip error={error} message={message} t={t} />

      {/* Server configuration — settings page only. */}
      {config === undefined
        ? (
            <section style={{ ...cardStyle, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' }}>
                {configLoaded ? t('loadFailed') : t('loading')}
              </span>
              {configLoaded && <Button size="sm" disabled={busy} onClick={() => void loadConfig()}>{t('refresh')}</Button>}
            </section>
          )
        : (
            <section style={cardStyle}>
              <h4 style={cardTitleStyle}>{t('baseUrl')}</h4>
              <Input
                value={baseUrl}
                placeholder={config.baseUrlDefault !== '' ? config.baseUrlDefault : t('baseUrlPlaceholder')}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setBaseUrl(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              {config.baseUrlDefault !== '' && (
                <p style={{ margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, inherit)' }}>
                  {t('defaultServer', { url: config.baseUrlDefault })}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button size="sm" disabled={busy || baseUrl.trim() === ''} onClick={() => void onProbe()}>
                  {busy ? t('probing') : t('probe')}
                </Button>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={passwordLoginOn}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setPasswordLoginOn(event.target.checked)}
                  />
                  <span>{t('enablePasswordLogin')}</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <span>{t('currencyLabel')}</span>
                  <select
                    value={currency}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                      const next = event.target.value
                      setCurrency(next === 'usd' ? 'usd' : 'cny')
                    }}
                    style={{ fontFamily: 'inherit', fontSize: 13 }}
                  >
                    <option value="cny">{t('currencyCny')}</option>
                    <option value="usd">{t('currencyUsd')}</option>
                  </select>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <span>{t('defaultContextWindowLabel')}</span>
                  <Input
                    value={defaultContextWindow}
                    placeholder="180000"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setDefaultContextWindow(event.target.value)}
                    style={{ width: 110 }}
                    inputMode="numeric"
                    spellCheck={false}
                  />
                </label>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' }}>{t('defaultContextWindowHint')}</span>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void onSaveSettings()}>
                  {t('saveSettings')}
                </Button>
              </div>
              {server !== undefined && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13 }}>
                  <StateDot state="done" />
                  <span>{server.systemName} {server.version !== '' ? `(${server.version})` : ''}</span>
                  {oauthProviders.map((provider) => <Pill key={provider.slug}>{provider.name}</Pill>)}
                </span>
              )}
            </section>
          )}

      {/* Sign-in */}
      <section style={cardStyle}>
        <h4 style={cardTitleStyle}>{t('login')}</h4>
        {embedded !== undefined
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, inherit)' }}>
                {t('embeddedWaiting', { provider: providerLabel })}
              </p>
              <div
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 12, padding: '32px 16px', borderRadius: 10,
                  border: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
                  background: 'var(--dsw-alias-bg-layer-1, transparent)', textAlign: 'center',
                }}
              >
                <span style={{ fontSize: 14 }}>{t('embeddedWindowHint', { provider: providerLabel })}</span>
                <Button size="sm" disabled={busy} onClick={() => void startEmbeddedLogin(baseUrl)}>
                  {busy ? t('probing') : t('embeddedReopen')}
                </Button>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                <Button size="sm" onClick={() => void onEmbeddedCancel()}>{t('embeddedCancel')}</Button>
                <span style={{ color: 'var(--dsw-alias-label-tertiary, inherit)' }}>{t('embeddedCaptureNote')}</span>
              </div>
            </div>
          )
          : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button variant="primary" size="sm" disabled={busy || baseUrl.trim() === ''} onClick={() => void onEmbeddedLogin()}>
                  {t('ssoButton', { provider: providerLabel })}
                </Button>
                {config !== undefined && (
                  <Button size="sm" disabled={busy} onClick={() => void onClear()}>{t('clear')}</Button>
                )}
                {config !== undefined && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <StateDot state={configured ? 'done' : 'warning'} />
                    {configured ? t('saved') : t('notConfigured')}
                  </span>
                )}
              </div>
              {passwordLoginOn && server?.passwordLogin === true && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Input
                    value={username}
                    placeholder={t('username')}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ width: 160 }}
                  />
                  <Input
                    value={password}
                    type="password"
                    placeholder={t('password')}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
                    autoComplete="off"
                    style={{ width: 160 }}
                  />
                  <Button size="sm" disabled={busy || baseUrl.trim() === '' || username.trim() === '' || password === ''} onClick={() => void onPasswordLogin()}>
                    {busy ? t('loggingIn') : t('loginButton')}
                  </Button>
                </div>
              )}
            </>
          )}
      </section>

      {snapshot !== undefined && (
        <>
          <StaleNote snapshot={snapshot} t={t} />

          {/* Account details + plan usage bar */}
          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h4 style={{ ...cardTitleStyle, flex: 1 }}>{t('account')}</h4>
              <Button size="sm" disabled={busy} onClick={() => void onRefresh()}>{t('refresh')}</Button>
            </div>
            <UsageBar used={snapshot.usage.quotaUsed} total={snapshot.usage.quotaTotal} />
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 13 }}>
              <dt style={{ color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('usernameLabel')}</dt>
              <dd style={{ margin: 0 }}>
                {snapshot.user?.display_name ?? snapshot.user?.username ?? String(snapshot.user?.id ?? '--')}
                {snapshot.user?.email !== undefined && snapshot.user.email !== '' ? ` <${snapshot.user.email}>` : ''}
              </dd>
              <dt style={{ color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('group')}</dt>
              <dd style={{ margin: 0 }}>{snapshot.user?.group ?? '--'}</dd>
              <dt style={{ color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('requests')}</dt>
              <dd style={{ margin: 0 }}>{snapshot.user?.request_count ?? '--'}</dd>
              <dt style={{ color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('quotaUsed')}</dt>
              <dd style={{ margin: 0 }}>{money(snapshot.usage.quotaUsed, currency, exchangeRate)}</dd>
              <dt style={{ color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('quotaRemaining')}</dt>
              <dd style={{ margin: 0 }}>
                {snapshot.usage.unlimited === true ? t('unlimited') : money(snapshot.usage.quotaRemaining, currency, exchangeRate)}
              </dd>
              <dt style={{ color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('quotaTotal')}</dt>
              <dd style={{ margin: 0 }}>
                {snapshot.usage.unlimited === true ? t('unlimited') : money(snapshot.usage.quotaTotal, currency, exchangeRate)}
              </dd>
            </dl>
          </section>

          {/* API keys */}
          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h4 style={{ ...cardTitleStyle, flex: 1 }}>{t('tokens')}</h4>
              <Button size="sm" disabled={busy} onClick={() => void onCreateToken()}>{t('createToken')}</Button>
            </div>
            {createdKey !== undefined && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, padding: '6px 10px', border: '1px dashed var(--dsw-alias-label-tertiary, #888)', borderRadius: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('keyCreatedOnce', { name: createdKey.name })}</span>
                <code style={{ fontFamily: 'monospace', fontSize: 13 }}>{createdKey.key}</code>
                <Button size="sm" onClick={() => void onCopyKey(createdKey.key)}>{t('copyKey')}</Button>
              </div>
            )}
            {snapshot.tokens.length === 0
              ? <p style={{ margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' }}>{t('noTokensHint')}</p>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--dsw-alias-label-tertiary, inherit)' }}>
                        <th style={{ padding: '4px 12px 4px 0' }}>{t('tokenName')}</th>
                        <th style={{ padding: 4 }}>{t('tokenKey')}</th>
                        <th style={{ padding: 4 }}>{t('tokenQuota')}</th>
                        <th style={{ padding: 4 }}>{t('tokenUsed')}</th>
                        <th style={{ padding: 4 }}>{t('tokenExpires')}</th>
                        <th style={{ padding: 4 }}>{t('tokenModels')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.tokens.map((row) => (
                        <tr key={row.id}>
                          <td style={{ padding: '4px 12px 4px 0' }}>{row.name ?? String(row.id)}</td>
                          <td style={{ padding: 4 }}>
                            {revealed[row.id] !== undefined
                              ? (
                                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                    <code style={{ fontFamily: 'monospace' }}>{revealed[row.id]}</code>
                                    <Button size="sm" onClick={() => void onCopyKey(revealed[row.id])}>{t('copyKey')}</Button>
                                  </span>
                                )
                              : (
                                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                    <code style={{ fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary, inherit)' }}>••••{row.key !== undefined ? row.key.slice(-4) : '????'}</code>
                                    <Button size="sm" disabled={busy} onClick={() => void onRevealKey(row.id)}>{t('revealKey')}</Button>
                                  </span>
                                )}
                          </td>
                          <td style={{ padding: 4 }}>{formatQuota(row.quota, snapshot.server.quotaPerUnit, currency, exchangeRate)}</td>
                          <td style={{ padding: 4 }}>{formatQuota(row.used_quota, snapshot.server.quotaPerUnit, currency, exchangeRate)}</td>
                          <td style={{ padding: 4 }}>{formatDate(row.expired_time)}</td>
                          <td style={{ padding: 4 }}>
                            {row.models === undefined || row.models === '' || row.models === '-1' || row.models === '*' ? t('tokenAllModels') : row.models}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                )}
          </section>

          {/* Model catalog + sync */}
          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h4 style={{ ...cardTitleStyle, flex: 1 }}>{t('models')}</h4>
              <Pill>{t('modelsCount', { count: models.length })}</Pill>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--dsw-alias-label-tertiary, inherit)' }}>
                    <th style={{ padding: '4px 12px 4px 0' }}>{t('modelId')}</th>
                    <th style={{ padding: 4 }}>{t('modelInput')}</th>
                    <th style={{ padding: 4 }}>{t('modelOutput')}</th>
                    <th style={{ padding: 4 }}>{t('modelLimits')}</th>
                    <th style={{ padding: 4 }} />
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => {
                    const storedLimit = limits[model.id]
                    const editingThis = editing?.id === model.id
                    return (
                      <tr key={model.id}>
                        <td style={{ padding: '4px 12px 4px 0', fontFamily: 'monospace' }}>{model.id}</td>
                        <td style={{ padding: 4 }}>{model.priced === true ? formatPrice(model.inputPrice, currency, exchangeRate) : '--'}</td>
                        <td style={{ padding: 4 }}>{model.priced === true ? formatPrice(model.outputPrice, currency, exchangeRate) : '--'}</td>
                        <td style={{ padding: '4px 8px 4px 4px', whiteSpace: 'nowrap' }}>
                          {editingThis && editing !== undefined
                            ? (
                                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                  <Input
                                    value={editing.contextWindow}
                                    placeholder={t('contextWindow')}
                                    title={t('contextWindow')}
                                    onChange={(event: ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, contextWindow: event.target.value })}
                                    style={{ width: 96 }}
                                    inputMode="numeric"
                                    spellCheck={false}
                                  />
                                  <span style={{ color: 'var(--dsw-alias-label-tertiary, inherit)' }}>/</span>
                                  <Input
                                    value={editing.maxTokens}
                                    placeholder={t('maxOutputTokens')}
                                    title={t('maxOutputTokens')}
                                    onChange={(event: ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, maxTokens: event.target.value })}
                                    style={{ width: 96 }}
                                    inputMode="numeric"
                                    spellCheck={false}
                                  />
                                </span>
                              )
                            : storedLimit === undefined
                              ? (
                                  <span
                                    style={{ color: 'var(--dsw-alias-label-tertiary, inherit)', cursor: 'pointer', borderBottom: '1px dashed var(--dsw-alias-label-tertiary, rgba(128,128,128,0.5))' }}
                                    onClick={() => {
                                      setEditing({
                                        id: model.id,
                                        contextWindow: String(config?.defaultContextWindow ?? 180000),
                                        maxTokens: '',
                                      })
                                    }}
                                  >
                                    {t('defaultLimitDisplay', { window: String(config?.defaultContextWindow ?? 180000) })}
                                  </span>
                                )
                              : `${storedLimit.contextWindow !== undefined ? String(storedLimit.contextWindow) : '?'} / ${storedLimit.maxTokens !== undefined ? String(storedLimit.maxTokens) : '?'}`}
                        </td>
                        <td style={{ padding: 4, whiteSpace: 'nowrap' }}>
                          {editingThis
                            ? (
                                <span style={{ display: 'inline-flex', gap: 6 }}>
                                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void onSaveLimit()}>{t('saveLimit')}</Button>
                                  <Button size="sm" disabled={busy} onClick={() => setEditing(undefined)}>{t('cancelLimit')}</Button>
                                </span>
                              )
                            : (
                                <Button size="sm" disabled={busy} onClick={() => {
                                  setEditing({
                                    id: model.id,
                                    contextWindow: storedLimit?.contextWindow !== undefined ? String(storedLimit.contextWindow) : '',
                                    maxTokens: storedLimit?.maxTokens !== undefined ? String(storedLimit.maxTokens) : '',
                                  })
                                }}>{t('editLimit')}</Button>
                              )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button variant="primary" size="sm" disabled={syncing || models.length === 0} onClick={() => void onSync()}>
                {syncing ? t('syncing') : t('sync')}
              </Button>
              <Input
                value={syncLimit}
                placeholder={t('syncLimit')}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSyncLimit(event.target.value)}
                style={{ width: 140 }}
                inputMode="numeric"
              />
            </div>
          </section>
        </>
      )}
    </div>
  )
}
