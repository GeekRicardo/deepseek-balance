# Changelog

## 1.2.0 — 2026-08-18

- 新增 OpenRouter 余额查询（`openrouter`，`OPENROUTER_API_KEY` → `/api/v1/credits`）。
- 新增 OpenAI Codex 订阅额度查询（`openai-codex`，`OPENAI_CODEX_ACCESS_TOKEN` → `chatgpt.com/backend-api/wham/usage`）。
- README 补充支持矩阵与未接入供应商说明。

## 1.1.0 — 2026-08-18

- 插件更名为 `dsh-balance`（原 deepseek-balance）。
- 新增 opencode-go 用量查询（`OPENCODE_GO_API_KEY` → `opencode.ai/zen/go/v1/usage`）。
- DeepSeek 余额分支兼容 `deepseek-official` 路由。

## 1.0.0 — 2026-08-14

- 初始版本（deepseek-balance）：DeepSeek 官方余额 + 本会话估算花费。
- v2 起：按 provider 判断、2 秒轮询实时切换、5 分钟缓存。
- v4 起：Kimi Coding 用量（5小时/7天/刷新时间，对齐 cc-switch）。
