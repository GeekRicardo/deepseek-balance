# deepseek-balance

DeepSeek Harness web 插件：在**输入框下方状态栏**展示 DeepSeek 官方账户余额与本会话估算花费，并区分非 DeepSeek 模型。

- DeepSeek 模型时：`● 本会话 ¥X.XX · ● 余额 ¥465.xx`（每 60 秒自动刷新）
- 非 DeepSeek 模型时：`● 非 DeepSeek 供应商`（不查余额、不算花费）

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/GeekRicardo/deepseek-balance/main/install.sh | bash
```

脚本做的事（可先 `--dry-run` 预览）：

1. 在 `~/.dsh/profiles/web/package.json` 写入依赖 `"deepseek-balance": "github:GeekRicardo/deepseek-balance"`；
2. 把 `deepseek-balance` 追加进 `dsh.profile.bundles`；
3. `cd ~/.dsh/profiles/web && pnpm install`；
4. 校验 bundles 已注册，提示重启。

重启 DSH 并硬刷新页面后生效：

```bash
pm2 restart dsh-web   # 若用 pm2 托管；否则用你的启动方式重启
```

## 卸载

```bash
# 1. 从 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 移除 "deepseek-balance"
# 2. 移除 dependencies 里的 "deepseek-balance"
# 3. cd ~/.dsh/profiles/web && pnpm install
# 4. 重启 DSH
```

## 前置条件

- DeepSeek Harness 已初始化 web profile（`~/.dsh/profiles/web` 存在）。
- `~/.dsh/.credentials.yaml` 里配置了 `DEEPSEEK_API_KEY`（本插件复用 harness 自身的 DeepSeek 密钥，不额外索取）。
- Node.js ≥ 20、pnpm 可用。

## 工作原理

| 半区 | 职责 |
| --- | --- |
| Host | 监听 `llm/stream` 按 session 累计 DeepSeek token；从 models.dev 拉单价（内存缓存 24h + 硬编码兜底）换算人民币估算花费；经 `credentials.resolve('DEEPSEEK_API_KEY')` 读密钥，curl 官方 `/user/balance` 查余额；注册 `/deepseek-balance/status` HTTP route |
| Client | 在 `conversation.composer.dock` 槽位渲染状态栏，`fetch` 轮询该 route（60s） |

### 计费口径（重要）

- DeepSeek 官方 API **不返回金额**，只返回 token 数。金额是 `token × 单价` 的**估算**，不是账单。
- 单价来自第三方 [models.dev](https://models.dev)（USD/百万 token），按模型前缀匹配；拉取失败回落到内置单价。
- 汇率固定 7.2 换算成人民币。
- 误差来源：DeepSeek 峰谷定价（分时段计价）、汇率、单价维护。

### 数据生命周期

- 本会话花费是**内存态**，从插件加载后的下一次模型调用开始累计，重启清零，不持久化。
- 余额每次轮询实时查询官方接口。

## License

MIT
