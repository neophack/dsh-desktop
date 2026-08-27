# dsh-plugin-newapi

[中文](README.zh.md) | English

A [DSH](https://github.com/deepseek-ai/deepseek-harness) / DSH Desktop plugin that connects a [NewAPI](https://github.com/Calcium-Ion/new-api) gateway to your assistant:

- **Sign in** to your NewAPI console: embedded zero-paste SSO for Feishu and other custom OAuth providers, plus fully-automatic password login (see below).
- **Browse** your API keys (tokens), the models your account can use, and per-model pricing.
- **Track quota** — used / remaining / total (USD plus a local-currency reference at the server's exchange rate), including unlimited-plan accounts; request counts and account details included.
- **Sync models into chat** — one click writes the model list into the official `llm-pi-ai` provider catalog, so every synced model shows up in the normal chat model selector. No patched runtime, no private APIs.

## Signing in

NewAPI v1.0.0-rc.x authenticates with a `session` cookie plus a short-lived Bearer minted by `POST /api/user/auth/refresh`. The plugin supports two paths:

1. **Dedicated sign-in window (the default and only entry, zero copy-paste)** — clicking *Sign in with Feishu* first mints the OAuth state server-side, then opens the **Feishu authorize page** in its own top-level login window (the redirect_uri points back at the server itself, so the exchange always succeeds — no admin configuration at all). After the QR authorization the session cookie lands in DSH Desktop's Electron default session via a top-level redirect — cross-site iframe XHR Set-Cookies are dropped by the browser's SameSite rules, which is why the window is top-level — where the Host picks it up, verifies it, and persists it; plan/usage data is fetched automatically and an **API key is ensured** (created when the account has none, first one used otherwise) into the chat credential ref. Closing the window early surfaces an immediate "sign-in did not complete" and can be retried at any time. Desktop-app only; a plain `dsh` CLI Host reports the capability as unavailable.
2. **Password sign-in** (when the server enables it): enter username/password; the plugin performs login → refresh → persists the session, then auto-renews it.

> Why not run the OAuth callback inside the plugin? NewAPI hardcodes the code-exchange redirect_uri from its ServerAddress system setting (`oauth/generic.go`), and Feishu requires the authorize and exchange redirect URLs to match, so no plugin-owned callback URL can ever complete the exchange. Letting the server's own login page run natively and capturing the cookie from the Electron session is the only path that needs neither server changes nor copy-paste.

## How it works

The plugin is composed of two halves, exactly like official DSH plugins:

- **Host half** (`lib/index.js`) — a Cordis plugin that owns a `newapi` settings namespace, stores the access token through the credentials service (never in `settings.yaml` or `cordis.yml`), talks to the NewAPI management API (`/api/user/self`, `/api/token/`, `/api/user/models`, `/api/pricing`), and exposes a loopback-fenced Connection RPC channel `/newapi` for the UI.
- **Browser half** (`lib/client.js`) — a `settings.section` slot contribution (the "NewAPI" page in Settings) built on the shared UI primitives.

Model sync deliberately does **not** register a parallel LLM adapter. It writes a provider profile into the shipped `@deepseek-ai/dsh-llm-pi-ai` settings namespace (`providers.<route>`), which is the official way to add an OpenAI-compatible gateway route. The chat model selector, catalog joins, and retry policies all keep working unchanged. The token is referenced by env name, not copied.

Quota values are converted with the server-reported `quota_per_unit` from `/api/status` (default 500,000, i.e. $1 = 500,000 units); USD amounts also show a local-currency reference using `usd_exchange_rate`.

## Install

From a plugin market (if listed), or from a terminal inside DSH Desktop:

```sh
dsh plugin --profile desktop add dsh-plugin-newapi
```

For local development:

```sh
dsh plugin --profile desktop add file:E:/dsh-desktop/dsh-plugin-newapi
```

Restart DSH Desktop after installing.

## Configuration

Defaults are fine for most setups. To customize, edit the plugin's `cordis.patch.yml` (or override the loader row in your profile):

```yaml
- insert:
    - id: newapi
      name: dsh-plugin-newapi
      config:
        route: newapi            # provider route id in the LLM catalog
        apiKeyEnv: NEWAPI_API_KEY # credential ref storing the chat API key
        displayName: NewAPI       # label shown in model pickers
        baseUrl: http://172.24.204.251:4000  # pinned console origin; the UI stops asking
        passwordLogin: false      # off by default; shows the username/password form when true
```

Then open **Settings → NewAPI** (or the sidebar login button). With `baseUrl` pinned the server address is fixed and the primary button goes straight to the provider (Feishu) authorize page; sign in as described under *Signing in*.

## Security notes

- The credential (access token or session value) lives only in the local credentials store (`$DSH_HOME/.credentials.yaml`, 0600) under the `NEWAPI_API_KEY` reference.
- Key material is never sent to the renderer; the token list is masked to the last 4 characters.
- The `/newapi` RPC channel is loopback-authority only, same as the built-in settings surface.
- Sessions renewed mid-flight are persisted back by the Host automatically.
- The embedded sign-in's cookie capture runs only while you explicitly keep the sign-in page open, reads exactly one cookie (`session`) for the configured server origin, and stores it after verifying it against the server; the watch stops as soon as the attempt settles. It relies on the DSH Desktop Electron session and disables itself in ordinary CLI Hosts.

## Develop

```sh
npm install            # esbuild only
npm run build          # -> lib/index.js + lib/client.js + lib/types
npm test               # mock-server smoke checks + client bundle shape check + login-flow regression
```

## Publish (checklist)

- `npm publish` (the package has no lifecycle scripts; `files` ships only `lib/`, the patch YAML, and READMEs).
- Submit a PR to the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) curated list to appear in community market UIs; keep the npm `repository` field pointing at the same repo.

## License

MIT
