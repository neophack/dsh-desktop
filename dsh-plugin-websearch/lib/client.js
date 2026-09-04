window.__ModuleLoader__.load({
	id: "dsh-plugin-websearch",
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
var import_jsx_runtime2 = require("react/jsx-runtime");
var NS = "settings.websearch";
var SETTINGS_NAMESPACE = "websearch";
var ENGINES = ["bing", "duckduckgo"];
var inject = ["slots", "locale", "settingsScope"];
var NOOP_T = (key) => key;
function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "websearch: copy dictionaries");
  ctx.effect(injectSettingsStyle, "websearch: settings page styles");
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
  const describe = ctx.settingsScope.describe();
  describe.ensure?.();
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "websearch",
    order: 16,
    label: () => t("nav"),
    inject: () => ({ t, scope, describe })
  }, WebSearchSettings));
}
var zh = {
  nav: "\u7F51\u9875\u641C\u7D22",
  intro: "\u901A\u8FC7\u81EA\u5EFA Crawl4AI \u670D\u52A1\u5668\u6293\u53D6\u641C\u7D22\u5F15\u64CE\u7ED3\u679C\u9875, \u4E3A\u5BF9\u8BDD\u63D0\u4F9B\u7F51\u9875\u641C\u7D22; \u6B64\u5904\u53EF\u4FEE\u6539\u670D\u52A1\u5668\u5730\u5740\u3001\u5F15\u64CE\u4E0E\u8BBF\u95EE\u4EE4\u724C\u3002",
  serverGroup: "Crawl4AI \u670D\u52A1\u5668",
  baseUrl: "\u670D\u52A1\u5668\u5730\u5740",
  baseUrlHint: "\u9ED8\u8BA4 {url}; \u6E05\u7A7A\u5219\u6062\u590D\u9ED8\u8BA4\u3002",
  apiToken: "\u8BBF\u95EE\u4EE4\u724C",
  apiTokenHint: "\u670D\u52A1\u5668\u5F00\u542F\u9274\u6743\u65F6\u5FC5\u586B (\u5BF9\u5E94 CRAWL4AI_API_TOKEN); \u4EE4\u724C\u4E0D\u4F1A\u56DE\u663E\u3002",
  apiTokenSet: "\u5DF2\u914D\u7F6E",
  apiTokenUnset: "\u672A\u914D\u7F6E",
  clearToken: "\u6E05\u9664\u4EE4\u724C",
  searchGroup: "\u641C\u7D22",
  engine: "\u641C\u7D22\u5F15\u64CE",
  engineHint: "\u7ED3\u679C\u9875\u88AB\u6293\u53D6\u7684\u5F15\u64CE; \u6392\u7248\u53D8\u5316\u5BFC\u81F4\u65E0\u7ED3\u679C\u65F6\u53EF\u5207\u6362\u53E6\u4E00\u4E2A\u3002",
  engineBing: "\u5FC5\u5E94 (Bing)",
  engineDuckduckgo: "DuckDuckGo",
  timeout: "\u8D85\u65F6 (\u6BEB\u79D2)",
  timeoutHint: "\u5355\u6B21\u641C\u7D22\u8BF7\u6C42\u7684\u8D85\u65F6, \u9ED8\u8BA4 60000; \u6700\u5C0F 1000\u3002",
  overridden: "\u5DF2\u8986\u76D6",
  reset: "\u6062\u590D\u9ED8\u8BA4",
  invalidTimeout: "\u8D85\u65F6\u9700\u4E3A\u4E0D\u5C0F\u4E8E 1000 \u7684\u6574\u6570",
  save: "\u4FDD\u5B58\u8BBE\u7F6E",
  saving: "\u4FDD\u5B58\u4E2D...",
  saved: "\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\u3002",
  saveFailed: "\u4FDD\u5B58\u5931\u8D25: {message}",
  unavailable: "\u7F51\u9875\u641C\u7D22\u670D\u52A1\u672A\u542F\u7528 (\u672A\u52A0\u8F7D dsh-plugin-websearch)\u3002",
  readonly: "\u8BBE\u7F6E\u6587\u6863\u5F53\u524D\u53EA\u8BFB, \u65E0\u6CD5\u4FDD\u5B58\u3002"
};
var en = {
  nav: "Web search",
  intro: "Web search for chat runs through a self-hosted Crawl4AI server; adjust the server address, engine, and access token here.",
  serverGroup: "Crawl4AI server",
  baseUrl: "Server URL",
  baseUrlHint: "Default {url}; clearing the field restores the default.",
  apiToken: "Access token",
  apiTokenHint: "Required when the server enforces authentication (its CRAWL4AI_API_TOKEN); the stored token is never echoed back.",
  apiTokenSet: "Configured",
  apiTokenUnset: "Not set",
  clearToken: "Clear token",
  searchGroup: "Search",
  engine: "Search engine",
  engineHint: "The engine whose results page is crawled; switch engines when a markup change yields no results.",
  engineBing: "Bing",
  engineDuckduckgo: "DuckDuckGo",
  timeout: "Timeout (ms)",
  timeoutHint: "Per-request timeout, default 60000; minimum 1000.",
  overridden: "Overridden",
  reset: "Reset",
  invalidTimeout: "Timeout must be an integer of at least 1000",
  save: "Save settings",
  saving: "Saving...",
  saved: "Settings saved.",
  saveFailed: "Save failed: {message}",
  unavailable: "The web search service is not enabled (dsh-plugin-websearch not loaded).",
  readonly: "The settings document is read-only right now; nothing can be saved."
};
var SETTINGS_STYLE_TAG = "dsh-plugin-websearch/settings-styles";
var SETTINGS_CSS = `
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
function useScopeSnapshot(scope) {
  const [snapshot, setSnapshot] = (0, import_react.useState)(() => scope.getSnapshot());
  (0, import_react.useEffect)(() => scope.subscribe(() => {
    setSnapshot(scope.getSnapshot());
  }), [scope]);
  return snapshot;
}
function describeRowOf(describe) {
  return describe?.getSnapshot().view?.namespaces.find((candidate) => candidate.ns === SETTINGS_NAMESPACE);
}
function useDescribeRow(describe) {
  const [row, setRow] = (0, import_react.useState)(() => describeRowOf(describe));
  (0, import_react.useEffect)(() => describe?.subscribe(() => {
    setRow(describeRowOf(describe));
  }), [describe]);
  return row;
}
function userHasField(user, field) {
  return typeof user === "object" && user !== null && field in user;
}
function WebSearchSettings(props) {
  const t = props.t ?? NOOP_T;
  const scope = props.scope;
  const snapshot = useScopeSnapshot(scope ?? FALLBACK_SCOPE);
  const describeRow = useDescribeRow(props.describe);
  const tokenConfigured = describeRow?.secrets.some((secret) => secret.path[0] === "apiToken" && secret.set) === true;
  const effective = snapshot.value;
  const [baseUrl, setBaseUrl] = (0, import_react.useState)("");
  const [engine, setEngine] = (0, import_react.useState)("bing");
  const [timeout, setTimeoutText] = (0, import_react.useState)("");
  const [token, setToken] = (0, import_react.useState)("");
  const [tokenCleared, setTokenCleared] = (0, import_react.useState)(false);
  const [seeded, setSeeded] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [justSaved, setJustSaved] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const seededRef = (0, import_react.useRef)(false);
  const baseSection = snapshot.base;
  const defaultEngine = typeof baseSection?.engine === "string" ? baseSection.engine : "bing";
  const defaultBaseUrl = typeof baseSection?.baseUrl === "string" ? baseSection.baseUrl : "http://172.24.204.251:21235";
  const seed = (section) => {
    setBaseUrl(section.baseUrl ?? "");
    setEngine(section.engine ?? defaultEngine);
    setTimeoutText(section.timeoutMs !== void 0 ? String(section.timeoutMs) : "");
    setToken("");
    setTokenCleared(false);
    setSeeded(true);
  };
  (0, import_react.useEffect)(() => {
    if (scope === void 0 || snapshot.status !== "ready" || effective === void 0) return;
    if (seededRef.current) return;
    seededRef.current = true;
    seed(effective);
  }, [snapshot.status, effective, scope, defaultEngine]);
  if (scope === void 0) return null;
  if (snapshot.status === "unavailable") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshWebsearchSettings", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dshWebsearchSettingsUnavailable", children: t("unavailable") }) });
  }
  if (snapshot.status === "loading" || !seeded) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshWebsearchSettings", "aria-busy": "true" });
  }
  const disabled = !snapshot.writable || busy;
  const trimmedTimeout = timeout.trim();
  let timeoutInvalid = false;
  if (trimmedTimeout !== "") {
    const parsedTimeout = Number.parseInt(trimmedTimeout, 10);
    timeoutInvalid = !Number.isFinite(parsedTimeout) || parsedTimeout < 1e3;
  }
  const trimmedBaseUrl = baseUrl.trim();
  const tokenStaged = token.trim() !== "";
  const changed = trimmedBaseUrl !== (effective.baseUrl ?? "") || engine !== (effective.engine ?? defaultEngine) || trimmedTimeout !== (effective.timeoutMs !== void 0 ? String(effective.timeoutMs) : "") || tokenStaged || tokenCleared;
  const blocked = disabled || timeoutInvalid || !changed;
  const save = () => {
    if (blocked) return;
    setBusy(true);
    setError(void 0);
    void (async () => {
      try {
        if (trimmedBaseUrl === "") await scope.unset("baseUrl");
        else if (trimmedBaseUrl !== (effective.baseUrl ?? "")) await scope.set("baseUrl", trimmedBaseUrl);
        if (engine !== (effective.engine ?? defaultEngine)) await scope.set("engine", engine);
        if (trimmedTimeout === "") await scope.unset("timeoutMs");
        else if (trimmedTimeout !== (effective.timeoutMs !== void 0 ? String(effective.timeoutMs) : "")) {
          await scope.set("timeoutMs", Number.parseInt(trimmedTimeout, 10));
        }
        if (tokenCleared && !tokenStaged) await scope.unset("apiToken");
        else if (tokenStaged) await scope.set("apiToken", token.trim());
        const fresh = scope.getSnapshot().value;
        if (fresh !== void 0) seed(fresh);
        setJustSaved(true);
      } catch (cause) {
        setError(t("saveFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        setBusy(false);
      }
    })();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshWebsearchSettings", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "dshWebsearchSettingsHeader", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h2", { children: t("nav") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { children: t("intro") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshWebsearchSettingsGroup", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { children: t("serverGroup") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshWebsearchSettingsCard", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshWebsearchSettingsField", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshWebsearchSettingsLabel", children: [
            t("baseUrl"),
            userHasField(snapshot.user, "baseUrl") ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsBadge", children: t("overridden") }) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "input",
            {
              className: "dshWebsearchSettingsInput",
              value: baseUrl,
              placeholder: defaultBaseUrl,
              disabled,
              spellCheck: false,
              onChange: (event) => {
                setBaseUrl(event.target.value);
                setJustSaved(false);
              }
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsHint", children: t("baseUrlHint", { url: defaultBaseUrl }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshWebsearchSettingsField", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshWebsearchSettingsLabel", children: [
            t("apiToken"),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsBadge", children: tokenCleared || !tokenConfigured ? t("apiTokenUnset") : t("apiTokenSet") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshWebsearchSettingsTokenRow", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "input",
              {
                className: "dshWebsearchSettingsInput",
                type: "password",
                value: token,
                placeholder: tokenCleared || !tokenConfigured ? "" : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
                disabled,
                autoComplete: "off",
                onChange: (event) => {
                  setToken(event.target.value);
                  setTokenCleared(false);
                  setJustSaved(false);
                }
              }
            ),
            tokenConfigured ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "button",
              {
                type: "button",
                className: "dshWebsearchSettingsButton",
                disabled,
                onClick: () => {
                  setToken("");
                  setTokenCleared(!tokenCleared);
                  setJustSaved(false);
                },
                children: t("clearToken")
              }
            ) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsHint", children: t("apiTokenHint") })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "dshWebsearchSettingsGroup", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { children: t("searchGroup") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshWebsearchSettingsCard", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshWebsearchSettingsField", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshWebsearchSettingsLabel", children: [
            t("engine"),
            userHasField(snapshot.user, "engine") ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsBadge", children: t("overridden") }) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "select",
            {
              className: "dshWebsearchSettingsSelect",
              value: engine,
              disabled,
              onChange: (event) => {
                setEngine(event.target.value);
                setJustSaved(false);
              },
              children: ENGINES.map((id) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: id, children: id === "bing" ? t("engineBing") : t("engineDuckduckgo") }, id))
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsHint", children: t("engineHint") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dshWebsearchSettingsField", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshWebsearchSettingsLabel", children: [
            t("timeout"),
            userHasField(snapshot.user, "timeoutMs") ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsBadge", children: t("overridden") }) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "input",
            {
              className: "dshWebsearchSettingsInput",
              value: timeout,
              inputMode: "numeric",
              disabled,
              onChange: (event) => {
                setTimeoutText(event.target.value);
                setJustSaved(false);
              }
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsHint", style: timeoutInvalid ? { color: "var(--dsw-alias-state-error-primary)" } : void 0, children: timeoutInvalid ? t("invalidTimeout") : t("timeoutHint") })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshWebsearchSettingsCard", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshWebsearchSettingsFooter", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dshWebsearchSettingsSave", disabled: blocked, onClick: save, children: busy ? t("saving") : t("save") }),
      justSaved && error === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsSaved", role: "status", children: t("saved") }) : null,
      error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsError", role: "alert", children: error }) : null,
      !snapshot.writable ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshWebsearchSettingsError", children: t("readonly") }) : null
    ] }) })
  ] });
}
var FALLBACK_SCOPE = {
  getSnapshot: () => ({ status: "loading", value: void 0, base: void 0, user: void 0, revision: void 0, writable: false, mode: "host" }),
  subscribe: () => () => {
  },
  set: async () => {
  },
  unset: async () => {
  }
};

		return module.exports;
	}
});
