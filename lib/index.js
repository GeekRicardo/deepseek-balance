// deepseek-balance — host face（DeepSeek + Kimi Coding 双供应商）
//
// 职责（全部进程内、可逆）：
// 1. 监听 `llm/stream` 瀑布事件，按 session 累计 DeepSeek 官方模型的 token 用量。
// 2. 当前 provider 判断一律用 `agentDefaultModel.currentSelection()`（切换即更新），
//    不再依赖"最近一次请求的模型"，解决切换模型/切换对话后读数不及时的问题。
// 3. provider = deepseek  → 展示 DeepSeek 官方余额（DEEPSEEK_API_KEY）+ 本会话估算花费；
//    provider = kimi-coding → 展示 Kimi Coding 订阅用量（KIMI_CODING_API_KEY，
//    GET https://api.kimi.com/coding/v1/usages，5 小时窗口 / 每周配额 / 刷新时间）。
// 4. 两类余额/用量都按 provider 做 5 分钟内存缓存；切走再切回强制刷新一次。
// 5. 注册 /deepseek-balance/status HTTP route 供 client 2 秒轮询。

const inject = ["webServer", "credentials", "subprocess"];

const CNY_PER_USD = 7.2;
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MODELS_DEV_URL = "https://models.dev/api.json";

const PROVIDER_DEEPSEEK = "deepseek";
const PROVIDER_KIMI = "kimi-coding";
const KIMI_DEFAULT_BASE = "https://api.kimi.com/coding";
const KIMI_USAGE_PATH = "/v1/usages";

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
            console.error("deepseek-balance: record usage failed", error);
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
        console.error("deepseek-balance: fetch pricing failed, using fallback", error);
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
    const switched = cache.key !== PROVIDER_DEEPSEEK;
    if (!switched && now - cache.fetchedAt < CACHE_TTL_MS && (cache.balance !== null || cache.balanceError !== null)) {
      balance = cache.balance;
      balanceError = cache.balanceError;
    } else {
      const result = await queryDeepSeekBalance();
      balance = result.ok ? result.body : null;
      balanceError = result.ok ? null : result.error;
      cache.key = PROVIDER_DEEPSEEK;
      cache.fetchedAt = now;
      cache.balance = balance;
      cache.balanceError = balanceError;
    }

    return {
      ok: true,
      isSupported: true,
      provider: PROVIDER_DEEPSEEK,
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

  // ── 统一入口 ──────────────────────────────────────────────

  async function getStatus(sessionId) {
    const sel = currentSelection();
    const provider = sel ? sel.provider : null;
    const model = sel ? sel.model : null;

    if (provider === PROVIDER_DEEPSEEK) return deepseekStatus(sessionId);
    if (provider === PROVIDER_KIMI) return kimiStatus();

    // 其他 provider：不展示（client 返回 null），但带出当前 provider/model 便于诊断。
    return { ok: true, isSupported: false, provider: provider, model: model };
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/deepseek-balance/status",
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
    "deepseek-balance: /deepseek-balance/status route",
  );
}

export { apply, inject };
