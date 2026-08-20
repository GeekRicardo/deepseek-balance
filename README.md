# dsh-balance

DeepSeek Harness web 插件：在**输入框下方状态栏**展示当前供应商的余额/用量，按 **provider** 实时切换（2 秒轮询），余额/用量 5 分钟缓存。

## 支持的供应商

| provider | 供应商 | 展示内容 | 密钥 | 接口 |
| --- | --- | --- | --- | --- |
| `deepseek` / `deepseek-official` / `deepseek-vision` | DeepSeek 官方（含 dsh-vision-router 的“DeepSeek+视觉” wrapper） | `● 本会话 ¥X.XX · ● 余额 ¥465.46` | `DEEPSEEK_API_KEY` | `GET api.deepseek.com/user/balance` |
| `kimi-coding` | Kimi For Coding | `5小时 3% 4h15m · 7天 31% 6d0h · 5分钟前` | `KIMI_CODING_API_KEY`（兼容 `KIMI_CODE_API_KEY`/`KIMI_API_KEY`） | `GET api.kimi.com/coding/v1/usages` |
| `opencode-go` | OpenCode Go | `5小时 8% 3h · 7天 3% 5d0h · 30天 1% 27d · 5分钟前` | `OPENCODE_GO_API_KEY`（兼容 `OPENCODE_API_KEY`） | `GET opencode.ai/zen/go/v1/usage` |
| `zai-coding-cn` / `zai` | 智谱 GLM Coding Plan | `5小时 3% 4h15m · 7天 31% 6d0h · 5分钟前` | `ZAI_CODING_CN_API_KEY` / `ZAI_API_KEY` | `GET open.bigmodel.cn 或 api.z.ai/api/monitor/usage/quota/limit` |
| `minimax-cn` / `minimax` | MiniMax Coding Plan | `5小时 3% 4h15m · 7天 31% 6d0h · 5分钟前` | `MINIMAX_CN_API_KEY` / `MINIMAX_API_KEY` | `GET api.minimaxi.com 或 api.minimax.io/v1/api/openplatform/coding_plan/remains` |
| `openrouter` | OpenRouter | `● 余额 $8.42` | `OPENROUTER_API_KEY` | `GET openrouter.ai/api/v1/credits` |
| `openai-codex` | OpenAI Codex（订阅） | `5小时 15% 3h · 7天 30% 4d2h · 5分钟前` | `OPENAI_CODEX_ACCESS_TOKEN`（可选 `OPENAI_CODEX_ACCOUNT_ID`） | `GET chatgpt.com/backend-api/wham/usage` |
| 其他 provider | — | 不显示（返回 null） | — | — |

> `deepseek` 与 `deepseek-official` 是 DeepSeek 官方的两条 provider 路由（DSH 自带 `dsh-llm-deepseek` 与 pi-ai catalog），余额接口相同，都展示官方余额。

### 为什么不是 cc-switch 的全部供应商

cc-switch 的用量查询实现里，能在 DSH 实际触发的是以上 7 家（pi-ai 有对应 provider id，模型选择器能切到）。以下两类**未接入**：

- **OAuth 订阅类**（Claude / Gemini / Grok）：cc-switch 走各自桌面 OAuth 会话 token（`~/.claude`、`~/.gemini`、Grok session）查询订阅额度，而 DSH 里这些 provider 走 API key 认证，插件拿不到订阅 token，无法干净接入。
- **pi-ai 无对应 provider**（SiliconFlow / StepFun / Novita / 火山 / ZenMux）：DSH 模型选择器里没有这些 provider id，加了也永远不会触发。

> `deepseek` 与 `deepseek-official` 是 DeepSeek 官方的两条 provider 路由（DSH 自带 `dsh-llm-deepseek` 与 pi-ai catalog），余额接口相同，都展示官方余额。

## 实时性

- **2 秒轮询**：切换模型/切换对话后最多 2 秒更新。
- **按 provider 判断**：用 `agentDefaultModel.currentSelection()`（当前选中，切换即更新），不依赖「最近一次请求的模型」。
- **5 分钟缓存**：余额/用量实际查询每 5 分钟一次（host 端按 provider 缓存），切走再切回强制刷新一次。
- 切换对话：client 按 `sessionId` 重新加载；DeepSeek 本会话花费按 session 分别累计（`llm/stream` token × models.dev 单价估算）。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/GeekRicardo/dsh-balance/main/install.sh | bash
```

脚本做的事（可先 `--dry-run` 预览）：

1. 在 `~/.dsh/profiles/web/package.json` 写入依赖 `"dsh-balance": "github:GeekRicardo/dsh-balance"`；
2. 把 `dsh-balance` 追加进 `dsh.profile.bundles`；
3. `cd ~/.dsh/profiles/web && pnpm install`；
4. 校验 bundles 已注册，提示重启。

重启 DSH 并硬刷新页面后生效：

```bash
pm2 restart dsh-web   # 若用 pm2 托管；否则用你的启动方式重启
```

## 卸载

```bash
# 1. 从 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 移除 "dsh-balance"
# 2. 移除 dependencies 里的 "dsh-balance"
# 3. cd ~/.dsh/profiles/web && pnpm install
# 4. 重启 DSH
```

## 前置条件

- DeepSeek Harness 已初始化 web profile（`~/.dsh/profiles/web` 存在）。
- `~/.dsh/.credentials.yaml` 里配置对应供应商的密钥（见上表）。
- Node.js ≥ 20、pnpm 可用。

## 工作原理

| 半区 | 职责 |
| --- | --- |
| Host | 监听 `llm/stream` 按 session 累计 DeepSeek 官方模型的 token；经 `credentials` 读密钥，按 provider 查对应接口；5 分钟缓存；注册 `/dsh-balance/status` HTTP route |
| Client | 在 `conversation.composer.dock` 槽位渲染状态栏，`fetch` 轮询该 route（2s），按 provider 分发渲染 |

### DeepSeek 计费口径（重要）

- DeepSeek 官方 API **不返回金额**，只返回 token 数。金额是 `token × 单价` 的**估算**，不是账单。
- 单价来自第三方 [models.dev](https://models.dev)（USD/百万 token），按模型前缀匹配；拉取失败回落到内置单价；汇率固定 7.2。
- 本会话花费是**内存态**，插件加载后开始累计，重启清零，不持久化。

### Kimi Coding 用量口径（重要）

- Kimi Code 是订阅制，「余额」= 每周请求配额与 5 小时滚动窗口的已用百分比，接口不返回金额。
- 展示格式对齐 [cc-switch](https://github.com/GeekRicardo/cc-switch) 的 `SubscriptionQuotaFooter`：`5小时 X% 倒计时 · 7天 Y% 倒计时 · N分钟前`，百分比 <70% 绿 / 70-90% 橙 / ≥90% 红。
- 仅当 provider 为 `kimi-coding`（`api.kimi.com/coding`）时展示；通过 opencode-go 等网关跑的 kimi 模型不属于此账户，不展示。

### OpenCode Go 用量口径（重要）

- OpenCode Go 是 $10/月订阅，官方配额：5 小时 = $12、每周 = $30、每月 = $60；接口只给已用百分比与重置时间，金额为按配额换算的估算（`percent/100 × 配额`）。
- 展示 `5小时 X% 倒计时 · 7天 Y% 倒计时 · 30天 Z% 倒计时 · N分钟前`，颜色阈值同上。
- 接口要求同时携带 `Authorization: Bearer` 与 `x-api-key` 两个请求头（对齐 [OpenCodeMonitor](https://github.com/Hanfei1224/OpenCodeMonitor) 的官方用量接口实现）。
- 仅当 provider 为 `opencode-go`（`opencode.ai/zen/go`）时展示。

## License

MIT

## Troubleshooting

| 现象 | 原因与处理 |
| --- | --- |
| 输入框下方什么都不显示 | 当前 provider 不在支持列表（见上表），或 host 尚未加载；重启后生效 |
| 显示「余额不可用」 | 对应供应商密钥未配置，或接口认证失败 —— 检查 `~/.dsh/.credentials.yaml` 是否有对应 key 且有效 |
| 切换模型后读数没有立即变 | 轮询间隔 2 秒；若更久，确认模型选择已保存（`currentSelection()` 生效） |
| 余额数字一直不变 | 5 分钟缓存：同一 provider 下每 5 分钟才重新查询一次，属预期 |
