# dsh-plugin-newapi

中文 | [English](README.md)

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) / DSH Desktop 插件，把 [NewAPI](https://github.com/Calcium-Ion/new-api) 网关接入你的助手：

- **登录** NewAPI 控制台：飞书等自定义 OAuth/SSO 内嵌登录、零复制粘贴；密码登录全自动（见下）。
- **查看** 你的 API 密钥（令牌）、账号可用的模型列表与单价。
- **额度用量**：已用 / 剩余 / 总量（美元 + 按服务器汇率折算），支持不限量套餐，显示请求数与账号详情。
- **一键同步模型到对话**：把模型列表写入官方 `llm-pi-ai` 提供方目录，之后在正常的聊天模型选择器里就能选到。不改运行时、不碰私有接口。

## 登录方式

登录动作本身走 NewAPI 的浏览器流程（`session` cookie + 短期 Bearer），但插件最终保存的持久凭据是**长效系统访问令牌**（「访问令牌」）：登录成功后 Host 优先复用本地缓存、且仍能认证同一账号的令牌；没有缓存（或已失效）时通过 `GET /api/user/token` 新建一个（该值仅显示一次，且重新生成会使旧令牌全部失效——所以只在必要时生成一次并缓存）。之后所有数据读取（用量、密钥、模型、定价）直接携带 `Authorization: Bearer <访问令牌>`——不再构造 cookie，也不再触碰限速敏感的 `POST /api/user/auth/refresh` 换发接口，避免被服务器 429。仍持有 cookie 凭据的存量安装会在启动时自动迁移。若令牌之后在服务端被替换（其他设备登录、或在网页上重新生成），插件不会去「抢」：下一次读取会直接退出登录（聊天 API key 相互独立、不受影响），由你重新登录获取新令牌——多个登录方各自自动重铸会令单例令牌无限轮换，把服务器打成 429。登录握手支持两条路：

1. **独立登录窗口（默认且唯一入口，零复制粘贴）**：点「使用飞书登录」后，插件先在服务端创建 OAuth state，再把**飞书授权页**在独立弹出的登录窗口中打开（redirect_uri 指回服务器自身，交换必然成功，无需任何管理端配置）。扫码授权后 session cookie 以顶级导航落入 DSH Desktop 的 Electron 默认会话（跨站 iframe 内的 XHR Set-Cookie 会被浏览器的 SameSite 规则丢弃，所以必须是独立窗口），Host 侧自动读取、验证并持久化；随后自动拉取套餐/用量，并**自动确保一个 API key**（账号没有 key 就新建一个，有就用第一个）存入聊天凭据引用。登录窗口提前关闭会立刻反馈「登录未完成」，可随时重试。仅在 DSH Desktop 内可用（需要 Electron 会话访问权）；普通 `dsh` CLI 环境会提示不支持。
2. **密码登录**（服务器开启密码登录时可用）：填用户名密码，插件自动完成 login → refresh → 存储会话，之后自动续期。

> 为什么不在插件里直接跑 OAuth 回调？NewAPI 在交换授权码时把 redirect_uri 写死为系统设置里的「服务器地址」（`oauth/generic.go`），而飞书要求授权与交换地址一致，所以任何插件侧回调地址都换不到 token。让服务器自己的登录页在原生上下文完成登录、再从 Electron 会话里捕获 cookie，是唯一既不改服务器、又不需复制粘贴的路径。

## 工作原理

插件与官方 DSH 插件一样由两面组成：

- **Host 面**（`lib/index.js`）：Cordis 插件，持有 `newapi` settings namespace；访问令牌通过 credentials 服务保存（绝不写入 `settings.yaml` 或 `cordis.yml`）；调用 NewAPI 管理 API（`/api/user/self`、`/api/token/`、`/api/user/models`、`/api/pricing`）；对浏览器暴露 `trusted-host` 授权的 `/newapi` RPC 通道。
- **浏览器面**（`lib/client.js`）：`settings.section` slot 贡献（设置里的「NewAPI」页），基于共享 UI 原语构建。

模型同步**不会**注册一个平行的 LLM 适配器：它把 provider profile 写进随产品发布的 `@deepseek-ai/dsh-llm-pi-ai` settings namespace（`providers.<route>`）——这是接入 OpenAI 兼容网关的官方途径。聊天模型选择器、目录合并、重试策略全部照常工作。令牌按环境变量名引用，不会被复制进配置。

**没有 API key 的模型不会出现在选择器里**：选择器菜单完全由 `llm-pi-ai` 目录驱动，插件因此监听聊天 key（`NEWAPI_API_KEY`）的凭据提交事件（`credentials/reference-updated`，也正是选择器目录刷新所依赖的事件）——key 缺失时立即把整条路由从目录中移除（profile 暂存于 `newapi` 命名空间，不丢失已同步的模型与限制），key 恢复时原样回填，全程无需网络。`models.sync` 也在无 key 时直接拒绝（`not-configured`），保证任何路径都写不进一条「无 key 路由」。手动删除该 provider 不受影响：暂存只由插件自己的隐藏动作写入，不会复活用户删掉的路由。

「存在」只是半个保证：在网页控制台删掉的 key 仍留在本地凭据库里。插件因此在启动时、以及每次快照刷新后，用该 key 向网关的 `/v1/models` 做一次轻量校验——只有服务器明确拒绝（401/403）才移除本地 key，限流、断网、5xx 都不会误删。移除同样走凭据事件，路由经既有路径隐藏；下次登录（或会话仍有效时的启动自愈）会自动装回可用的 key。

额度换算优先使用服务器 `/api/status` 返回的 `quota_per_unit`（默认 500000，即 $1 = 500,000 配额单位），美元金额同时按 `usd_exchange_rate` 折算显示本币参考价。

## 安装

从插件市场安装（如已收录），或在 DSH Desktop 内置终端执行：

```sh
dsh plugin --profile desktop add dsh-plugin-newapi
```

本地开发安装：

```sh
dsh plugin --profile desktop add file:E:/dsh-desktop/dsh-plugin-newapi
```

安装后重启 DSH Desktop。

## 配置

默认值即可满足多数场景。需要自定义时，编辑插件的 `cordis.patch.yml`（或在 profile 中覆盖 loader 行）：

```yaml
- insert:
    - id: newapi
      name: dsh-plugin-newapi
      config:
        route: newapi             # LLM 目录中的提供方路由 id
        apiKeyEnv: NEWAPI_API_KEY # 保存聊天用 API key 的凭据引用
        displayName: NewAPI       # 模型选择器中显示的名称
        baseUrl: http://172.24.204.251:4000  # 写死的控制台地址; 设置后 UI 不再询问
        passwordLogin: false      # 默认关闭; 开启后显示用户名密码表单
```

然后打开 **设置 → NewAPI**，填入服务器地址，点「检测服务器」确认连通性与可用的登录方式，再按上面的「登录方式」完成登录。

## 安全说明

- 凭据（缓存的系统访问令牌，或旧式服务器的 session 值）只保存在本机凭据存储（`$DSH_HOME/.credentials.yaml`，权限 0600）：控制台凭据引用名为 `NEWAPI_SESSION`，聊天 API key 引用名为 `NEWAPI_API_KEY`。
- 密钥明文绝不发给渲染进程；令牌列表只显示末 4 位。
- `/newapi` RPC 通道使用 `trusted-host` 授权，与 DSH API 网关注册的边界一致：桌面窗口内可用，开启浏览器访问后在浏览器会话中同样可用。
- 系统访问令牌每次登录至多生成一次（重新生成会使旧令牌失效），本地缓存仍能认证同一账号时直接复用，失效后才重新生成。
- 会话续期换发的新 session 值由 Host 自动写回凭据存储（仅旧式 cookie 回退流程）。
- 内嵌登录的 cookie 捕获只在你主动点击「打开登录页」期间进行，只读取所配置服务器源上的 `session` 这一个 cookie，读到的值立即经服务器验证后进入凭据存储；捕获结束后停止监听。该能力依赖 DSH Desktop 的 Electron 会话，普通 CLI 环境自动禁用。

## 开发

```sh
npm install            # 仅 esbuild
npm run build          # -> lib/index.js + lib/client.js + lib/types
npm test               # 本地 mock 冒烟测试 + 客户端 bundle 形状校验 + 登录流程回归测试
```

## 发布（清单）

- `npm publish`（包内无生命周期脚本；`files` 只包含 `lib/`、patch YAML 与 README）。
- 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表提 PR 即可进入社区插件市场；npm 的 `repository` 字段需指向同一仓库。

## 许可

MIT
