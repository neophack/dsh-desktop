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
 * Both talk to the Host half through the trusted-host-fenced `/newapi` Connection
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
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
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
  /** Per-model capability limits (tokens) and the image-input opt-out, persisted host-side. */
  modelLimits: Record<string, { contextWindow?: number, maxTokens?: number, image?: boolean }>
  /** Context window (tokens) applied to every model without explicit limits; 0 = none. */
  defaultContextWindow: number
  authKind: string
  /** Masked head+tail of the cached system access token (token auth only). */
  accessTokenMasked?: string
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

/** Stale-serve count before the "showing cached data" notice appears. */
const STALE_ATTEMPTS_BEFORE_NOTICE = 3

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

/**
 * Offline / background-refresh notice shown above data served from cache.
 * Hidden until the connection has actually been retried and failed a few
 * times, so a slow first connect doesn't flash "cached data" on open.
 */
function StaleNote(props: { snapshot: SnapshotView | undefined, confirmed: boolean, t: NonNullable<SectionProps['t']> }): JSX.Element | null {
  if (props.snapshot?.stale !== true || !props.confirmed) return null
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

const SETTINGS_STYLE_TAG = 'dsh-plugin-newapi/settings-styles'

/**
 * Settings-page stylesheet, mirroring the desktop settings section design
 * (dsh-plugin-desktop's `dshDesktopSettings*` classes): an 880px column of
 * groups separated by hairline rules, h3 + intro headers, 10px toggle rows,
 * pill buttons, and Notice/Error/Success strips — so the NewAPI page reads
 * as a native member of the same Settings shell. Self-hosted (rather than
 * reusing those class names) because the desktop plugin is a separate
 * package that this plugin must not depend on.
 */
const SETTINGS_CSS = `
.dshNewApiSettings {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: min(100%, 880px);
  padding: 2px 0 36px;
  color: var(--dsw-alias-label-primary);
}
.dshNewApiSettingsHeader h2,
.dshNewApiSettingsGroup h3 { margin: 0; font-weight: 600; }
.dshNewApiSettingsHeader h2 { font-size: 22px; line-height: 1.35; letter-spacing: -0.015em; }
.dshNewApiSettingsGroup h3 { font-size: 15px; line-height: 1.4; letter-spacing: -0.01em; }
.dshNewApiSettingsHeader p,
.dshNewApiSettingsIntro,
.dshNewApiSettingsHint {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.dshNewApiSettingsGroup {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshNewApiSettingsForm {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
/* Flat card that groups every field persisted by one "Save settings" press,
   so the save scope is visually unambiguous. */
.dshNewApiSettingsCard {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshNewApiSettingsRow2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.dshNewApiSettingsCardFooter {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 12px;
  border-top: 1px dashed var(--dsw-alias-border-l1);
}
.dshNewApiSettingsSave {
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
.dshNewApiSettingsSave:hover:not(:disabled) { filter: brightness(1.06); }
.dshNewApiSettingsSave:disabled { cursor: default; opacity: .55; }
.dshNewApiSettingsField {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dshNewApiSettingsFieldNarrow { flex: 0 0 auto; }
.dshNewApiSettingsInput {
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
.dshNewApiSettingsInput:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
}
.dshNewApiSettingsActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dshNewApiSettingsButton {
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
.dshNewApiSettingsButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshNewApiSettingsButton:disabled { cursor: default; opacity: .55; }
.dshNewApiSettingsButtonSecondary { color: var(--dsw-alias-label-secondary); }
.dshNewApiSettingsNotice,
.dshNewApiSettingsError,
.dshNewApiSettingsSuccess {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.55;
}
.dshNewApiSettingsNotice { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dshNewApiSettingsError { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dshNewApiSettingsSuccess { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.dshNewApiSettingsToggleRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
  padding: 13px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 13px;
}
.dshNewApiSettingsToggle {
  flex: 0 0 auto;
  position: relative;
  width: 40px;
  height: 22px;
  padding: 2px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2);
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.dshNewApiSettingsToggle[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.dshNewApiSettingsToggle:disabled { cursor: default; opacity: .5; }
.dshNewApiSettingsToggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dshNewApiSettingsToggleKnob {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .24);
  transform: translateX(0);
  transition: transform var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.dshNewApiSettingsToggle[aria-checked="true"] .dshNewApiSettingsToggleKnob { transform: translateX(18px); }
.dshNewApiSettingsDl {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 20px;
  font-size: 13px;
}
.dshNewApiSettingsDl dt { color: var(--dsw-alias-label-secondary); }
.dshNewApiSettingsDl dd { margin: 0; font-variant-numeric: tabular-nums; }
.dshNewApiUsage {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dshNewApiUsageTrack {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  /* Unused portion reads as Apple systemGray fill; layer-2 wins when defined. */
  background: var(--dsw-alias-bg-layer-2, rgba(120, 120, 128, 0.16));
  box-shadow: inset 0 0 0 0.5px rgba(120, 120, 128, 0.2);
}
.dshNewApiUsageFill {
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill));
  transition: width 320ms cubic-bezier(0.22, 1, 0.36, 1), background-color 320ms ease;
}
.dshNewApiUsageFill[data-warn="true"] { background: var(--dsw-alias-state-warn-primary, #e6a700); }
.dshNewApiUsagePercent {
  flex: 0 0 auto;
  min-width: 42px;
  text-align: right;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.dshNewApiSettingsTableWrap { overflow-x: auto; }
.dshNewApiSettingsTable { border-collapse: collapse; font-size: 13px; }
.dshNewApiSettingsTable th,
.dshNewApiSettingsTable td { padding: 8px 16px 8px 0; text-align: left; }
.dshNewApiSettingsTable td { font-variant-numeric: tabular-nums; }
.dshNewApiSettingsTable th {
  padding-top: 0;
  padding-bottom: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshNewApiSettingsTable tbody tr + tr td { border-top: 1px solid var(--dsw-alias-border-l1); }
.dshNewApiSettingsTable tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.dshNewApiSettingsStatus { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.dshNewApiSettingsKeyOnce {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.dshNewApiSettingsKeyOnce code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; color: var(--dsw-alias-label-primary); }
@media (max-width: 720px) {
  .dshNewApiSettingsForm { align-items: stretch; flex-direction: column; }
  .dshNewApiSettingsRow2 { grid-template-columns: 1fr; }
  .dshNewApiSettingsToggleRow { align-items: flex-start; }
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

export function apply(ctx: ClientCtx): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'newapi: copy dictionaries')
  ctx.effect(injectFooterRowStyle, 'newapi: sidebar footer row layout')
  ctx.effect(injectSettingsStyle, 'newapi: settings page styles')
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
  defaultContextWindowHint: '所有未单独设置的模型默认 131072 (128k) tokens; 填 0 关闭, 保存后需重新同步模型生效。',
  saveSettings: '保存设置',
  saveScopeHint: '「保存设置」会一并应用本卡片内的全部字段: 服务器地址、币种、默认上下文与登录方式。',
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
  accessTokenLabel: '访问令牌',
  accessTokenHint: '已缓存于本机, 仅显示首尾; 重新登录时自动复用, 失效才重新生成。',
  email: '邮箱',
  group: '分组',
  requests: '请求数',
  quotaUsed: '已用',
  quotaRemaining: '剩余',
  quotaTotal: '总量',
  unlimited: '不限量',
  quotaLow: '用量已超过 80%, 请注意剩余额度。',
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
  modelImage: '支持图片',
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
  defaultContextWindowHint: 'Every model without explicit limits defaults to 131072 (128k) tokens; 0 disables. Save, then re-sync models to apply.',
  saveSettings: 'Save settings',
  saveScopeHint: '"Save settings" applies every field in this card at once: server URL, currency, default context, and sign-in mode.',
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
  accessTokenLabel: 'Access token',
  accessTokenHint: 'Cached locally, shown masked; reused on re-login, regenerated only when it stops working.',
  email: 'Email',
  group: 'Group',
  requests: 'Requests',
  quotaUsed: 'Used',
  quotaRemaining: 'Remaining',
  quotaTotal: 'Total',
  unlimited: 'Unlimited',
  quotaLow: 'Over 80% of the plan quota is used — watch the remaining balance.',
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
  modelImage: 'Image input',
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
 * Usage progress bar, Claude/Codex-style: a quiet 8px pill track on layer-2
 * with a flat brand fill and the percent set apart on the right in tabular
 * numerals — the bar itself stays a pure slab, no stripes or gradients. Used
 * ratio is clamped to [0, 1]; the fill switches to the warn color past 80%,
 * and a `warnLabel` adds the same warning in words under the bar.
 */
function UsageBar(props: { used: number | undefined, total: number | undefined, warnLabel?: string }): JSX.Element {
  const { used, total, warnLabel } = props
  const known = used !== undefined && total !== undefined && total > 0
  const ratio = known ? Math.min(1, Math.max(0, used / total)) : 0
  const warn = known && ratio >= 0.8
  const bar = (
    <div className="dshNewApiUsage">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={known ? 100 : undefined}
        aria-valuenow={known ? Math.round(ratio * 100) : undefined}
        className="dshNewApiUsageTrack"
      >
        <div
          className="dshNewApiUsageFill"
          data-warn={warn ? 'true' : undefined}
          style={{ width: known ? `${Math.round(ratio * 100)}%` : 0 }}
        />
      </div>
      <span className="dshNewApiUsagePercent">{known ? `${Math.round(ratio * 100)}%` : '--'}</span>
    </div>
  )
  if (!warn || warnLabel === undefined) return bar
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {bar}
      <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-warn-primary, #e6a700)' }}>{warnLabel}</span>
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
      {/*
        * Never mount both popups at once. Each one auto-starts its own
        * embedded login, and `login.native.start` replaces (and closes) the
        * previous attempt's window — so a user who clicks the footer button
        * while the first-run dialog is up saw the sign-in window flash open
        * and disappear. The explicit popup wins; the init dialog waits.
        */}
      <Modal open={initOpen && !open} onClose={closeInit} title={t('initTitle')} closeLabel={t('close')}>
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
  /** True once the stale cache survived several refresh attempts (server really unreachable). */
  staleConfirmed: boolean
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
  const [staleConfirmed, setStaleConfirmed] = useState(false)
  /**
   * Consecutive stale-serve count behind `staleConfirmed`: each poll that
   * still answers with cached data means one more refresh attempt failed,
   * and only STALE_ATTEMPTS_BEFORE_NOTICE of them justify announcing it.
   */
  const staleStreakRef = useRef(0)
  const [syncing, setSyncing] = useState(false)
  /**
   * Live for as long as this surface is mounted. The mount sequence awaits
   * several RPCs before it may auto-start the login, and the popup can be
   * closed in between; opening the Host's sign-in window then leaves it
   * orphaned — nothing polls it and nothing cancels it, so it sits there for
   * the full 10-minute attempt timeout.
   */
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])
  /** Guards against two overlapping `login.native.start` calls (double click,
   *  a re-mount, the reopen button): the second one settles and CLOSES the
   *  first attempt's window, which reads as the login window flashing away. */
  const startingRef = useRef(false)

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
    staleStreakRef.current = value.stale === true ? staleStreakRef.current + 1 : 0
    setStaleConfirmed(staleStreakRef.current >= STALE_ATTEMPTS_BEFORE_NOTICE)
  }

  /**
   * Load the snapshot. When the Host served a stale cache (offline server or
   * a background refresh still running), re-poll until the data turns fresh
   * or the retries run out — the extra calls join the Host-side in-flight
   * refresh, so they cost nothing extra. Spacing backs off exponentially:
   * after a 429 the Host's cooldown can run to minutes, and a flat 3s poll
   * would only burn RPC round-trips against a gate that keeps saying no.
   */
  const loadSnapshot = async (): Promise<void> => {
    const result = await call<SnapshotView>('snapshot.get')
    if (!result.ok) return
    applySnapshot(result.value)
    if (result.value.stale !== true) return
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, Math.min(3000 * 2 ** attempt, 30_000)) })
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
    if (startingRef.current) return
    startingRef.current = true
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    let result
    try {
      result = await call<{ loginUrl: string }>('login.native.start', { baseUrl: url })
    } finally {
      startingRef.current = false
    }
    if (!mountedRef.current) {
      // Closed while the Host was opening the window: cancel it instead of
      // leaving an unwatched sign-in window on screen.
      if (result.ok) void call('login.native.cancel')
      return
    }
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setEmbedded(result.value)
    embeddedRef.current = result.value
  }

  useEffect(() => {
    void (async () => {
      const loaded = await loadConfig()
      setConfigLoaded(true)
      if (loaded !== undefined && loaded.baseUrl !== '') await probeOnce(loaded.baseUrl)
      await loadSnapshot()
      // Footer entry + not signed in + a usable address: open the provider
      // authorize page immediately — no config form in between.
      if (mountedRef.current && autoLogin === true && loaded !== undefined && !loaded.tokenConfigured && loaded.baseUrl !== '') {
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
    currency, setCurrency, defaultContextWindow, setDefaultContextWindow, server, snapshot, staleConfirmed, configured, busy, syncing, message, error,
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

/** Settings-page switch row, matching the desktop settings ToggleRow face. */
function SettingsToggleRow(props: { label: string, checked: boolean, disabled?: boolean, onChange: (checked: boolean) => void }): JSX.Element {
  const { label, checked, disabled, onChange } = props
  const labelId = useId()
  return (
    <div className="dshNewApiSettingsToggleRow">
      <span id={labelId}>{label}</span>
      <button
        type="button"
        role="switch"
        className="dshNewApiSettingsToggle"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => { onChange(!checked) }}
      >
        <span className="dshNewApiSettingsToggleKnob" aria-hidden="true" />
      </button>
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
    config, configLoaded, baseUrl, server, snapshot, staleConfirmed, configured, busy,
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
                <StaleNote snapshot={snapshot} confirmed={staleConfirmed} t={t} />

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
                  <UsageBar used={snapshot?.usage.quotaUsed} total={snapshot?.usage.quotaTotal} warnLabel={t('quotaLow')} />
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
    server, snapshot, staleConfirmed, configured, busy, syncing, message, error,
    setBusy, setError, setMessage, setSyncing,
    username, setUsername, password, setPassword, embedded, loadConfig,
    onProbe, onEmbeddedLogin, startEmbeddedLogin, onEmbeddedCancel, onPasswordLogin,
    onSaveSettings, onClear, onRefresh,
  } = session

  const [syncLimit, setSyncLimit] = useState('')
  /** Inline per-model limit editor ({ id } plus raw input strings and the image toggle). */
  const [editing, setEditing] = useState<{ id: string, contextWindow: string, maxTokens: string, image: boolean } | undefined>(undefined)
  const limits = config?.modelLimits ?? {}
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
      image: editing.image,
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
    <div className="dshNewApiSettings">
      <header className="dshNewApiSettingsHeader">
        <h2>{t('nav')}</h2>
        <p>{t('intro')}</p>
      </header>

      {error !== undefined && <p className="dshNewApiSettingsError" role="alert">{t('failure')}: {error}</p>}
      {message !== undefined && <p className="dshNewApiSettingsSuccess" role="status">{message}</p>}

      {/* Server configuration — settings page only. */}
      <section className="dshNewApiSettingsGroup" aria-label={t('baseUrl')}>
        <div>
          <h3>{t('baseUrl')}</h3>
          {config?.baseUrlDefault !== undefined && config.baseUrlDefault !== '' && (
            <p className="dshNewApiSettingsIntro">{t('defaultServer', { url: config.baseUrlDefault })}</p>
          )}
        </div>
        {config === undefined
          ? (
              <div>
                <p className="dshNewApiSettingsHint">{configLoaded ? t('loadFailed') : t('loading')}</p>
                {configLoaded && (
                  <button type="button" className="dshNewApiSettingsButton" disabled={busy} onClick={() => { void loadConfig() }}>
                    {t('refresh')}
                  </button>
                )}
              </div>
            )
          : (
              <>
                {/*
                  * One card = one save scope. Everything persisted by a single
                  * "Save settings" press (server URL, currency, default context
                  * window, password-login switch) lives inside this one form
                  * card, with the save button anchored in the card footer and
                  * a hint naming exactly which fields it applies to.
                  */}
                <form
                  className="dshNewApiSettingsCard"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void onSaveSettings()
                  }}
                >
                  <label className="dshNewApiSettingsField">
                    <span aria-hidden="true">{t('baseUrl')}</span>
                    <span className="dshNewApiSettingsForm" style={{ flexWrap: 'nowrap' }}>
                      <input
                        className="dshNewApiSettingsInput"
                        value={baseUrl}
                        placeholder={config.baseUrlDefault !== '' ? config.baseUrlDefault : t('baseUrlPlaceholder')}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => setBaseUrl(event.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="dshNewApiSettingsButton dshNewApiSettingsButtonSecondary"
                        disabled={busy || baseUrl.trim() === ''}
                        onClick={() => { void onProbe() }}
                      >
                        {busy ? t('probing') : t('probe')}
                      </button>
                    </span>
                  </label>
                  <div className="dshNewApiSettingsRow2">
                    <label className="dshNewApiSettingsField">
                      {t('currencyLabel')}
                      <select
                        className="dshNewApiSettingsInput"
                        value={currency}
                        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                          const next = event.target.value
                          setCurrency(next === 'usd' ? 'usd' : 'cny')
                        }}
                      >
                        <option value="cny">{t('currencyCny')}</option>
                        <option value="usd">{t('currencyUsd')}</option>
                      </select>
                    </label>
                    <label className="dshNewApiSettingsField">
                      {t('defaultContextWindowLabel')}
                      <input
                        className="dshNewApiSettingsInput"
                        value={defaultContextWindow}
                        placeholder="131072"
                        onChange={(event: ChangeEvent<HTMLInputElement>) => setDefaultContextWindow(event.target.value)}
                        inputMode="numeric"
                        spellCheck={false}
                      />
                    </label>
                  </div>
                  <SettingsToggleRow
                    label={t('enablePasswordLogin')}
                    checked={passwordLoginOn}
                    disabled={busy}
                    onChange={setPasswordLoginOn}
                  />
                  <div className="dshNewApiSettingsCardFooter">
                    <button type="submit" className="dshNewApiSettingsSave" disabled={busy}>
                      {t('saveSettings')}
                    </button>
                    <span className="dshNewApiSettingsHint" style={{ margin: 0, flex: 1, minWidth: 200 }}>{t('saveScopeHint')}</span>
                    {server !== undefined && (
                      <span className="dshNewApiSettingsStatus">
                        <StateDot state="done" />
                        <span>{server.systemName} {server.version !== '' ? `(${server.version})` : ''}</span>
                        {oauthProviders.map((provider) => <Pill key={provider.slug}>{provider.name}</Pill>)}
                      </span>
                    )}
                  </div>
                  <p className="dshNewApiSettingsHint" style={{ margin: 0 }}>{t('defaultContextWindowHint')}</p>
                </form>
              </>
            )}
      </section>

      {/* Sign-in */}
      <section className="dshNewApiSettingsGroup" aria-label={t('login')}>
        <div><h3>{t('login')}</h3></div>
        {embedded !== undefined
          ? (
              <>
                <p className="dshNewApiSettingsHint">{t('embeddedWindowHint', { provider: providerLabel })} — {t('embeddedWaiting', { provider: providerLabel })}</p>
                <div className="dshNewApiSettingsActions">
                  <button type="button" className="dshNewApiSettingsButton" disabled={busy} onClick={() => { void startEmbeddedLogin(baseUrl) }}>
                    {t('embeddedReopen')}
                  </button>
                  <button type="button" className="dshNewApiSettingsButton dshNewApiSettingsButtonSecondary" onClick={() => { void onEmbeddedCancel() }}>
                    {t('embeddedCancel')}
                  </button>
                </div>
                <p className="dshNewApiSettingsNotice">{t('embeddedCaptureNote')}</p>
              </>
            )
          : (
              <>
                <div className="dshNewApiSettingsActions">
                  <button
                    type="button"
                    className="dshNewApiSettingsButton"
                    disabled={busy || baseUrl.trim() === ''}
                    onClick={() => { void onEmbeddedLogin() }}
                  >
                    {t('ssoButton', { provider: providerLabel })}
                  </button>
                  {config !== undefined && (
                    <button type="button" className="dshNewApiSettingsButton dshNewApiSettingsButtonSecondary" disabled={busy} onClick={() => { void onClear() }}>
                      {t('clear')}
                    </button>
                  )}
                  {config !== undefined && (
                    <span className="dshNewApiSettingsStatus">
                      <StateDot state={configured ? 'done' : 'warning'} />
                      {configured ? t('saved') : t('notConfigured')}
                    </span>
                  )}
                </div>
                {passwordLoginOn && server?.passwordLogin === true && (
                  <form
                    className="dshNewApiSettingsForm"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void onPasswordLogin()
                    }}
                  >
                    <label className="dshNewApiSettingsField dshNewApiSettingsFieldNarrow">
                      {t('username')}
                      <input
                        className="dshNewApiSettingsInput"
                        value={username}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        style={{ width: 160 }}
                      />
                    </label>
                    <label className="dshNewApiSettingsField dshNewApiSettingsFieldNarrow">
                      {t('password')}
                      <input
                        className="dshNewApiSettingsInput"
                        type="password"
                        value={password}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
                        autoComplete="off"
                        style={{ width: 160 }}
                      />
                    </label>
                    <button
                      type="submit"
                      className="dshNewApiSettingsButton"
                      disabled={busy || baseUrl.trim() === '' || username.trim() === '' || password === ''}
                    >
                      {busy ? t('loggingIn') : t('loginButton')}
                    </button>
                  </form>
                )}
              </>
            )}
      </section>

      {/* Lower-half placeholder while the first snapshot is still in flight. */}
      {snapshot === undefined && configured && (
        <section className="dshNewApiSettingsGroup">
          <p className="dshNewApiSettingsHint" style={{ margin: 0 }}>{t('loading')}</p>
        </section>
      )}

      {snapshot !== undefined && (
        <>
          <StaleNote snapshot={snapshot} confirmed={staleConfirmed} t={t} />

          {/* Account details + plan usage bar */}
          <section className="dshNewApiSettingsGroup" aria-label={t('account')}>
            <div>
              <h3>{t('account')}</h3>
            </div>
            <div className="dshNewApiSettingsActions">
              <button type="button" className="dshNewApiSettingsButton dshNewApiSettingsButtonSecondary" disabled={busy} onClick={() => { void onRefresh() }}>
                {t('refresh')}
              </button>
            </div>
            <div>
              <p className="dshNewApiSettingsHint" style={{ margin: 0 }}>{t('popupUsageTitle')}</p>
              <UsageBar used={snapshot.usage.quotaUsed} total={snapshot.usage.quotaTotal} warnLabel={t('quotaLow')} />
            </div>
            <dl className="dshNewApiSettingsDl">
              <dt>{t('usernameLabel')}</dt>
              <dd>
                {snapshot.user?.display_name ?? snapshot.user?.username ?? String(snapshot.user?.id ?? '--')}
                {snapshot.user?.email !== undefined && snapshot.user.email !== '' ? ` <${snapshot.user.email}>` : ''}
              </dd>
              {config?.accessTokenMasked !== undefined && (
                <>
                  <dt>{t('accessTokenLabel')}</dt>
                  <dd>
                    <code style={{ fontSize: 12 }}>{config.accessTokenMasked}</code>
                    <div style={{ color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: 12 }}>{t('accessTokenHint')}</div>
                  </dd>
                </>
              )}
              <dt>{t('group')}</dt>
              <dd>{snapshot.user?.group ?? '--'}</dd>
              <dt>{t('requests')}</dt>
              <dd>{snapshot.user?.request_count ?? '--'}</dd>
              <dt>{t('quotaUsed')}</dt>
              <dd>{money(snapshot.usage.quotaUsed, currency, exchangeRate)}</dd>
              <dt>{t('quotaRemaining')}</dt>
              <dd>
                {snapshot.usage.unlimited === true ? t('unlimited') : money(snapshot.usage.quotaRemaining, currency, exchangeRate)}
              </dd>
              <dt>{t('quotaTotal')}</dt>
              <dd>
                {snapshot.usage.unlimited === true ? t('unlimited') : money(snapshot.usage.quotaTotal, currency, exchangeRate)}
              </dd>
            </dl>
          </section>

          {/* API keys */}
          <section className="dshNewApiSettingsGroup" aria-label={t('tokens')}>
            <div className="dshNewApiSettingsActions">
              <h3 style={{ margin: 0, flex: 1 }}>{t('tokens')}</h3>
              <button type="button" className="dshNewApiSettingsButton" disabled={busy} onClick={() => { void onCreateToken() }}>
                {t('createToken')}
              </button>
            </div>
            {createdKey !== undefined && (
              <div className="dshNewApiSettingsKeyOnce">
                <span>{t('keyCreatedOnce', { name: createdKey.name })}</span>
                <code>{createdKey.key}</code>
                <button type="button" className="dshNewApiSettingsButton" onClick={() => { void onCopyKey(createdKey.key) }}>
                  {t('copyKey')}
                </button>
                <button type="button" className="dshNewApiSettingsButton dshNewApiSettingsButtonSecondary" onClick={() => setCreatedKey(undefined)}>
                  {t('close')}
                </button>
              </div>
            )}
            {snapshot.tokens.length === 0
              ? <p className="dshNewApiSettingsHint">{t('noTokensHint')}</p>
              : (
                <div className="dshNewApiSettingsTableWrap">
                  <table className="dshNewApiSettingsTable">
                    <thead>
                      <tr>
                        <th>{t('tokenName')}</th>
                        <th>{t('tokenKey')}</th>
                        <th>{t('tokenQuota')}</th>
                        <th>{t('tokenUsed')}</th>
                        <th>{t('tokenExpires')}</th>
                        <th>{t('tokenModels')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.tokens.map((row) => (
                        <tr key={row.id}>
                          <td>{row.name ?? String(row.id)}</td>
                          <td>
                            <code style={{ fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary, inherit)' }}>••••{row.key !== undefined ? row.key.slice(-4) : '????'}</code>
                          </td>
                          <td>{formatQuota(row.quota, snapshot.server.quotaPerUnit, currency, exchangeRate)}</td>
                          <td>{formatQuota(row.used_quota, snapshot.server.quotaPerUnit, currency, exchangeRate)}</td>
                          <td>{formatDate(row.expired_time)}</td>
                          <td>
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
          <section className="dshNewApiSettingsGroup" aria-label={t('models')}>
            <div className="dshNewApiSettingsActions">
              <h3 style={{ margin: 0, flex: 1 }}>{t('models')}</h3>
              <Pill>{t('modelsCount', { count: models.length })}</Pill>
            </div>
            <div className="dshNewApiSettingsTableWrap">
              <table className="dshNewApiSettingsTable">
                <thead>
                  <tr>
                    <th>{t('modelId')}</th>
                    <th>{t('modelInput')}</th>
                    <th>{t('modelOutput')}</th>
                    <th>{t('modelLimits')}</th>
                    <th>{t('modelImage')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => {
                    const storedLimit = limits[model.id]
                    const editingThis = editing?.id === model.id
                    return (
                      <tr key={model.id}>
                        <td style={{ fontFamily: 'monospace' }}>{model.id}</td>
                        <td>{model.priced === true ? formatPrice(model.inputPrice, currency, exchangeRate) : '--'}</td>
                        <td>{model.priced === true ? formatPrice(model.outputPrice, currency, exchangeRate) : '--'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {editingThis && editing !== undefined
                            ? (
                                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                  <input
                                    className="dshNewApiSettingsInput"
                                    value={editing.contextWindow}
                                    placeholder={t('contextWindow')}
                                    title={t('contextWindow')}
                                    onChange={(event: ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, contextWindow: event.target.value })}
                                    style={{ width: 96 }}
                                    inputMode="numeric"
                                    spellCheck={false}
                                  />
                                  <span style={{ color: 'var(--dsw-alias-label-tertiary, inherit)' }}>/</span>
                                  <input
                                    className="dshNewApiSettingsInput"
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
                                        contextWindow: String(config?.defaultContextWindow ?? 131072),
                                        maxTokens: '',
                                        image: true,
                                      })
                                    }}
                                  >
                                    {t('defaultLimitDisplay', { window: String(config?.defaultContextWindow ?? 131072) })}
                                  </span>
                                )
                              : `${storedLimit.contextWindow !== undefined ? String(storedLimit.contextWindow) : '?'} / ${storedLimit.maxTokens !== undefined ? String(storedLimit.maxTokens) : '?'}`}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {editingThis && editing !== undefined
                            ? (
                                <label title={t('modelImage')} style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                                  <input
                                    type="checkbox"
                                    checked={editing.image}
                                    onChange={(event: ChangeEvent<HTMLInputElement>) => setEditing({ ...editing, image: event.target.checked })}
                                  />
                                </label>
                              )
                            : (
                                <span
                                  title={t('modelImage')}
                                  style={{ color: storedLimit?.image === false ? 'var(--dsw-alias-label-tertiary, inherit)' : 'inherit' }}
                                >
                                  {storedLimit?.image === false ? '—' : '✓'}
                                </span>
                              )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {editingThis
                            ? (
                                <span style={{ display: 'inline-flex', gap: 6 }}>
                                  <button type="button" className="dshNewApiSettingsButton" disabled={busy} onClick={() => { void onSaveLimit() }}>{t('saveLimit')}</button>
                                  <button type="button" className="dshNewApiSettingsButton dshNewApiSettingsButtonSecondary" disabled={busy} onClick={() => { setEditing(undefined) }}>{t('cancelLimit')}</button>
                                </span>
                              )
                            : (
                                <button
                                  type="button"
                                  className="dshNewApiSettingsButton"
                                  disabled={busy}
                                  onClick={() => {
                                    setEditing({
                                      id: model.id,
                                      contextWindow: storedLimit?.contextWindow !== undefined ? String(storedLimit.contextWindow) : '',
                                      maxTokens: storedLimit?.maxTokens !== undefined ? String(storedLimit.maxTokens) : '',
                                      image: storedLimit?.image !== false,
                                    })
                                  }}
                                >
                                  {t('editLimit')}
                                </button>
                              )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="dshNewApiSettingsForm">
              <button type="button" className="dshNewApiSettingsButton" disabled={syncing || models.length === 0} onClick={() => { void onSync() }}>
                {syncing ? t('syncing') : t('sync')}
              </button>
              <label className="dshNewApiSettingsField dshNewApiSettingsFieldNarrow">
                {t('syncLimit')}
                <input
                  className="dshNewApiSettingsInput"
                  value={syncLimit}
                  placeholder={t('syncLimit')}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setSyncLimit(event.target.value)}
                  style={{ width: 140 }}
                  inputMode="numeric"
                />
              </label>
            </div>
            <p className="dshNewApiSettingsHint">{t('limitHint')}</p>
          </section>
        </>
      )}
    </div>
  )
}
