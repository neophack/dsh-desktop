window.__ModuleLoader__.load({
	id: "dsh-plugin-newapi",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_jsx_runtime = require("react/jsx-runtime");
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime2 = require("react/jsx-runtime");
var NS = "settings.newapi";
var CHANNEL = "/newapi";
var QUOTA_PER_UNIT = 5e5;
var STALE_ATTEMPTS_BEFORE_NOTICE = 3;
function money(value, currency, rate) {
  if (value === void 0) return "--";
  if (currency === "cny" && rate > 0) return `\xA5${(value * rate).toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}
function formatPrice(value, currency, rate) {
  return money(value, currency, rate);
}
function formatQuota(quota, quotaPerUnit, currency, rate, unlimitedLabel = "unlimited") {
  if (quota === void 0) return "--";
  if (quota < 0) return unlimitedLabel;
  return money(quota / (quotaPerUnit > 0 ? quotaPerUnit : QUOTA_PER_UNIT), currency, rate);
}
function formatDate(seconds) {
  if (seconds === void 0 || seconds <= 0) return "--";
  return new Date(seconds * 1e3).toLocaleDateString();
}
function formatCachedAt(ms) {
  if (ms === void 0) return "--";
  return new Date(ms).toLocaleString();
}
function StaleNote(props) {
  if (props.snapshot?.stale !== true || !props.confirmed) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "warning" }),
    props.t("staleCache", { time: formatCachedAt(props.snapshot.cachedAt) })
  ] });
}
var inject = ["slots", "locale", "connection"];
var FOOTER_STYLE_TAG = "dsh-plugin-newapi/sidebar-footer-row";
function injectFooterRowStyle() {
  if (typeof document === "undefined") return () => {
  };
  const existing = document.querySelector(`style[data-plugin-css="${FOOTER_STYLE_TAG}"]`);
  if (existing !== null) return () => {
  };
  const tag = document.createElement("style");
  tag.dataset.pluginCss = FOOTER_STYLE_TAG;
  tag.textContent = [
    // footArea (the only div whose grandchild is the footer.action anchor): row,
    // login (DOM-first) pinned left, Settings pinned right.
    'div:has(> div > [data-slot="sidebar.footer.action"]){flex-direction:row !important;justify-content:space-between;align-items:center;}',
    // Both footer rows shrink to content so the pair can sit at opposite edges.
    'div:has(> [data-slot="sidebar.footer.action"]),div:has(> [data-slot="sidebar.settings"]){width:auto !important;}',
    // Popup waiting-spinner keyframes.
    "@keyframes dsh-newapi-spin{to{transform:rotate(360deg)}}"
  ].join("\n");
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}
var SETTINGS_STYLE_TAG = "dsh-plugin-newapi/settings-styles";
var SETTINGS_CSS = `
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
`;
function injectSettingsStyle() {
  if (typeof document === "undefined") return () => {
  };
  const existing = document.querySelector(`style[data-plugin-css="${SETTINGS_STYLE_TAG}"]`);
  if (existing !== null) return () => {
  };
  const tag = document.createElement("style");
  tag.dataset.pluginCss = SETTINGS_STYLE_TAG;
  tag.textContent = SETTINGS_CSS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "newapi: copy dictionaries");
  ctx.effect(injectFooterRowStyle, "newapi: sidebar footer row layout");
  ctx.effect(injectSettingsStyle, "newapi: settings page styles");
  const connection = ctx.get("connection");
  const call = async (endpoint, payload = {}, signal) => {
    try {
      return await connection.rpc.call(CHANNEL, endpoint, payload, signal);
    } catch (error) {
      return { ok: false, error: { code: "transport", message: error instanceof Error ? error.message : String(error) } };
    }
  };
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "newapi",
    order: 15,
    label: () => t("nav"),
    inject: () => ({ call, t, showConfig: true })
  }, NewApiSettings));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "newapi-login",
    order: 10,
    locale: NS,
    inject: () => ({ call, t })
  }, NewApiFooterButton));
}
var zh = {
  nav: "NewAPI",
  footerLabel: "\u767B\u5F55 NewAPI",
  close: "\u5173\u95ED",
  intro: "\u8FDE\u63A5 NewAPI \u7F51\u5173: \u652F\u6301\u98DE\u4E66\u7B49 SSO \u767B\u5F55\u5F15\u5BFC, \u7BA1\u7406\u5BC6\u94A5\u3001\u67E5\u770B\u53EF\u7528\u6A21\u578B\u4E0E\u5957\u9910\u7528\u91CF, \u5E76\u540C\u6B65\u5230\u5BF9\u8BDD\u6A21\u578B\u9009\u62E9\u5668\u3002",
  baseUrl: "\u670D\u52A1\u5668\u5730\u5740",
  baseUrlPlaceholder: "http://172.24.204.251:4000",
  defaultServer: "\u9ED8\u8BA4\u670D\u52A1\u5668: {url}; \u4FEE\u6539\u540E\u70B9\u300C\u4FDD\u5B58\u8BBE\u7F6E\u300D, \u6E05\u7A7A\u5219\u6062\u590D\u9ED8\u8BA4\u3002",
  enablePasswordLogin: "\u542F\u7528\u7528\u6237\u540D\u5BC6\u7801\u767B\u5F55",
  currencyLabel: "\u5E01\u79CD",
  currencyCny: "\u4EBA\u6C11\u5E01 (\xA5)",
  currencyUsd: "\u7F8E\u5143 ($)",
  defaultContextWindowLabel: "\u9ED8\u8BA4\u4E0A\u4E0B\u6587",
  defaultContextWindowHint: "\u6240\u6709\u672A\u5355\u72EC\u8BBE\u7F6E\u7684\u6A21\u578B\u9ED8\u8BA4 131072 (128k) tokens; \u586B 0 \u5173\u95ED, \u4FDD\u5B58\u540E\u9700\u91CD\u65B0\u540C\u6B65\u6A21\u578B\u751F\u6548\u3002",
  saveSettings: "\u4FDD\u5B58\u8BBE\u7F6E",
  saveScopeHint: "\u300C\u4FDD\u5B58\u8BBE\u7F6E\u300D\u4F1A\u4E00\u5E76\u5E94\u7528\u672C\u5361\u7247\u5185\u7684\u5168\u90E8\u5B57\u6BB5: \u670D\u52A1\u5668\u5730\u5740\u3001\u5E01\u79CD\u3001\u9ED8\u8BA4\u4E0A\u4E0B\u6587\u4E0E\u767B\u5F55\u65B9\u5F0F\u3002",
  settingsSaved: "\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\u3002",
  loadFailed: "\u52A0\u8F7D\u914D\u7F6E\u5931\u8D25, \u8BF7\u91CD\u8BD5\u3002",
  probe: "\u68C0\u6D4B\u670D\u52A1\u5668",
  probing: "\u68C0\u6D4B\u4E2D...",
  probed: "\u5DF2\u8FDE\u63A5\u670D\u52A1\u5668 {name} ({version})",
  login: "\u767B\u5F55",
  loginPassword: "\u5BC6\u7801\u767B\u5F55",
  username: "\u7528\u6237\u540D",
  password: "\u5BC6\u7801",
  loginButton: "\u767B\u5F55",
  loggingIn: "\u767B\u5F55\u4E2D...",
  loginOk: "\u767B\u5F55\u6210\u529F: {user}",
  ssoButton: "\u4F7F\u7528{provider}\u767B\u5F55",
  embeddedWaiting: "\u5DF2\u5728\u72EC\u7ACB\u7A97\u53E3\u6253\u5F00 {provider} \u767B\u5F55; \u8BF7\u5728\u7A97\u53E3\u4E2D\u5B8C\u6210\u6388\u6743 (\u626B\u7801\u6216\u8D26\u53F7\u767B\u5F55), \u6210\u529F\u540E\u63D2\u4EF6\u81EA\u52A8\u83B7\u53D6\u51ED\u636E\u3001\u5957\u9910\u7528\u91CF, \u5E76\u81EA\u52A8\u786E\u4FDD\u4E00\u4E2A API key (\u6CA1\u6709\u5C31\u65B0\u5EFA, \u6709\u5C31\u7528\u7B2C\u4E00\u4E2A), \u65E0\u9700\u590D\u5236\u7C98\u8D34\u3002",
  embeddedWindowHint: "\u8BF7\u5728\u5F39\u51FA\u7684\u767B\u5F55\u7A97\u53E3\u4E2D\u5B8C\u6210 {provider} \u6388\u6743",
  embeddedReopen: "\u91CD\u65B0\u6253\u5F00\u767B\u5F55\u7A97\u53E3",
  embeddedCancel: "\u53D6\u6D88\u767B\u5F55",
  embeddedCaptureNote: "\u767B\u5F55\u7A97\u53E3\u5173\u95ED\u6216\u70B9\u51FB\u300C\u53D6\u6D88\u767B\u5F55\u300D\u4F1A\u4E2D\u6B62\u672C\u6B21\u767B\u5F55, \u53EF\u968F\u65F6\u91CD\u8BD5\u3002",
  embeddedFailed: "\u767B\u5F55\u672A\u5B8C\u6210\u6216\u5DF2\u8D85\u65F6, \u8BF7\u91CD\u8BD5\u3002",
  saved: "\u5DF2\u8FDE\u63A5",
  notConfigured: "\u5C1A\u672A\u767B\u5F55\u3002",
  clear: "\u9000\u51FA\u767B\u5F55",
  cleared: "\u5DF2\u6E05\u9664",
  refresh: "\u5237\u65B0",
  loading: "\u52A0\u8F7D\u4E2D...",
  account: "\u8D26\u6237",
  usernameLabel: "\u7528\u6237",
  accessTokenLabel: "\u8BBF\u95EE\u4EE4\u724C",
  accessTokenHint: "\u5DF2\u7F13\u5B58\u4E8E\u672C\u673A, \u4EC5\u663E\u793A\u9996\u5C3E; \u91CD\u65B0\u767B\u5F55\u65F6\u81EA\u52A8\u590D\u7528, \u5931\u6548\u624D\u91CD\u65B0\u751F\u6210\u3002",
  email: "\u90AE\u7BB1",
  group: "\u5206\u7EC4",
  requests: "\u8BF7\u6C42\u6570",
  quotaUsed: "\u5DF2\u7528",
  quotaRemaining: "\u5269\u4F59",
  quotaTotal: "\u603B\u91CF",
  unlimited: "\u4E0D\u9650\u91CF",
  quotaLow: "\u7528\u91CF\u5DF2\u8D85\u8FC7 80%, \u8BF7\u6CE8\u610F\u5269\u4F59\u989D\u5EA6\u3002",
  tokens: "API \u5BC6\u94A5(\u4EE4\u724C)",
  tokenName: "\u540D\u79F0",
  tokenKey: "\u5BC6\u94A5",
  tokenQuota: "\u989D\u5EA6",
  tokenUsed: "\u5DF2\u7528",
  tokenExpires: "\u8FC7\u671F\u65F6\u95F4",
  tokenModels: "\u53EF\u7528\u6A21\u578B",
  tokenAllModels: "\u5168\u90E8\u6A21\u578B",
  noTokens: "\u6CA1\u6709\u53EF\u7528\u7684\u4EE4\u724C\u3002\u8BF7\u5728 NewAPI \u63A7\u5236\u53F0\u521B\u5EFA\u3002",
  noTokensHint: "\u6CA1\u6709\u53EF\u7528\u7684\u4EE4\u724C, \u70B9\u51FB\u53F3\u4E0A\u89D2\u300C\u521B\u5EFA\u5BC6\u94A5\u300D\u76F4\u63A5\u65B0\u5EFA\u4E00\u4E2A\u3002",
  createToken: "\u521B\u5EFA\u5BC6\u94A5",
  copyKey: "\u590D\u5236",
  keyCreatedOnce: "\u65B0\u5BC6\u94A5\u300C{name}\u300D\u5DF2\u521B\u5EFA, \u5B8C\u6574\u5BC6\u94A5\u4EC5\u6B64\u4E00\u6B21\u663E\u793A:",
  keyCopied: "\u5BC6\u94A5\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F\u3002",
  keyCopyFailed: "\u590D\u5236\u5931\u8D25, \u8BF7\u624B\u52A8\u9009\u62E9\u590D\u5236\u3002",
  models: "\u652F\u6301\u7684\u6A21\u578B",
  modelsCount: "{count} \u4E2A\u6A21\u578B",
  modelId: "\u6A21\u578B ID",
  modelInput: "\u8F93\u5165\u4EF7 / 1M",
  modelOutput: "\u8F93\u51FA\u4EF7 / 1M",
  sync: "\u540C\u6B65\u6A21\u578B\u5230\u5BF9\u8BDD",
  syncing: "\u540C\u6B65\u4E2D...",
  synced: "\u5DF2\u540C\u6B65 {count} \u4E2A\u6A21\u578B\u5230\u63D0\u4F9B\u65B9\u300C{route}\u300D; \u5BF9\u8BDD\u7684\u6A21\u578B\u9009\u62E9\u5668\u4E2D\u5373\u53EF\u9009\u62E9\u3002",
  syncNeedsConfig: "\u8BF7\u5148\u5B8C\u6210\u767B\u5F55\u3002",
  syncLimit: "\u6570\u91CF\u4E0A\u9650(\u53EF\u9009)",
  modelChat: "\u5BF9\u8BDD\u4E2D\u53EF\u7528",
  addToChat: "\u6DFB\u52A0",
  removeFromChat: "\u79FB\u9664",
  addedToChat: "\u5DF2\u6DFB\u52A0 {model} \u5230\u5BF9\u8BDD\u6A21\u578B\u9009\u62E9\u5668\u3002",
  removedFromChat: "\u5DF2\u4ECE\u5BF9\u8BDD\u6A21\u578B\u9009\u62E9\u5668\u79FB\u9664 {model}\u3002",
  modelsNoneSelectedHint: "\u9ED8\u8BA4\u4E0D\u6DFB\u52A0\u4EFB\u4F55\u6A21\u578B; \u70B9\u51FB\u6BCF\u884C\u7684\u300C\u6DFB\u52A0\u300D, \u6DFB\u52A0\u540E\u7684\u6A21\u578B\u4F1A\u51FA\u73B0\u5728\u5BF9\u8BDD\u7684\u6A21\u578B\u9009\u62E9\u5668\u4E2D, \u300C\u79FB\u9664\u300D\u5373\u53EF\u5220\u9664\u3002",
  modelLimits: "\u4E0A\u4E0B\u6587 / \u6700\u5927\u8F93\u51FA",
  modelImage: "\u652F\u6301\u56FE\u7247",
  editLimit: "\u8BBE\u7F6E",
  saveLimit: "\u4FDD\u5B58",
  cancelLimit: "\u53D6\u6D88",
  contextWindow: "\u4E0A\u4E0B\u6587\u957F\u5EA6",
  maxOutputTokens: "\u6700\u5927\u8F93\u51FA",
  limitHint: "\u5355\u4F4D: token; \u6E05\u7A7A\u4E24\u9879\u5219\u5220\u9664\u8BE5\u6A21\u578B\u7684\u9650\u5236",
  limitSaved: "\u5DF2\u4FDD\u5B58 {model} \u7684\u9650\u5236\u5E76\u91CD\u65B0\u540C\u6B65",
  defaultLimitDisplay: "\u9ED8\u8BA4 {window}",
  failure: "\u64CD\u4F5C\u5931\u8D25",
  staleCache: "\u7F51\u7EDC\u4E0D\u53EF\u7528\u6216\u670D\u52A1\u5668\u65E0\u6CD5\u8FDE\u63A5, \u6B63\u5728\u663E\u793A\u7F13\u5B58\u6570\u636E (\u66F4\u65B0\u4E8E {time})",
  // Popup-only copy.
  popupOpenSettings: "\u5B8C\u6574\u8BBE\u7F6E",
  popupUsageTitle: "\u5957\u9910\u7528\u91CF",
  popupTokenUsage: "\u5BC6\u94A5\u7528\u91CF",
  popupRequests: "{count} \u6B21\u8BF7\u6C42",
  popupServer: "\u670D\u52A1\u5668",
  popupSignedInAs: "\u5DF2\u767B\u5F55",
  // Init key-setup dialog copy.
  initTitle: "\u8BBE\u7F6E NewAPI",
  initHint: "\u5C1A\u672A\u914D\u7F6E NewAPI \u5BC6\u94A5, \u5BF9\u8BDD\u4E2D\u7684 NewAPI \u6A21\u578B\u6682\u4E0D\u53EF\u89C1\u3002\u5B8C\u6210\u767B\u5F55\u540E\u63D2\u4EF6\u4F1A\u81EA\u52A8\u83B7\u53D6/\u521B\u5EFA\u5BC6\u94A5\u5E76\u540C\u6B65\u5DF2\u6DFB\u52A0\u7684\u6A21\u578B, \u672C\u5F39\u7A97\u968F\u4E4B\u81EA\u52A8\u5173\u95ED\u3002"
};
var en = {
  nav: "NewAPI",
  footerLabel: "Sign in NewAPI",
  close: "Close",
  intro: "Connect a NewAPI gateway: SSO login guidance (Feishu and friends), manage keys, browse supported models and quota usage, and sync them into the chat model selector.",
  baseUrl: "Server URL",
  baseUrlPlaceholder: "http://172.24.204.251:4000",
  defaultServer: "Default server: {url}; edit and press Save settings \u2014 clearing the field restores the default.",
  enablePasswordLogin: "Enable username/password sign-in",
  currencyLabel: "Currency",
  currencyCny: "CNY (\xA5)",
  currencyUsd: "USD ($)",
  defaultContextWindowLabel: "Default context",
  defaultContextWindowHint: "Every model without explicit limits defaults to 131072 (128k) tokens; 0 disables. Save, then re-sync models to apply.",
  saveSettings: "Save settings",
  saveScopeHint: '"Save settings" applies every field in this card at once: server URL, currency, default context, and sign-in mode.',
  settingsSaved: "Settings saved.",
  loadFailed: "Failed to load settings; please retry.",
  probe: "Probe server",
  probing: "Probing...",
  probed: "Connected to {name} ({version})",
  login: "Sign in",
  loginPassword: "Password sign-in",
  username: "Username",
  password: "Password",
  loginButton: "Sign in",
  loggingIn: "Signing in...",
  loginOk: "Signed in as {user}",
  ssoButton: "Sign in with {provider}",
  embeddedWaiting: "The {provider} sign-in page opened in its own window; finish the authorization (scan the QR code or sign in) there. The plugin then captures the credential and plan usage automatically and ensures an API key (created if none, first one otherwise) \u2014 no copy-paste.",
  embeddedWindowHint: "Finish the {provider} authorization in the window that just opened",
  embeddedReopen: "Reopen the sign-in window",
  embeddedCancel: "Cancel sign-in",
  embeddedCaptureNote: "Closing the sign-in window or pressing Cancel aborts this attempt; retry any time.",
  embeddedFailed: "Sign-in did not complete (or timed out); please retry.",
  saved: "Connected",
  notConfigured: "Not signed in yet.",
  clear: "Sign out",
  cleared: "Cleared",
  refresh: "Refresh",
  loading: "Loading...",
  account: "Account",
  usernameLabel: "User",
  accessTokenLabel: "Access token",
  accessTokenHint: "Cached locally, shown masked; reused on re-login, regenerated only when it stops working.",
  email: "Email",
  group: "Group",
  requests: "Requests",
  quotaUsed: "Used",
  quotaRemaining: "Remaining",
  quotaTotal: "Total",
  unlimited: "Unlimited",
  quotaLow: "Over 80% of the plan quota is used \u2014 watch the remaining balance.",
  tokens: "API keys (tokens)",
  tokenName: "Name",
  tokenKey: "Key",
  tokenQuota: "Quota",
  tokenUsed: "Used",
  tokenExpires: "Expires",
  tokenModels: "Models",
  tokenAllModels: "All models",
  noTokens: "No tokens. Create one in the NewAPI console.",
  noTokensHint: 'No tokens yet \u2014 click "Create key" above to make one right here.',
  createToken: "Create key",
  copyKey: "Copy",
  keyCreatedOnce: 'Key "{name}" created \u2014 shown only once:',
  keyCopied: "Key copied to clipboard.",
  keyCopyFailed: "Copy failed; select and copy manually.",
  models: "Supported models",
  modelsCount: "{count} models",
  modelId: "Model ID",
  modelInput: "Input / 1M",
  modelOutput: "Output / 1M",
  sync: "Sync models to chat",
  syncing: "Syncing...",
  synced: 'Synced {count} models to provider "{route}"; pick them from the chat model selector.',
  syncNeedsConfig: "Sign in first.",
  syncLimit: "Limit (optional)",
  modelChat: "In chat",
  addToChat: "Add",
  removeFromChat: "Remove",
  addedToChat: "Added {model} to the chat model selector.",
  removedFromChat: "Removed {model} from the chat model selector.",
  modelsNoneSelectedHint: 'No model is added by default. Press "Add" on a row to offer it in the chat model selector; "Remove" deletes it again.',
  modelLimits: "Context / Max out",
  modelImage: "Image input",
  editLimit: "Set",
  saveLimit: "Save",
  cancelLimit: "Cancel",
  contextWindow: "Context window",
  maxOutputTokens: "Max output",
  limitHint: "In tokens; empty both to remove the limit",
  limitSaved: "Saved limits for {model} and re-synced",
  defaultLimitDisplay: "default {window}",
  failure: "Operation failed",
  staleCache: "Network unavailable or server unreachable \u2014 showing cached data (updated {time})",
  // Popup-only copy.
  popupOpenSettings: "All settings",
  popupUsageTitle: "Plan usage",
  popupTokenUsage: "Key usage",
  popupRequests: "{count} requests",
  popupServer: "Server",
  popupSignedInAs: "Signed in",
  // Init key-setup dialog copy.
  initTitle: "Set up NewAPI",
  initHint: "No NewAPI credential yet, so the NewAPI models stay hidden in the chat selector. Finish the sign-in and the plugin captures/creates the key and syncs your added models automatically \u2014 this dialog then closes by itself."
};
var cardStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 16,
  borderRadius: 12,
  border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))",
  background: "var(--dsw-alias-bg-layer-1, transparent)"
};
var cardTitleStyle = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: "var(--dsw-alias-label-tertiary, inherit)"
};
function UsageBar(props) {
  const { used, total, warnLabel } = props;
  const known = used !== void 0 && total !== void 0 && total > 0;
  const ratio = known ? Math.min(1, Math.max(0, used / total)) : 0;
  const warn = known && ratio >= 0.8;
  const bar = /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiUsage", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "div",
      {
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": known ? 100 : void 0,
        "aria-valuenow": known ? Math.round(ratio * 100) : void 0,
        className: "dshNewApiUsageTrack",
        children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "div",
          {
            className: "dshNewApiUsageFill",
            "data-warn": warn ? "true" : void 0,
            style: { width: known ? `${Math.round(ratio * 100)}%` : 0 }
          }
        )
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshNewApiUsagePercent", children: known ? `${Math.round(ratio * 100)}%` : "--" })
  ] });
  if (!warn || warnLabel === void 0) return bar;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
    bar,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-warn-primary, #e6a700)" }, children: warnLabel })
  ] });
}
function NewApiFooterButton(props) {
  const { wide, call, t } = props;
  const [open, setOpen] = (0, import_react.useState)(false);
  const [userName, setUserName] = (0, import_react.useState)(void 0);
  const [initOpen, setInitOpen] = (0, import_react.useState)(false);
  const refreshUser = async () => {
    if (call === void 0) return;
    const result = await call("user.get");
    setUserName(result.ok && result.value !== void 0 ? [result.value.display_name, result.value.username].find((s) => typeof s === "string" && s !== "") ?? String(result.value.id) : void 0);
  };
  const isConfigured = async () => {
    if (call === void 0) return true;
    const result = await call("config.get");
    return result.ok && result.value.tokenConfigured && result.value.apiKeyConfigured;
  };
  (0, import_react.useEffect)(() => {
    void (async () => {
      await refreshUser();
      if (await isConfigured()) return;
      setInitOpen(true);
    })();
  }, []);
  (0, import_react.useEffect)(() => {
    if (!initOpen || call === void 0) return;
    const timer = setInterval(() => {
      void (async () => {
        if (await isConfigured()) setInitOpen(false);
      })();
    }, 3e3);
    return () => {
      clearInterval(timer);
    };
  }, [initOpen]);
  if (call === void 0 || t === void 0) return null;
  const close = () => {
    setOpen(false);
    void refreshUser();
  };
  const closeInit = () => {
    setInitOpen(false);
    void refreshUser();
  };
  const label = userName !== void 0 ? userName : t("footerLabel");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_react.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "button",
      {
        type: "button",
        onClick: () => setOpen(true),
        "aria-label": label,
        title: label,
        style: wide === false ? {
          boxSizing: "border-box",
          cursor: "pointer",
          flex: "none",
          width: 36,
          height: 36,
          margin: "4px 0",
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--dsw-alias-label-primary)",
          background: "transparent",
          border: "none",
          borderRadius: "50%",
          fontFamily: "inherit"
        } : {
          boxSizing: "border-box",
          cursor: "pointer",
          flex: "none",
          height: 42,
          margin: "4px 6px 4px 0",
          padding: "0 10px 0 8px",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          color: "var(--dsw-alias-label-primary)",
          background: "transparent",
          border: "none",
          borderRadius: 12,
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: "22px",
          whiteSpace: "nowrap",
          overflow: "hidden"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconUserOutline16, { size: 16 }),
          wide !== false && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { whiteSpace: "nowrap", overflow: "hidden" }, children: label })
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Modal, { open, onClose: close, title: t("nav"), closeLabel: t("close"), children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { maxHeight: "70vh", overflowY: "auto" }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(NewApiPopup, { call, t, autoLogin: true, onAuthenticated: close }) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Modal, { open: initOpen && !open, onClose: closeInit, title: t("initTitle"), closeLabel: t("close"), children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { maxHeight: "70vh", overflowY: "auto" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: { margin: "0 0 10px", fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, inherit)" }, children: t("initHint") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(NewApiPopup, { call, t, autoLogin: true, onAuthenticated: closeInit })
    ] }) })
  ] });
}
var NOOP_CALL = async () => ({ ok: false, error: { code: "unavailable", message: "newapi: RPC channel not available" } });
var NOOP_T = (key) => key;
function useNewApiSession(call, t, options = {}) {
  const { autoLogin, onAuthenticated } = options;
  const [config, setConfig] = (0, import_react.useState)(void 0);
  const [configLoaded, setConfigLoaded] = (0, import_react.useState)(false);
  const [baseUrl, setBaseUrl] = (0, import_react.useState)("");
  const [passwordLoginOn, setPasswordLoginOn] = (0, import_react.useState)(false);
  const [currency, setCurrency] = (0, import_react.useState)("cny");
  const [defaultContextWindow, setDefaultContextWindow] = (0, import_react.useState)("");
  const [server, setServer] = (0, import_react.useState)(void 0);
  const [username, setUsername] = (0, import_react.useState)("");
  const [password, setPassword] = (0, import_react.useState)("");
  const [embedded, setEmbedded] = (0, import_react.useState)(void 0);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [message, setMessage] = (0, import_react.useState)(void 0);
  const [error, setError] = (0, import_react.useState)(void 0);
  const [snapshot, setSnapshot] = (0, import_react.useState)(void 0);
  const [staleConfirmed, setStaleConfirmed] = (0, import_react.useState)(false);
  const staleStreakRef = (0, import_react.useRef)(0);
  const [syncing, setSyncing] = (0, import_react.useState)(false);
  const mountedRef = (0, import_react.useRef)(true);
  (0, import_react.useEffect)(() => () => {
    mountedRef.current = false;
  }, []);
  const startingRef = (0, import_react.useRef)(false);
  const loadConfig = async () => {
    const result = await call("config.get");
    if (result.ok) {
      setConfig(result.value);
      setBaseUrl((current) => current === "" && result.value.baseUrl !== "" ? result.value.baseUrl : current);
      setPasswordLoginOn(result.value.passwordLogin);
      setCurrency(result.value.currency);
      if (result.value.defaultContextWindow !== void 0) {
        setDefaultContextWindow((current) => current === "" ? String(result.value.defaultContextWindow) : current);
      }
      return result.value;
    }
    setError(`${t("loadFailed")} (${result.error.code}: ${result.error.message})`);
    return void 0;
  };
  const applySnapshot = (value) => {
    setSnapshot(value);
    setServer(value.server);
    staleStreakRef.current = value.stale === true ? staleStreakRef.current + 1 : 0;
    setStaleConfirmed(staleStreakRef.current >= STALE_ATTEMPTS_BEFORE_NOTICE);
  };
  const loadSnapshot = async () => {
    const result = await call("snapshot.get");
    if (!result.ok) return;
    applySnapshot(result.value);
    if (result.value.stale !== true) return;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(3e3 * 2 ** attempt, 3e4));
      });
      const next = await call("snapshot.get");
      if (!next.ok) continue;
      applySnapshot(next.value);
      if (next.value.stale !== true) break;
    }
  };
  const probeOnce = async (url) => {
    const result = await call("server.status", { baseUrl: url });
    if (result.ok) setServer(result.value.info);
  };
  const startEmbeddedLogin = async (url) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    setError(void 0);
    setMessage(void 0);
    let result;
    try {
      result = await call("login.native.start", { baseUrl: url });
    } finally {
      startingRef.current = false;
    }
    if (!mountedRef.current) {
      if (result.ok) void call("login.native.cancel");
      return;
    }
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setEmbedded(result.value);
    embeddedRef.current = result.value;
  };
  (0, import_react.useEffect)(() => {
    void (async () => {
      const loaded = await loadConfig();
      setConfigLoaded(true);
      if (loaded !== void 0 && loaded.baseUrl !== "") await probeOnce(loaded.baseUrl);
      await loadSnapshot();
      if (mountedRef.current && autoLogin === true && loaded !== void 0 && !loaded.tokenConfigured && loaded.baseUrl !== "") {
        await startEmbeddedLogin(loaded.baseUrl);
      }
    })();
  }, []);
  const embeddedRef = (0, import_react.useRef)(void 0);
  (0, import_react.useEffect)(() => {
    embeddedRef.current = embedded;
  }, [embedded]);
  (0, import_react.useEffect)(() => () => {
    if (embeddedRef.current !== void 0) void call("login.native.cancel");
  }, []);
  (0, import_react.useEffect)(() => {
    if (embedded === void 0) return;
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        const result = await call("login.native.status");
        if (!alive || !result.ok) return;
        if (result.value.status === "ok") {
          alive = false;
          clearInterval(timer);
          setEmbedded(void 0);
          embeddedRef.current = void 0;
          setMessage(t("loginOk", { user: result.value.user?.display_name ?? result.value.user?.username ?? "?" }));
          await loadConfig();
          await loadSnapshot();
          await call("login.native.cancel");
          onAuthenticated?.();
        } else if (result.value.status === "error") {
          alive = false;
          clearInterval(timer);
          setEmbedded(void 0);
          embeddedRef.current = void 0;
          const raw = result.value.error ?? "";
          setError(raw !== "" && raw !== "canceled" ? raw : t("embeddedFailed"));
          await call("login.native.cancel");
        }
      })();
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [embedded]);
  const configured = config !== void 0 && config.baseUrl !== "" && config.tokenConfigured;
  const onProbe = async () => {
    setBusy(true);
    setError(void 0);
    setMessage(void 0);
    const result = await call("server.status", { baseUrl });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setServer(result.value.info);
    if (result.value.baseUrl !== "" && baseUrl === "") setBaseUrl(result.value.baseUrl);
    setMessage(t("probed", { name: result.value.info.systemName, version: result.value.info.version }));
  };
  const onEmbeddedLogin = async () => startEmbeddedLogin(baseUrl);
  const onEmbeddedCancel = async () => {
    setEmbedded(void 0);
    embeddedRef.current = void 0;
    await call("login.native.cancel");
  };
  const onPasswordLogin = async () => {
    setBusy(true);
    setError(void 0);
    setMessage(void 0);
    const result = await call("login.password", { baseUrl, username, password });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setPassword("");
    setMessage(t("loginOk", { user: result.value.user.display_name ?? result.value.user.username ?? "?" }));
    await loadConfig();
    await loadSnapshot();
    onAuthenticated?.();
  };
  const onSaveSettings = async () => {
    setBusy(true);
    setError(void 0);
    setMessage(void 0);
    const trimmed = baseUrl.trim();
    const parsedWindow = Number.parseInt(defaultContextWindow.trim() === "" ? "0" : defaultContextWindow.trim(), 10);
    const payload = { baseUrl: trimmed, passwordLogin: passwordLoginOn, currency };
    if (Number.isFinite(parsedWindow) && parsedWindow >= 0) payload.defaultContextWindow = parsedWindow;
    const result = await call("config.set", payload);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setConfig(result.value);
    if (result.value.currency === "cny" || result.value.currency === "usd") setCurrency(result.value.currency);
    if (result.value.defaultContextWindow !== void 0) setDefaultContextWindow(String(result.value.defaultContextWindow));
    setMessage(t("settingsSaved"));
    if (result.value.baseUrl !== "") await probeOnce(result.value.baseUrl);
  };
  const onClear = async () => {
    setBusy(true);
    setError(void 0);
    await call("config.clear");
    setBusy(false);
    setSnapshot(void 0);
    setServer(void 0);
    setMessage(t("cleared"));
    await loadConfig();
  };
  const onRefresh = async () => {
    setBusy(true);
    setError(void 0);
    const result = await call("snapshot.get", { force: true });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    applySnapshot(result.value);
    if (result.value.stale === true) setError(t("staleCache", { time: formatCachedAt(result.value.cachedAt) }));
  };
  return {
    config,
    configLoaded,
    baseUrl,
    setBaseUrl,
    passwordLoginOn,
    setPasswordLoginOn,
    currency,
    setCurrency,
    defaultContextWindow,
    setDefaultContextWindow,
    server,
    snapshot,
    staleConfirmed,
    configured,
    busy,
    syncing,
    message,
    error,
    setBusy,
    setError,
    setMessage,
    setSyncing,
    embedded,
    username,
    setUsername,
    password,
    setPassword,
    loadConfig,
    applySnapshot,
    probeOnce,
    onProbe,
    onEmbeddedLogin,
    startEmbeddedLogin,
    onEmbeddedCancel,
    onPasswordLogin,
    onSaveSettings,
    onClear,
    onRefresh
  };
}
function StatusStrip(props) {
  const { error, message, t } = props;
  if (error === void 0 && message === void 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    margin: 0,
    fontSize: 13,
    lineHeight: "20px",
    background: "var(--dsw-alias-bg-layer-1, transparent)",
    border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))",
    borderRadius: 10,
    padding: "8px 12px"
  }, children: [
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary, #d33)" }, children: [
      t("failure"),
      ": ",
      error
    ] }),
    message !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "var(--dsw-alias-state-success-primary, #3a3)" }, children: message })
  ] });
}
function SettingsToggleRow(props) {
  const { label, checked, disabled, onChange } = props;
  const labelId = (0, import_react.useId)();
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsToggleRow", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { id: labelId, children: label }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        role: "switch",
        className: "dshNewApiSettingsToggle",
        "aria-checked": checked,
        "aria-labelledby": labelId,
        disabled,
        onClick: () => {
          onChange(!checked);
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshNewApiSettingsToggleKnob", "aria-hidden": "true" })
      }
    )
  ] });
}
function NewApiPopup(props) {
  const { autoLogin, onAuthenticated } = props;
  const call = props.call ?? NOOP_CALL;
  const t = props.t ?? NOOP_T;
  const session = useNewApiSession(call, t, { autoLogin, onAuthenticated });
  const {
    config,
    configLoaded,
    baseUrl,
    server,
    snapshot,
    staleConfirmed,
    configured,
    busy,
    message,
    error,
    embedded,
    username,
    setUsername,
    password,
    setPassword,
    passwordLoginOn,
    currency,
    loadConfig,
    onEmbeddedLogin,
    startEmbeddedLogin,
    onEmbeddedCancel,
    onPasswordLogin,
    onClear,
    onRefresh
  } = session;
  const exchangeRate = snapshot?.server.usdExchangeRate ?? 0;
  const oauthProviders = server?.oauthProviders ?? [];
  const feishuName = oauthProviders.find((provider) => provider.slug === "feishu")?.name ?? (oauthProviders[0] !== void 0 ? oauthProviders[0].name : "");
  const providerLabel = feishuName !== "" ? feishuName : "NewAPI";
  if (props.call === void 0 || props.t === void 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 12, width: 380, maxWidth: "100%" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(StatusStrip, { error, message, t }),
    config === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { style: { ...cardStyle, alignItems: "center", padding: "32px 16px", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary, inherit)" }, children: configLoaded ? t("loadFailed") : t("loading") }),
      configLoaded && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", disabled: busy, onClick: () => void loadConfig(), children: t("refresh") })
    ] }) : embedded !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { style: cardStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { style: cardTitleStyle, children: t("login") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: "28px 16px",
        borderRadius: 10,
        border: "1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        textAlign: "center"
      }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "span",
          {
            "aria-hidden": true,
            style: {
              width: 22,
              height: 22,
              borderRadius: "50%",
              border: "2px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.4))",
              borderTopColor: "var(--dsw-alias-brand-primary, var(--dsw-alias-button-primary-fill, #4a6cf7))",
              animation: "dsh-newapi-spin 900ms linear infinite"
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 14, fontWeight: 500 }, children: t("embeddedWindowHint", { provider: providerLabel }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)", lineHeight: "18px" }, children: t("embeddedWaiting", { provider: providerLabel }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", disabled: busy, onClick: () => void startEmbeddedLogin(baseUrl), children: t("embeddedReopen") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", onClick: () => void onEmbeddedCancel(), children: t("embeddedCancel") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" }, children: t("embeddedCaptureNote") })
      ] })
    ] }) : !configured ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { style: cardStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { style: cardTitleStyle, children: t("login") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        import_dsh_client_ui_primitives.Button,
        {
          variant: "primary",
          disabled: busy || baseUrl.trim() === "",
          onClick: () => void onEmbeddedLogin(),
          style: { justifyContent: "center" },
          children: t("ssoButton", { provider: providerLabel })
        }
      ),
      passwordLoginOn && server?.passwordLogin === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" }, children: t("loginPassword") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          import_dsh_client_ui_primitives.Input,
          {
            value: username,
            placeholder: t("username"),
            onChange: (event) => setUsername(event.target.value),
            autoComplete: "off",
            spellCheck: false
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          import_dsh_client_ui_primitives.Input,
          {
            value: password,
            type: "password",
            placeholder: t("password"),
            onChange: (event) => setPassword(event.target.value),
            autoComplete: "off"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          import_dsh_client_ui_primitives.Button,
          {
            size: "sm",
            disabled: busy || baseUrl.trim() === "" || username.trim() === "" || password === "",
            onClick: () => void onPasswordLogin(),
            children: busy ? t("loggingIn") : t("loginButton")
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary, inherit)" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "warning" }),
        t("notConfigured")
      ] })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(StaleNote, { snapshot, confirmed: staleConfirmed, t }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { style: cardStyle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 10 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: {
            width: 34,
            height: 34,
            borderRadius: "50%",
            flex: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--dsw-alias-button-primary-fill, #4a6cf7)",
            color: "var(--dsw-alias-label-primary-foreground, #fff)"
          }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.IconUserOutline16, { size: 16 }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: snapshot?.user?.display_name ?? snapshot?.user?.username ?? String(snapshot?.user?.id ?? "--") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: snapshot?.user?.email ?? "" })
          ] }),
          snapshot?.user?.group !== void 0 && snapshot.user.group !== "" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Pill, { children: snapshot.user.group })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--dsw-alias-label-secondary, inherit)" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "done" }),
            t("popupSignedInAs")
          ] }),
          snapshot?.user?.request_count !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("popupRequests", { count: snapshot.user.request_count }) })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { style: cardStyle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { style: cardTitleStyle, children: t("popupUsageTitle") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(UsageBar, { used: snapshot?.usage.quotaUsed, total: snapshot?.usage.quotaTotal, warnLabel: t("quotaLow") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--dsw-alias-label-secondary, inherit)" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
            t("quotaUsed"),
            ": ",
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("b", { style: { fontVariantNumeric: "tabular-nums" }, children: money(snapshot?.usage.quotaUsed, currency, exchangeRate) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
            t("quotaRemaining"),
            ": ",
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("b", { style: { fontVariantNumeric: "tabular-nums" }, children: snapshot?.usage.unlimited === true ? t("unlimited") : money(snapshot?.usage.quotaRemaining, currency, exchangeRate) })
          ] })
        ] })
      ] }),
      snapshot !== void 0 && snapshot.tokens.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { style: cardStyle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { style: cardTitleStyle, children: t("popupTokenUsage") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: snapshot.tokens.map((row) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 13 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: row.name ?? String(row.id) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { flex: 1, minWidth: 12, borderBottom: "1px dotted var(--dsw-alias-border-l2, rgba(128,128,128,0.35))" } }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { flex: "none", color: "var(--dsw-alias-label-tertiary, inherit)" }, children: [
            t("tokenQuota"),
            ": ",
            formatQuota(row.quota, snapshot.server.quotaPerUnit, currency, exchangeRate, t("unlimited"))
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { flex: "none", fontVariantNumeric: "tabular-nums" }, children: [
            t("quotaUsed"),
            ": ",
            formatQuota(row.used_quota, snapshot.server.quotaPerUnit, currency, exchangeRate, t("unlimited"))
          ] })
        ] }, row.id)) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", disabled: busy, onClick: () => void onRefresh(), children: t("refresh") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", disabled: busy, onClick: () => void onClear(), children: t("clear") })
      ] })
    ] })
  ] });
}
function NewApiSettings(props) {
  const call = props.call ?? NOOP_CALL;
  const t = props.t ?? NOOP_T;
  const session = useNewApiSession(call, t);
  const {
    config,
    configLoaded,
    baseUrl,
    setBaseUrl,
    passwordLoginOn,
    setPasswordLoginOn,
    currency,
    setCurrency,
    defaultContextWindow,
    setDefaultContextWindow,
    server,
    snapshot,
    staleConfirmed,
    configured,
    busy,
    syncing,
    message,
    error,
    setBusy,
    setError,
    setMessage,
    setSyncing,
    username,
    setUsername,
    password,
    setPassword,
    embedded,
    loadConfig,
    applySnapshot,
    onProbe,
    onEmbeddedLogin,
    startEmbeddedLogin,
    onEmbeddedCancel,
    onPasswordLogin,
    onSaveSettings,
    onClear,
    onRefresh
  } = session;
  const [syncLimit, setSyncLimit] = (0, import_react.useState)("");
  const [editing, setEditing] = (0, import_react.useState)(void 0);
  const limits = config?.modelLimits ?? {};
  const selectedModels = (0, import_react.useMemo)(() => new Set(config?.selectedModels ?? []), [config]);
  const onToggleChat = async (id, selected) => {
    setBusy(true);
    setError(void 0);
    setMessage(void 0);
    const result = await call("models.setSelected", { id, selected });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setMessage(t(selected ? "addedToChat" : "removedFromChat", { model: id }));
    await loadConfig();
  };
  const [createdKey, setCreatedKey] = (0, import_react.useState)(void 0);
  const onSaveLimit = async () => {
    if (editing === void 0) return;
    const parse = (raw) => {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    setBusy(true);
    setError(void 0);
    const result = await call("models.setLimit", {
      id: editing.id,
      contextWindow: parse(editing.contextWindow),
      maxTokens: parse(editing.maxTokens),
      image: editing.image
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setMessage(t("limitSaved", { model: editing.id }));
    setEditing(void 0);
    await loadConfig();
  };
  const onCreateToken = async () => {
    setBusy(true);
    setError(void 0);
    setMessage(void 0);
    const result = await call("tokens.create", {});
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCreatedKey({ name: result.value.name, key: result.value.key });
    const refreshed = await call("snapshot.get", { force: true });
    if (refreshed.ok) applySnapshot(refreshed.value);
    else setError(refreshed.error.message);
  };
  const onCopyKey = async (key) => {
    try {
      await navigator.clipboard.writeText(key);
      setMessage(t("keyCopied"));
    } catch {
      setError(t("keyCopyFailed"));
    }
  };
  const onSync = async () => {
    if (!configured) {
      setError(t("syncNeedsConfig"));
      return;
    }
    setSyncing(true);
    setError(void 0);
    setMessage(void 0);
    const limit = Number.parseInt(syncLimit, 10);
    const payload = Number.isFinite(limit) && limit > 0 ? { limit } : {};
    const result = await call("models.sync", payload);
    setSyncing(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setMessage(t("synced", { count: result.value.count, route: result.value.route }));
  };
  const models = (0, import_react.useMemo)(() => snapshot?.models ?? [], [snapshot]);
  const exchangeRate = snapshot?.server.usdExchangeRate ?? 0;
  const oauthProviders = server?.oauthProviders ?? [];
  const feishuName = oauthProviders.find((provider) => provider.slug === "feishu")?.name ?? (oauthProviders[0] !== void 0 ? oauthProviders[0].name : "");
  const providerLabel = feishuName !== "" ? feishuName : "NewAPI";
  if (props.call === void 0 || props.t === void 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettings", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dshNewApiSettingsHeader", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { children: t("nav") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { children: t("intro") })
    ] }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { className: "dshNewApiSettingsError", role: "alert", children: [
      t("failure"),
      ": ",
      error
    ] }),
    message !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsSuccess", role: "status", children: message }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshNewApiSettingsGroup", "aria-label": t("baseUrl"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { children: t("baseUrl") }),
        config?.baseUrlDefault !== void 0 && config.baseUrlDefault !== "" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsIntro", children: t("defaultServer", { url: config.baseUrlDefault }) })
      ] }),
      config === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsHint", children: configLoaded ? t("loadFailed") : t("loading") }),
        configLoaded && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton", disabled: busy, onClick: () => {
          void loadConfig();
        }, children: t("refresh") })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_jsx_runtime2.Fragment, { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "form",
        {
          className: "dshNewApiSettingsCard",
          onSubmit: (event) => {
            event.preventDefault();
            void onSaveSettings();
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshNewApiSettingsField", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { "aria-hidden": "true", children: t("baseUrl") }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshNewApiSettingsForm", style: { flexWrap: "nowrap" }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "input",
                  {
                    className: "dshNewApiSettingsInput",
                    value: baseUrl,
                    placeholder: config.baseUrlDefault !== "" ? config.baseUrlDefault : t("baseUrlPlaceholder"),
                    onChange: (event) => setBaseUrl(event.target.value),
                    spellCheck: false,
                    autoComplete: "off"
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "button",
                  {
                    type: "button",
                    className: "dshNewApiSettingsButton dshNewApiSettingsButtonSecondary",
                    disabled: busy || baseUrl.trim() === "",
                    onClick: () => {
                      void onProbe();
                    },
                    children: busy ? t("probing") : t("probe")
                  }
                )
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsRow2", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshNewApiSettingsField", children: [
                t("currencyLabel"),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                  "select",
                  {
                    className: "dshNewApiSettingsInput",
                    value: currency,
                    onChange: (event) => {
                      const next = event.target.value;
                      setCurrency(next === "usd" ? "usd" : "cny");
                    },
                    children: [
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "cny", children: t("currencyCny") }),
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: "usd", children: t("currencyUsd") })
                    ]
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshNewApiSettingsField", children: [
                t("defaultContextWindowLabel"),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "input",
                  {
                    className: "dshNewApiSettingsInput",
                    value: defaultContextWindow,
                    placeholder: "131072",
                    onChange: (event) => setDefaultContextWindow(event.target.value),
                    inputMode: "numeric",
                    spellCheck: false
                  }
                )
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              SettingsToggleRow,
              {
                label: t("enablePasswordLogin"),
                checked: passwordLoginOn,
                disabled: busy,
                onChange: setPasswordLoginOn
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsCardFooter", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "submit", className: "dshNewApiSettingsSave", disabled: busy, children: t("saveSettings") }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshNewApiSettingsHint", style: { margin: 0, flex: 1, minWidth: 200 }, children: t("saveScopeHint") }),
              server !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshNewApiSettingsStatus", children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.StateDot, { state: "done" }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { children: [
                  server.systemName,
                  " ",
                  server.version !== "" ? `(${server.version})` : ""
                ] }),
                oauthProviders.map((provider) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Pill, { children: provider.name }, provider.slug))
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsHint", style: { margin: 0 }, children: t("defaultContextWindowHint") })
          ]
        }
      ) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshNewApiSettingsGroup", "aria-label": t("login"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { children: t("login") }) }),
      embedded !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { className: "dshNewApiSettingsHint", children: [
          t("embeddedWindowHint", { provider: providerLabel }),
          " \u2014 ",
          t("embeddedWaiting", { provider: providerLabel })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsActions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton", disabled: busy, onClick: () => {
            void startEmbeddedLogin(baseUrl);
          }, children: t("embeddedReopen") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton dshNewApiSettingsButtonSecondary", onClick: () => {
            void onEmbeddedCancel();
          }, children: t("embeddedCancel") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsNotice", children: t("embeddedCaptureNote") })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsActions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              className: "dshNewApiSettingsButton",
              disabled: busy || baseUrl.trim() === "",
              onClick: () => {
                void onEmbeddedLogin();
              },
              children: t("ssoButton", { provider: providerLabel })
            }
          ),
          config !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton dshNewApiSettingsButtonSecondary", disabled: busy, onClick: () => {
            void onClear();
          }, children: t("clear") }),
          config !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshNewApiSettingsStatus", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.StateDot, { state: configured ? "done" : "warning" }),
            configured ? t("saved") : t("notConfigured")
          ] })
        ] }),
        passwordLoginOn && server?.passwordLogin === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          "form",
          {
            className: "dshNewApiSettingsForm",
            onSubmit: (event) => {
              event.preventDefault();
              void onPasswordLogin();
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshNewApiSettingsField dshNewApiSettingsFieldNarrow", children: [
                t("username"),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "input",
                  {
                    className: "dshNewApiSettingsInput",
                    value: username,
                    onChange: (event) => setUsername(event.target.value),
                    autoComplete: "off",
                    spellCheck: false,
                    style: { width: 160 }
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshNewApiSettingsField dshNewApiSettingsFieldNarrow", children: [
                t("password"),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "input",
                  {
                    className: "dshNewApiSettingsInput",
                    type: "password",
                    value: password,
                    onChange: (event) => setPassword(event.target.value),
                    autoComplete: "off",
                    style: { width: 160 }
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "button",
                {
                  type: "submit",
                  className: "dshNewApiSettingsButton",
                  disabled: busy || baseUrl.trim() === "" || username.trim() === "" || password === "",
                  children: busy ? t("loggingIn") : t("loginButton")
                }
              )
            ]
          }
        )
      ] })
    ] }),
    snapshot === void 0 && configured && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("section", { className: "dshNewApiSettingsGroup", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsHint", style: { margin: 0 }, children: t("loading") }) }),
    snapshot !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(StaleNote, { snapshot, confirmed: staleConfirmed, t }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshNewApiSettingsGroup", "aria-label": t("account"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { children: t("account") }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshNewApiSettingsActions", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton dshNewApiSettingsButtonSecondary", disabled: busy, onClick: () => {
          void onRefresh();
        }, children: t("refresh") }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsHint", style: { margin: 0 }, children: t("popupUsageTitle") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(UsageBar, { used: snapshot.usage.quotaUsed, total: snapshot.usage.quotaTotal, warnLabel: t("quotaLow") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("dl", { className: "dshNewApiSettingsDl", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("usernameLabel") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("dd", { children: [
            snapshot.user?.display_name ?? snapshot.user?.username ?? String(snapshot.user?.id ?? "--"),
            snapshot.user?.email !== void 0 && snapshot.user.email !== "" ? ` <${snapshot.user.email}>` : ""
          ] }),
          config?.accessTokenMasked !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("accessTokenLabel") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("dd", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { style: { fontSize: 12 }, children: config.accessTokenMasked }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { color: "var(--dsw-alias-label-tertiary, inherit)", fontSize: 12 }, children: t("accessTokenHint") })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("group") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: snapshot.user?.group ?? "--" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("requests") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: snapshot.user?.request_count ?? "--" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("quotaUsed") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: money(snapshot.usage.quotaUsed, currency, exchangeRate) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("quotaRemaining") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: snapshot.usage.unlimited === true ? t("unlimited") : money(snapshot.usage.quotaRemaining, currency, exchangeRate) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dt", { children: t("quotaTotal") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("dd", { children: snapshot.usage.unlimited === true ? t("unlimited") : money(snapshot.usage.quotaTotal, currency, exchangeRate) })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshNewApiSettingsGroup", "aria-label": t("tokens"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsActions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { style: { margin: 0, flex: 1 }, children: t("tokens") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton", disabled: busy, onClick: () => {
            void onCreateToken();
          }, children: t("createToken") })
        ] }),
        createdKey !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsKeyOnce", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: t("keyCreatedOnce", { name: createdKey.name }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: createdKey.key }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton", onClick: () => {
            void onCopyKey(createdKey.key);
          }, children: t("copyKey") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton dshNewApiSettingsButtonSecondary", onClick: () => setCreatedKey(void 0), children: t("close") })
        ] }),
        snapshot.tokens.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsHint", children: t("noTokensHint") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshNewApiSettingsTableWrap", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("table", { className: "dshNewApiSettingsTable", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tokenName") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tokenKey") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tokenQuota") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tokenUsed") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tokenExpires") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("tokenModels") })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("tbody", { children: snapshot.tokens.map((row) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: row.name ?? String(row.id) }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("code", { style: { fontFamily: "monospace", color: "var(--dsw-alias-label-secondary, inherit)" }, children: [
              "\u2022\u2022\u2022\u2022",
              row.key !== void 0 ? row.key.slice(-4) : "????"
            ] }) }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: formatQuota(row.quota, snapshot.server.quotaPerUnit, currency, exchangeRate, t("unlimited")) }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: formatQuota(row.used_quota, snapshot.server.quotaPerUnit, currency, exchangeRate, t("unlimited")) }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: formatDate(row.expired_time) }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: row.models === void 0 || row.models === "" || row.models === "-1" || row.models === "*" ? t("tokenAllModels") : row.models })
          ] }, row.id)) })
        ] }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshNewApiSettingsGroup", "aria-label": t("models"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsActions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { style: { margin: 0, flex: 1 }, children: t("models") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives.Pill, { children: t("modelsCount", { count: models.length }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsHint", children: t("modelsNoneSelectedHint") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshNewApiSettingsTableWrap", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("table", { className: "dshNewApiSettingsTable", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("modelId") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("modelInput") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("modelOutput") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("modelLimits") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("modelImage") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", { children: t("modelChat") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("th", {})
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("tbody", { children: models.map((model) => {
            const storedLimit = limits[model.id];
            const editingThis = editing?.id === model.id;
            return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { style: { fontFamily: "monospace" }, children: model.id }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: model.priced === true ? formatPrice(model.inputPrice, currency, exchangeRate) : "--" }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { children: model.priced === true ? formatPrice(model.outputPrice, currency, exchangeRate) : "--" }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { style: { whiteSpace: "nowrap" }, children: editingThis && editing !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "input",
                  {
                    className: "dshNewApiSettingsInput",
                    value: editing.contextWindow,
                    placeholder: t("contextWindow"),
                    title: t("contextWindow"),
                    onChange: (event) => setEditing({ ...editing, contextWindow: event.target.value }),
                    style: { width: 96 },
                    inputMode: "numeric",
                    spellCheck: false
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "var(--dsw-alias-label-tertiary, inherit)" }, children: "/" }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "input",
                  {
                    className: "dshNewApiSettingsInput",
                    value: editing.maxTokens,
                    placeholder: t("maxOutputTokens"),
                    title: t("maxOutputTokens"),
                    onChange: (event) => setEditing({ ...editing, maxTokens: event.target.value }),
                    style: { width: 96 },
                    inputMode: "numeric",
                    spellCheck: false
                  }
                )
              ] }) : storedLimit === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "span",
                {
                  style: { color: "var(--dsw-alias-label-tertiary, inherit)", cursor: "pointer", borderBottom: "1px dashed var(--dsw-alias-label-tertiary, rgba(128,128,128,0.5))" },
                  onClick: () => {
                    setEditing({
                      id: model.id,
                      contextWindow: String(config?.defaultContextWindow ?? 131072),
                      maxTokens: "",
                      image: true
                    });
                  },
                  children: t("defaultLimitDisplay", { window: String(config?.defaultContextWindow ?? 131072) })
                }
              ) : `${storedLimit.contextWindow !== void 0 ? String(storedLimit.contextWindow) : "?"} / ${storedLimit.maxTokens !== void 0 ? String(storedLimit.maxTokens) : "?"}` }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { style: { whiteSpace: "nowrap" }, children: editingThis && editing !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { title: t("modelImage"), style: { display: "inline-flex", alignItems: "center", cursor: "pointer" }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "input",
                {
                  type: "checkbox",
                  checked: editing.image,
                  onChange: (event) => setEditing({ ...editing, image: event.target.checked })
                }
              ) }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "span",
                {
                  title: t("modelImage"),
                  style: { color: storedLimit?.image === false ? "var(--dsw-alias-label-tertiary, inherit)" : "inherit" },
                  children: storedLimit?.image === false ? "\u2014" : "\u2713"
                }
              ) }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { style: { whiteSpace: "nowrap" }, children: selectedModels.has(model.id) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "button",
                {
                  type: "button",
                  className: "dshNewApiSettingsButton dshNewApiSettingsButtonSecondary",
                  disabled: busy,
                  title: t("removeFromChat"),
                  onClick: () => {
                    void onToggleChat(model.id, false);
                  },
                  children: t("removeFromChat")
                }
              ) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "button",
                {
                  type: "button",
                  className: "dshNewApiSettingsButton",
                  disabled: busy || !configured,
                  title: t("addToChat"),
                  onClick: () => {
                    void onToggleChat(model.id, true);
                  },
                  children: t("addToChat")
                }
              ) }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { style: { whiteSpace: "nowrap" }, children: editingThis ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { display: "inline-flex", gap: 6 }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton", disabled: busy, onClick: () => {
                  void onSaveLimit();
                }, children: t("saveLimit") }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton dshNewApiSettingsButtonSecondary", disabled: busy, onClick: () => {
                  setEditing(void 0);
                }, children: t("cancelLimit") })
              ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "button",
                {
                  type: "button",
                  className: "dshNewApiSettingsButton",
                  disabled: busy,
                  onClick: () => {
                    setEditing({
                      id: model.id,
                      contextWindow: storedLimit?.contextWindow !== void 0 ? String(storedLimit.contextWindow) : "",
                      maxTokens: storedLimit?.maxTokens !== void 0 ? String(storedLimit.maxTokens) : "",
                      image: storedLimit?.image !== false
                    });
                  },
                  children: t("editLimit")
                }
              ) })
            ] }, model.id);
          }) })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshNewApiSettingsForm", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshNewApiSettingsButton", disabled: syncing || models.length === 0, onClick: () => {
            void onSync();
          }, children: syncing ? t("syncing") : t("sync") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshNewApiSettingsField dshNewApiSettingsFieldNarrow", children: [
            t("syncLimit"),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "input",
              {
                className: "dshNewApiSettingsInput",
                value: syncLimit,
                placeholder: t("syncLimit"),
                onChange: (event) => setSyncLimit(event.target.value),
                style: { width: 140 },
                inputMode: "numeric"
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshNewApiSettingsHint", children: t("limitHint") })
      ] })
    ] })
  ] });
}

		return module.exports;
	}
});
