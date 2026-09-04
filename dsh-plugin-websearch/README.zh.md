# dsh-plugin-websearch

DSH Desktop 的通用网页搜索插件,由上游 `@deepseek-ai/dsh-web-search-deepseek`
provider 插件改造而来。不再依赖厂商搜索 API,每次查询都通过自建的
**Crawl4AI** 服务完成——默认使用安装在 `http://172.24.204.251:21235` 的实例。

## 工作原理

插件在 `ctx.web` 能力缝(seam)上注册搜索 provider(id 为 `crawl4ai`),因此
自带的 `web_search` 工具与结果卡片无需任何改动。每次查询它会:

1. 构造搜索引擎结果页(SERP)URL——默认 Bing,可选 DuckDuckGo;
2. 请求 Crawl4AI 服务(`POST /crawl`)抓取该页,并携带
   `JsonCssExtractionStrategy` 提取每条自然结果(标题 / URL / 摘要);
3. 将提取结果映射为可引用的来源,按 URL 去重并过滤引擎自身链接——结构化
   提取为空时依次退回页面 markdown、外部链接兜底。

无需任何厂商 API Key。若 Crawl4AI 服务开启了鉴权,配置 `apiToken`(或环境
变量 `CRAWL4AI_API_TOKEN`)即可。

## 配置

加载行(本包 `cordis.patch.yml`,即产品默认值):

```yaml
- insert:
    - id: websearch
      name: dsh-plugin-websearch
      config:
        baseUrl: http://172.24.204.251:21235
        engine: bing
```

同样的键可在设置界面或环境中调整:插件自带浏览器端,在设置的 NewAPI
入口之后注册"网页搜索"设置页(服务器地址、引擎、访问令牌、超时;namespace
`websearch`);环境变量方面,`CRAWL4AI_BASE_URL` 覆盖服务地址,
`CRAWL4AI_API_TOKEN` 提供服务令牌。

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `http://172.24.204.251:21235` | Crawl4AI 服务地址;自动追加 `/crawl`。 |
| `engine` | `bing` | SERP 预设:`bing` 或 `duckduckgo`。 |
| `serpUrl` | — | 自定义 SERP URL 模板,含 `{query}` 占位符(沿用所选引擎的提取 schema)。 |
| `apiToken` | — | 开启鉴权的服务使用的 Bearer 令牌。 |
| `timeoutMs` | `60000` | 单次请求超时(毫秒)。 |

bundle 补丁同时将上游 `web` 行改指 `searchProvider: crawl4ai` 并禁用
`web-search-deepseek` 行,使本插件成为产品默认搜索。如需恢复 DeepSeek
搜索,在用户 profile 补丁里重新启用该行并去掉覆盖即可。

## 联调真实服务

```bash
node test/crawl4ai-live.mjs [baseUrl] [engine] [query]
```

## 构建与测试

```bash
corepack yarn workspace dsh-plugin-websearch build
corepack yarn workspace dsh-plugin-websearch test
```
