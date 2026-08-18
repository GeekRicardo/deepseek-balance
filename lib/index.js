// dsh-balance — host face（DeepSeek + Kimi Coding 双供应商）
//
// 职责（全部进程内、可逆）：
// 1. 监听 `llm/stream` 瀑布事件，按 session 累计 DeepSeek 官方模型的 token 用量。
// 2. 当前 provider 判断一律用 `agentDefaultModel.currentSelection()`（切换即更新），
//    不再依赖"最近一次请求的模型"，解决切换模型/切换对话后读数不及时的问题。
// 3. provider = deepseek  → 展示 DeepSeek 官方余额（DEEPSEEK_API_KEY）+ 本会话估算花费；
//    provider = kimi-coding → 展示 Kimi Coding 订阅用量（KIMI_CODING_API_KEY，
//    GET https://api.kimi.com/coding/v1/usages，5 小时窗口 / 每周配额 / 刷新时间）。
// 4. 两类余额/用量都按 provider 做 5 分钟内存缓存；切走再切回强制刷新一次。
// 5. 注册 /dsh-balance/status HTTP route 供 client 2 秒轮询。

const inject = ["webServer", "credentials", "subprocess"];

const CNY_PER_USD = 7.2;
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MODELS_DEV_URL = "https://models.dev/api.json";

const PROVIDER_DEEPSEEK = "deepseek";
const PROVIDER_KIMI = "kimi-coding";
const PROVIDER_OPENCODE = "opencode-go";
const KIMI_DEFAULT_BASE = "https://api.kimi.com/coding";
const KIMI_USAGE_PATH = "/v1/usages";
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
// opencode-go 官方美元配额（opencode.ai/docs/go）：5小时=$12、每周=$30、每月=$60
const OPENCODE_LIMITS_USD = { rolling: 12, weekly: 30, monthly: 60 };

// 智谱 GLM Coding Plan（对齐 cc-switch query_zhipu / parse_zhipu_token_tiers）
const ZHIPU_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const ZHIPU_BASES = { "zai-coding-cn": "https://open.bigmodel.cn", zai: "https://api.z.ai" };
const ZHIPU_KEYS = { "zai-coding-cn": "ZAI_CODING_CN_API_KEY", zai: "ZAI_API_KEY" };

// MiniMax Coding Plan（对齐 cc-switch query_minimax / parse_minimax_tiers）
const MINIMAX_USAGE_PATH = "/v1/api/openplatform/coding_plan/remains";
const MINIMAX_BASES = { "minimax-cn": "https://api.minimaxi.com", minimax: "https://api.minimax.io" };
const MINIMAX_KEYS = { "minimax-cn": "MINIMAX_CN_API_KEY", minimax: "MINIMAX_API_KEY" };

// OpenRouter（对齐 cc-switch balance.rs query_openrouter）
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

// OpenAI Codex（对齐 cc-switch subscription.rs query_codex_quota）
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

// DeepSeek 官方有两条 provider 路由：DSH 自带的 deepseek-official（dsh-llm-deepseek）
// 与 pi-ai 的 deepseek（api.deepseek.com），余额接口相同，都归入 DeepSeek 分支。
function isDeepSeekProvider(p) {
  return p === PROVIDER_DEEPSEEK || p === "deepseek-official";
}

// models.dev 拉取失败时的兜底单价，USD / 百万 token。
const FALLBACK_PRICING = [
  { prefix: "deepseek-v4-pro", input: 0.435, output: 0.87, cacheRead: 0.003625 },
  { prefix: "deepseek-v4-flash", input: 0.14, output: 0.28, cacheRead: 0.0028 },
  { prefix: "deepseek-chat", input: 0.14, output: 0.28, cacheRead: 0.0028 },
  { prefix: "deepseek-reasoner", input: 0.14, output: 0.28, cacheRead: 0.0028 },
];

function isDeepSeekModel(model) {
  return typeof model === "string" && model.indexOf("deepseek-") === 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toNum(v) {
  const n = Number(v);
  return n === n ? n : null;
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// 同源/本机请求防护：拒绝跨站读取余额，只放行 loopback 同源请求。
function isTrusted(req) {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = host.split(":")[0];
  if (!isLoopbackHostname(hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function apply(ctx) {
  const credentials = ctx.credentials;
  const subprocess = ctx.subprocess;
  const agentDefaultModel = ctx.get("agentDefaultModel");

  const pricing = { entries: null, fetchedAt: 0, source: "fallback" };
  let pricingPromise = null;
  const tokensBySession = new Map();
  // 余额/用量缓存：key 记录上次的 provider，切走再切回时强制刷新一次。
  const caches = {
    deepseek: { key: null, fetchedAt: 0, balance: null, balanceError: null },
    kimi: { key: null, fetchedAt: 0, status: null },
    opencode: { key: null, fetchedAt: 0, status: null },
    zhipu: { key: null, fetchedAt: 0, status: null },
    minimax: { key: null, fetchedAt: 0, status: null },
    openrouter: { key: null, fetchedAt: 0, status: null },
    codex: { key: null, fetchedAt: 0, status: null },
  };

  function recordUsage(options, usage) {
    const key = options.sessionId ? String(options.sessionId) : "__global__";
    const cur = tokensBySession.get(key) || {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      requests: 0,
    };
    cur.inputTokens += usage.inputTokens || 0;
    cur.cacheReadTokens += usage.cacheReadTokens || 0;
    cur.outputTokens += usage.outputTokens || 0;
    cur.requests += 1;
    tokensBySession.set(key, cur);
  }

  // 透传每个 chunk，流结束后把 DeepSeek 官方模型的 usage 记入本会话累计；不改变下游语义。
  ctx.on("llm/stream", function (options, next) {
    const upstream = next();
    return (async function* () {
      let usage = null;
      try {
        for await (const chunk of upstream) {
          if (chunk && chunk.type === "usage" && chunk.usage) usage = chunk.usage;
          yield chunk;
        }
      } finally {
        if (usage && isDeepSeekModel(options && options.model)) {
          try {
            recordUsage(options, usage);
          } catch (error) {
            console.error("dsh-balance: record usage failed", error);
          }
        }
      }
    })();
  });

  // 当前选中 provider/model（切换即更新），是本插件判断依据的权威源。
  function currentSelection() {
    if (!agentDefaultModel) return null;
    try {
      const sel = agentDefaultModel.currentSelection();
      if (!sel || typeof sel !== "object") return null;
      return {
        provider: typeof sel.provider === "string" ? sel.provider : null,
        model: typeof sel.model === "string" ? sel.model : null,
      };
    } catch {
      return null;
    }
  }

  // ── DeepSeek：定价 + 花费 + 余额 ──────────────────────────

  function httpGet(url) {
    const handle = subprocess.spawn({
      argv: ["curl", "-sS", "--max-time", "20", url],
      cwd: "/",
      stdio: { stdin: "ignore", stdout: { maxBytes: 8388608 }, stderr: { maxBytes: 16384 } },
      graceMs: 5000,
    });
    return handle.done.then(function (outcome) {
      const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
      const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
      if (outcome.exitCode !== 0) {
        throw new Error((err && err.trim()) ? err.trim() : "curl exit " + outcome.exitCode);
      }
      return out;
    });
  }

  function parseDeepSeekPricing(body) {
    const data = JSON.parse(body);
    const models = data && data.deepseek && data.deepseek.models;
    if (!models || typeof models !== "object") return null;
    const entries = [];
    for (const id in models) {
      const cost = models[id] && models[id].cost;
      if (!cost || typeof cost !== "object") continue;
      const input = typeof cost.input === "number" ? cost.input : 0;
      const output = typeof cost.output === "number" ? cost.output : 0;
      const cacheRead = typeof cost.cache_read === "number" ? cost.cache_read : 0;
      if (!(input > 0) && !(output > 0)) continue;
      entries.push({ prefix: id, input, output, cacheRead });
    }
    if (!entries.length) return null;
    entries.sort(function (a, b) {
      return b.prefix.length - a.prefix.length;
    });
    return entries;
  }

  function ensurePricing() {
    const now = Date.now();
    if (pricing.entries && now - pricing.fetchedAt < PRICING_TTL_MS) return Promise.resolve();
    if (pricingPromise) return pricingPromise;
    pricingPromise = (async function () {
      try {
        const body = await httpGet(MODELS_DEV_URL);
        const entries = parseDeepSeekPricing(body);
        if (entries) {
          pricing.entries = entries;
          pricing.fetchedAt = Date.now();
          pricing.source = "live";
        }
      } catch (error) {
        console.error("dsh-balance: fetch pricing failed, using fallback", error);
      } finally {
        pricingPromise = null;
      }
    })();
    return pricingPromise;
  }

  function matchPricing(model) {
    const entries = pricing.entries || FALLBACK_PRICING;
    for (let i = 0; i < entries.length; i++) {
      if (model.indexOf(entries[i].prefix) === 0) return entries[i];
    }
    return null;
  }

  function computeSpend(model, tokens) {
    const p = matchPricing(model);
    const usd =
      (p ? p.input : 0) * (tokens.inputTokens / 1000000) +
      (p ? p.cacheRead : 0) * (tokens.cacheReadTokens / 1000000) +
      (p ? p.output : 0) * (tokens.outputTokens / 1000000);
    return round2(usd * CNY_PER_USD);
  }

  async function queryDeepSeekBalance() {
    let resolved;
    try {
      resolved = await credentials.resolve("DEEPSEEK_API_KEY");
    } catch {
      return { ok: false, error: "读取凭据失败" };
    }
    if (!resolved || !resolved.value) return { ok: false, error: "未配置 DEEPSEEK_API_KEY" };

    const config =
      'header = "Authorization: Bearer ' + resolved.value + '"\n' +
      'header = "Accept: application/json"\n';

    let handle;
    try {
      handle = subprocess.spawn({
        argv: ["curl", "-sS", "--max-time", "15", "--config", "-", "https://api.deepseek.com/user/balance"],
        cwd: "/",
        stdio: { stdin: { data: config }, stdout: { maxBytes: 65536 }, stderr: { maxBytes: 16384 } },
        graceMs: 5000,
      });
    } catch {
      return { ok: false, error: "启动 curl 失败" };
    }

    let outcome;
    try {
      outcome = await handle.done;
    } catch {
      return { ok: false, error: "curl 执行异常" };
    }

    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
    if (outcome.exitCode !== 0) {
      return { ok: false, error: (err && err.trim()) ? err.trim() : "curl exit " + outcome.exitCode };
    }

    let body;
    try {
      body = JSON.parse(out);
    } catch {
      return { ok: false, error: "响应不是合法 JSON" };
    }
    return { ok: true, body };
  }

  async function deepseekStatus(sessionId) {
    const sel = currentSelection();
    const provider = sel && sel.provider ? sel.provider : null;
    const model = sel && sel.model ? sel.model : null;
    const key = sessionId ? String(sessionId) : "__global__";
    const tokens = tokensBySession.get(key) || {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      requests: 0,
    };

    await ensurePricing();
    const spendCny = computeSpend(model, tokens);

    const cache = caches.deepseek;
    const now = Date.now();
    let balance = null;
    let balanceError = null;
    const switched = !isDeepSeekProvider(cache.key);
    if (!switched && now - cache.fetchedAt < CACHE_TTL_MS && (cache.balance !== null || cache.balanceError !== null)) {
      balance = cache.balance;
      balanceError = cache.balanceError;
    } else {
      const result = await queryDeepSeekBalance();
      balance = result.ok ? result.body : null;
      balanceError = result.ok ? null : result.error;
      cache.key = provider;
      cache.fetchedAt = now;
      cache.balance = balance;
      cache.balanceError = balanceError;
    }

    return {
      ok: true,
      isSupported: true,
      provider: provider,
      model: model,
      spendCny: spendCny,
      requests: tokens.requests,
      pricingSource: pricing.source,
      balance: balance,
      balanceError: balanceError,
    };
  }

  // ── Kimi Coding：订阅用量 ─────────────────────────────────

  async function resolveCredential(names) {
    for (const name of names) {
      try {
        const resolved = await credentials.resolve(name);
        if (resolved && resolved.value) return resolved.value;
      } catch {
        // 尝试下一个候选名
      }
    }
    return null;
  }

  // 对齐 cc-switch：utilization = (limit - remaining) / limit * 100（已用百分比）
  function makeTier(limitRaw, remainingRaw, resetTime) {
    const limit = toNum(limitRaw);
    const remaining = toNum(remainingRaw);
    const used = limit !== null && remaining !== null ? Math.max(limit - remaining, 0) : null;
    const utilization = limit !== null && limit > 0 && used !== null ? (used / limit) * 100 : null;
    return {
      limit: limit,
      remaining: remaining,
      used: used,
      utilization: utilization,
      resetsAt: typeof resetTime === "string" ? resetTime : null,
    };
  }

  async function queryKimiUsage() {
    let key;
    try {
      key = await resolveCredential(["KIMI_CODING_API_KEY", "KIMI_CODE_API_KEY", "KIMI_API_KEY"]);
    } catch {
      return { ok: false, error: "读取凭据失败" };
    }
    if (!key) return { ok: false, error: "未配置 KIMI_CODING_API_KEY" };

    let baseUrl = KIMI_DEFAULT_BASE;
    try {
      const override = await resolveCredential(["KIMI_CODE_BASE_URL"]);
      if (override && typeof override === "string" && override.length > 0) baseUrl = override.trim();
    } catch {
      // 使用默认
    }

    const config =
      'header = "Authorization: Bearer ' + key + '"\n' +
      'header = "Accept: application/json"\n' +
      'header = "User-Agent: KimiCLI/1.5"\n';

    let handle;
    try {
      handle = subprocess.spawn({
        argv: ["curl", "-sS", "--max-time", "15", "--config", "-", baseUrl + KIMI_USAGE_PATH],
        cwd: "/",
        stdio: { stdin: { data: config }, stdout: { maxBytes: 262144 }, stderr: { maxBytes: 16384 } },
        graceMs: 5000,
      });
    } catch {
      return { ok: false, error: "启动 curl 失败" };
    }

    let outcome;
    try {
      outcome = await handle.done;
    } catch {
      return { ok: false, error: "curl 执行异常" };
    }

    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
    if (outcome.exitCode !== 0) {
      return { ok: false, error: (err && err.trim()) ? err.trim() : "curl exit " + outcome.exitCode };
    }

    let body;
    try {
      body = JSON.parse(out);
    } catch {
      return { ok: false, error: "响应不是合法 JSON" };
    }

    if (body && body.error) {
      return { ok: false, error: String(body.error.message || body.error.type || "接口返回错误") };
    }

    // 5 小时窗口：limits[].detail（取第一个，对齐 cc-switch）
    const firstLimit = Array.isArray(body.limits) && body.limits.length ? body.limits[0] : null;
    const rateDetail = firstLimit && firstLimit.detail ? firstLimit.detail : null;
    // 周限额：usage
    const usage = body && body.usage ? body.usage : null;

    if (!rateDetail && !usage) return { ok: false, error: "响应缺少 usage/limits 字段" };

    return {
      ok: true,
      fiveHour: rateDetail ? makeTier(rateDetail.limit, rateDetail.remaining, rateDetail.resetTime) : null,
      weekly: usage ? makeTier(usage.limit, usage.remaining, usage.resetTime) : null,
      membership:
        body.user && body.user.membership && typeof body.user.membership.level === "string"
          ? body.user.membership.level
          : null,
    };
  }

  async function kimiStatus() {
    const sel = currentSelection();
    const model = sel && sel.model ? sel.model : null;
    const cache = caches.kimi;
    const now = Date.now();
    const switched = cache.key !== PROVIDER_KIMI;
    if (!switched && cache.status && now - cache.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, ...cache.status };
    }

    const result = await queryKimiUsage();
    const status = {
      isSupported: true,
      provider: PROVIDER_KIMI,
      model: model,
      fiveHour: result.ok ? result.fiveHour : null,
      weekly: result.ok ? result.weekly : null,
      membership: result.ok ? result.membership : null,
      queriedAt: result.ok ? now : null,
      balanceError: result.ok ? null : result.error,
    };
    cache.key = PROVIDER_KIMI;
    cache.fetchedAt = now;
    cache.status = status;
    return { ok: true, ...status };
  }

  // ── OpenCode Go：订阅用量 ─────────────────────────────────

  // 接口只给已用百分比（0-100 整数）与重置时间，金额按官方配额美元换算。
  function parseOpencodeWindow(w) {
    if (!w || typeof w !== "object") return null;
    const percent = toNum(w.percent);
    return {
      percent: percent,
      resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
    };
  }

  async function queryOpencodeUsage() {
    let key;
    try {
      key = await resolveCredential(["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"]);
    } catch {
      return { ok: false, error: "读取凭据失败" };
    }
    if (!key) return { ok: false, error: "未配置 OPENCODE_GO_API_KEY" };

    // 官方接口要求同时带 Bearer 与 x-api-key；网关会拦常见 CLI UA，故伪装浏览器。
    const config =
      'header = "Authorization: Bearer ' + key + '"\n' +
      'header = "x-api-key: ' + key + '"\n' +
      'header = "Accept: application/json"\n' +
      'header = "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"\n';

    let handle;
    try {
      handle = subprocess.spawn({
        argv: ["curl", "-sS", "--max-time", "15", "--config", "-", OPENCODE_USAGE_URL],
        cwd: "/",
        stdio: { stdin: { data: config }, stdout: { maxBytes: 262144 }, stderr: { maxBytes: 16384 } },
        graceMs: 5000,
      });
    } catch {
      return { ok: false, error: "启动 curl 失败" };
    }

    let outcome;
    try {
      outcome = await handle.done;
    } catch {
      return { ok: false, error: "curl 执行异常" };
    }

    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
    if (outcome.exitCode !== 0) {
      return { ok: false, error: (err && err.trim()) ? err.trim() : "curl exit " + outcome.exitCode };
    }

    let body;
    try {
      body = JSON.parse(out);
    } catch {
      return { ok: false, error: "响应不是合法 JSON" };
    }

    if (body && body.error) {
      return { ok: false, error: String(body.error.message || body.error.type || "接口返回错误") };
    }

    const usage = body && body.usage ? body.usage : null;
    if (!usage || typeof usage !== "object") return { ok: false, error: "响应缺少 usage 字段" };

    const windows = {};
    for (const name of ["rolling", "weekly", "monthly"]) {
      const w = parseOpencodeWindow(usage[name]);
      if (w) {
        w.limitUsd = OPENCODE_LIMITS_USD[name] || null;
        windows[name] = w;
      }
    }
    if (!windows.rolling && !windows.weekly && !windows.monthly) {
      return { ok: false, error: "响应缺少用量窗口字段" };
    }

    return { ok: true, windows };
  }

  async function opencodeStatus() {
    const sel = currentSelection();
    const model = sel && sel.model ? sel.model : null;
    const cache = caches.opencode;
    const now = Date.now();
    const switched = cache.key !== PROVIDER_OPENCODE;
    if (!switched && cache.status && now - cache.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, ...cache.status };
    }

    const result = await queryOpencodeUsage();
    const status = {
      isSupported: true,
      provider: PROVIDER_OPENCODE,
      model: model,
      windows: result.ok ? result.windows : null,
      queriedAt: result.ok ? now : null,
      balanceError: result.ok ? null : result.error,
    };
    cache.key = PROVIDER_OPENCODE;
    cache.fetchedAt = now;
    cache.status = status;
    return { ok: true, ...status };
  }

  // ── 智谱 GLM Coding Plan（对齐 cc-switch query_zhipu）──────
  //
  // GET {base}/api/monitor/usage/quota/limit，Authorization 直接带 key（不加 Bearer）。
  // data.limits[] 里 type=TOKENS_LIMIT 的条目：percentage=已用%，nextResetTime=毫秒时间戳；
  // unit=3 → 5 小时窗口，unit=6 → 每周窗口（老套餐只有一条，自然降级为仅 5 小时）。

  async function queryZhipuUsage(baseUrl, key) {
    const config =
      'header = "Authorization: ' + key + '"\n' +
      'header = "Content-Type: application/json"\n' +
      'header = "Accept-Language: en-US,en"\n' +
      'header = "Accept: application/json"\n';

    let handle;
    try {
      handle = subprocess.spawn({
        argv: ["curl", "-sS", "--max-time", "15", "--config", "-", baseUrl + ZHIPU_QUOTA_PATH],
        cwd: "/",
        stdio: { stdin: { data: config }, stdout: { maxBytes: 262144 }, stderr: { maxBytes: 16384 } },
        graceMs: 5000,
      });
    } catch {
      return { ok: false, error: "启动 curl 失败" };
    }

    let outcome;
    try {
      outcome = await handle.done;
    } catch {
      return { ok: false, error: "curl 执行异常" };
    }

    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
    if (outcome.exitCode !== 0) {
      return { ok: false, error: (err && err.trim()) ? err.trim() : "curl exit " + outcome.exitCode };
    }

    let body;
    try {
      body = JSON.parse(out);
    } catch {
      return { ok: false, error: "响应不是合法 JSON" };
    }

    if (body && body.success === false) {
      return { ok: false, error: String((body && body.msg) || "接口返回错误") };
    }

    const data = body && body.data ? body.data : null;
    if (!data || typeof data !== "object") return { ok: false, error: "响应缺少 data 字段" };

    const limits = Array.isArray(data.limits) ? data.limits : [];
    let fiveHour = null;
    let weekly = null;
    const unclassified = [];
    for (const item of limits) {
      if (!item || typeof item !== "object") continue;
      const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
      if (type !== "tokens_limit") continue;
      const percentage = toNum(item.percentage);
      const resetMs = toNum(item.nextResetTime);
      const resetIso = resetMs !== null ? new Date(resetMs).toISOString() : null;
      const entry = { percentage, resetMs, resetIso };
      const unit = toNum(item.unit);
      if (unit === 3 && !fiveHour) fiveHour = entry;
      else if (unit === 6 && !weekly) weekly = entry;
      else unclassified.push(entry);
    }
    // 兜底启发式（对齐 cc-switch）：未分类按重置时间升序依次填空缺槽位。
    unclassified.sort(function (a, b) {
      if (a.resetMs === null && b.resetMs === null) return 0;
      if (a.resetMs === null) return 1;
      if (b.resetMs === null) return -1;
      return a.resetMs - b.resetMs;
    });
    for (const entry of unclassified) {
      if (!fiveHour) fiveHour = entry;
      else if (!weekly) weekly = entry;
    }

    if (!fiveHour && !weekly) return { ok: false, error: "响应缺少 TOKENS_LIMIT 条目" };

    return {
      ok: true,
      fiveHour: fiveHour ? { utilization: fiveHour.percentage, resetsAt: fiveHour.resetIso } : null,
      weekly: weekly ? { utilization: weekly.percentage, resetsAt: weekly.resetIso } : null,
    };
  }

  async function zhipuStatus(provider) {
    const sel = currentSelection();
    const model = sel && sel.model ? sel.model : null;
    const cache = caches.zhipu;
    const now = Date.now();
    const switched = cache.key !== provider;
    if (!switched && cache.status && now - cache.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, ...cache.status };
    }

    let key;
    try {
      key = await resolveCredential([ZHIPU_KEYS[provider] || "ZAI_API_KEY"]);
    } catch {
      key = null;
    }
    let result = null;
    let error = key ? null : "未配置 " + (ZHIPU_KEYS[provider] || "ZAI_API_KEY");
    if (key) {
      const base = ZHIPU_BASES[provider] || "https://open.bigmodel.cn";
      result = await queryZhipuUsage(base, key);
      if (!result.ok) error = result.error;
    }

    const status = {
      isSupported: true,
      provider: provider,
      model: model,
      fiveHour: result && result.ok ? result.fiveHour : null,
      weekly: result && result.ok ? result.weekly : null,
      queriedAt: result && result.ok ? now : null,
      balanceError: error,
    };
    cache.key = provider;
    cache.fetchedAt = now;
    cache.status = status;
    return { ok: true, ...status };
  }

  // ── MiniMax Coding Plan（对齐 cc-switch query_minimax）─────
  //
  // GET {base}/v1/api/openplatform/coding_plan/remains，Authorization: Bearer。
  // model_remains[] 里 model_name=general 的条目：接口给的是「剩余百分比」，
  // 已用百分比 = 100 - 剩余；current_weekly_status==1 才展示周窗口。

  async function queryMiniMaxUsage(baseUrl, key) {
    const config =
      'header = "Authorization: Bearer ' + key + '"\n' +
      'header = "Content-Type: application/json"\n' +
      'header = "Accept: application/json"\n';

    let handle;
    try {
      handle = subprocess.spawn({
        argv: ["curl", "-sS", "--max-time", "15", "--config", "-", baseUrl + MINIMAX_USAGE_PATH],
        cwd: "/",
        stdio: { stdin: { data: config }, stdout: { maxBytes: 262144 }, stderr: { maxBytes: 16384 } },
        graceMs: 5000,
      });
    } catch {
      return { ok: false, error: "启动 curl 失败" };
    }

    let outcome;
    try {
      outcome = await handle.done;
    } catch {
      return { ok: false, error: "curl 执行异常" };
    }

    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
    if (outcome.exitCode !== 0) {
      return { ok: false, error: (err && err.trim()) ? err.trim() : "curl exit " + outcome.exitCode };
    }

    let body;
    try {
      body = JSON.parse(out);
    } catch {
      return { ok: false, error: "响应不是合法 JSON" };
    }

    const baseResp = body && body.base_resp ? body.base_resp : null;
    if (baseResp && toNum(baseResp.status_code) !== 0) {
      return { ok: false, error: String((baseResp && baseResp.status_msg) || "接口返回错误") };
    }

    const modelRemains = Array.isArray(body.model_remains) ? body.model_remains : [];
    const item = modelRemains.find(function (m) {
      return m && typeof m.model_name === "string" && m.model_name === "general";
    });
    if (!item || typeof item !== "object") return { ok: false, error: "响应缺少 general 条目" };

    const fiveHourRemain = toNum(item.current_interval_remaining_percent);
    const endMs = toNum(item.end_time);
    let fiveHour = null;
    if (fiveHourRemain !== null) {
      fiveHour = {
        utilization: 100 - fiveHourRemain,
        resetsAt: endMs !== null ? new Date(endMs).toISOString() : null,
      };
    }

    let weekly = null;
    if (toNum(item.current_weekly_status) === 1) {
      const weeklyRemain = toNum(item.current_weekly_remaining_percent);
      const weeklyEndMs = toNum(item.weekly_end_time);
      if (weeklyRemain !== null) {
        weekly = {
          utilization: 100 - weeklyRemain,
          resetsAt: weeklyEndMs !== null ? new Date(weeklyEndMs).toISOString() : null,
        };
      }
    }

    if (!fiveHour && !weekly) return { ok: false, error: "响应缺少用量窗口字段" };

    return { ok: true, fiveHour, weekly };
  }

  async function minimaxStatus(provider) {
    const sel = currentSelection();
    const model = sel && sel.model ? sel.model : null;
    const cache = caches.minimax;
    const now = Date.now();
    const switched = cache.key !== provider;
    if (!switched && cache.status && now - cache.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, ...cache.status };
    }

    let key;
    try {
      key = await resolveCredential([MINIMAX_KEYS[provider] || "MINIMAX_API_KEY"]);
    } catch {
      key = null;
    }
    let result = null;
    let error = key ? null : "未配置 " + (MINIMAX_KEYS[provider] || "MINIMAX_API_KEY");
    if (key) {
      const base = MINIMAX_BASES[provider] || "https://api.minimaxi.com";
      result = await queryMiniMaxUsage(base, key);
      if (!result.ok) error = result.error;
    }

    const status = {
      isSupported: true,
      provider: provider,
      model: model,
      fiveHour: result && result.ok ? result.fiveHour : null,
      weekly: result && result.ok ? result.weekly : null,
      queriedAt: result && result.ok ? now : null,
      balanceError: error,
    };
    cache.key = provider;
    cache.fetchedAt = now;
    cache.status = status;
    return { ok: true, ...status };
  }

  // ── OpenRouter：充值余额（对齐 cc-switch balance.rs query_openrouter）──
  //
  // GET https://openrouter.ai/api/v1/credits，Bearer key。
  // data.total_credits=总额、data.total_usage=已用，剩余 = 总额 - 已用。

  async function queryOpenRouterCredits() {
    let key;
    try {
      key = await resolveCredential(["OPENROUTER_API_KEY"]);
    } catch {
      return { ok: false, error: "读取凭据失败" };
    }
    if (!key) return { ok: false, error: "未配置 OPENROUTER_API_KEY" };

    const config =
      'header = "Authorization: Bearer ' + key + '"\n' +
      'header = "Accept: application/json"\n';

    let handle;
    try {
      handle = subprocess.spawn({
        argv: ["curl", "-sS", "--max-time", "15", "--config", "-", OPENROUTER_CREDITS_URL],
        cwd: "/",
        stdio: { stdin: { data: config }, stdout: { maxBytes: 262144 }, stderr: { maxBytes: 16384 } },
        graceMs: 5000,
      });
    } catch {
      return { ok: false, error: "启动 curl 失败" };
    }

    let outcome;
    try {
      outcome = await handle.done;
    } catch {
      return { ok: false, error: "curl 执行异常" };
    }

    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
    if (outcome.exitCode !== 0) {
      return { ok: false, error: (err && err.trim()) ? err.trim() : "curl exit " + outcome.exitCode };
    }

    let body;
    try {
      body = JSON.parse(out);
    } catch {
      return { ok: false, error: "响应不是合法 JSON" };
    }

    const data = body && body.data ? body.data : null;
    if (!data || typeof data !== "object") return { ok: false, error: "响应缺少 data 字段" };

    const total = toNum(data.total_credits);
    const used = toNum(data.total_usage);
    if (total === null && used === null) return { ok: false, error: "响应缺少 credits 字段" };

    return {
      ok: true,
      total: total,
      used: used,
      remaining: total !== null && used !== null ? Math.max(total - used, 0) : null,
    };
  }

  async function openrouterStatus() {
    const sel = currentSelection();
    const model = sel && sel.model ? sel.model : null;
    const cache = caches.openrouter;
    const now = Date.now();
    const switched = cache.key !== "openrouter";
    if (!switched && cache.status && now - cache.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, ...cache.status };
    }

    const result = await queryOpenRouterCredits();
    const status = {
      isSupported: true,
      provider: "openrouter",
      model: model,
      credits: result.ok ? { total: result.total, used: result.used, remaining: result.remaining } : null,
      currency: "USD",
      queriedAt: result.ok ? now : null,
      balanceError: result.ok ? null : result.error,
    };
    cache.key = "openrouter";
    cache.fetchedAt = now;
    cache.status = status;
    return { ok: true, ...status };
  }

  // ── OpenAI Codex：订阅额度窗口（对齐 cc-switch query_codex_quota）──
  //
  // GET https://chatgpt.com/backend-api/wham/usage，Bearer ChatGPT access token
  // （DSH 里经凭据 OPENAI_CODEX_ACCESS_TOKEN 配置，可选 OPENAI_CODEX_ACCOUNT_ID）。
  // rate_limit.primary/secondary_window：used_percent=已用%、limit_window_seconds=窗口秒数、
  // reset_at=重置时间戳（秒）。

  function codexWindowName(secs) {
    if (secs === 18000) return { label: "5小时", key: "5h" };
    if (secs === 604800) return { label: "7天", key: "7d" };
    if (secs === 2592000) return { label: "30天", key: "30d" };
    const hours = Math.floor(secs / 3600);
    if (hours >= 24) return { label: Math.floor(hours / 24) + "天", key: Math.floor(hours / 24) + "d" };
    return { label: hours + "小时", key: hours + "h" };
  }

  async function queryCodexUsage() {
    let key;
    try {
      key = await resolveCredential(["OPENAI_CODEX_ACCESS_TOKEN"]);
    } catch {
      return { ok: false, error: "读取凭据失败" };
    }
    if (!key) return { ok: false, error: "未配置 OPENAI_CODEX_ACCESS_TOKEN" };

    let accountId = null;
    try {
      const resolved = await resolveCredential(["OPENAI_CODEX_ACCOUNT_ID"]);
      if (resolved) accountId = resolved;
    } catch {
      // 可选
    }

    const config =
      'header = "Authorization: Bearer ' + key + '"\n' +
      'header = "User-Agent: codex-cli"\n' +
      'header = "Accept: application/json"\n' +
      (accountId ? 'header = "ChatGPT-Account-Id: ' + accountId + '"\n' : "");

    let handle;
    try {
      handle = subprocess.spawn({
        argv: ["curl", "-sS", "--max-time", "15", "--config", "-", CODEX_USAGE_URL],
        cwd: "/",
        stdio: { stdin: { data: config }, stdout: { maxBytes: 262144 }, stderr: { maxBytes: 16384 } },
        graceMs: 5000,
      });
    } catch {
      return { ok: false, error: "启动 curl 失败" };
    }

    let outcome;
    try {
      outcome = await handle.done;
    } catch {
      return { ok: false, error: "curl 执行异常" };
    }

    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
    if (outcome.exitCode !== 0) {
      return { ok: false, error: (err && err.trim()) ? err.trim() : "curl exit " + outcome.exitCode };
    }

    let body;
    try {
      body = JSON.parse(out);
    } catch {
      return { ok: false, error: "响应不是合法 JSON" };
    }

    const rateLimit = body && body.rate_limit ? body.rate_limit : null;
    const windows = [];
    for (const win of [rateLimit && rateLimit.primary_window, rateLimit && rateLimit.secondary_window]) {
      if (!win || typeof win !== "object") continue;
      const used = toNum(win.used_percent);
      if (used === null) continue;
      const secs = toNum(win.limit_window_seconds);
      const name = codexWindowName(secs !== null ? secs : 0);
      const resetSecs = toNum(win.reset_at);
      windows.push({
        key: name.key,
        label: name.label,
        utilization: used,
        resetsAt: resetSecs !== null ? new Date(resetSecs * 1000).toISOString() : null,
      });
    }
    if (!windows.length) return { ok: false, error: "响应缺少 rate_limit 窗口" };

    return { ok: true, windows };
  }

  async function codexStatus() {
    const sel = currentSelection();
    const model = sel && sel.model ? sel.model : null;
    const cache = caches.codex;
    const now = Date.now();
    const switched = cache.key !== "openai-codex";
    if (!switched && cache.status && now - cache.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, ...cache.status };
    }

    const result = await queryCodexUsage();
    const status = {
      isSupported: true,
      provider: "openai-codex",
      model: model,
      windows: result.ok ? result.windows : null,
      queriedAt: result.ok ? now : null,
      balanceError: result.ok ? null : result.error,
    };
    cache.key = "openai-codex";
    cache.fetchedAt = now;
    cache.status = status;
    return { ok: true, ...status };
  }

  // ── 统一入口 ──────────────────────────────────────────────

  async function getStatus(sessionId) {
    const sel = currentSelection();
    const provider = sel ? sel.provider : null;
    const model = sel ? sel.model : null;

    if (isDeepSeekProvider(provider)) return deepseekStatus(sessionId);
    if (provider === PROVIDER_KIMI) return kimiStatus();
    if (provider === PROVIDER_OPENCODE) return opencodeStatus();
    if (provider === "zai-coding-cn" || provider === "zai") return zhipuStatus(provider);
    if (provider === "minimax-cn" || provider === "minimax") return minimaxStatus(provider);
    if (provider === "openrouter") return openrouterStatus();
    if (provider === "openai-codex") return codexStatus();

    // 其他 provider：不展示（client 返回 null），但带出当前 provider/model 便于诊断。
    return { ok: true, isSupported: false, provider: provider, model: model };
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-balance/status",
        handler: async (req, res) => {
          if (!isTrusted(req)) {
            writeJson(res, 403, { ok: false, error: "forbidden" });
            return;
          }
          try {
            const url = new URL(req.url ?? "/", "http://dsh.internal");
            const sessionId = url.searchParams.get("sessionId");
            writeJson(res, 200, await getStatus(sessionId));
          } catch (error) {
            writeJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
          }
        },
      }),
    "dsh-balance: /dsh-balance/status route",
  );
}

export { apply, inject };
