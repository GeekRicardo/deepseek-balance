// deepseek-balance — host face
//
// 职责（全部进程内、可逆）：
// 1. 监听 `llm/stream` 瀑布事件，按 session 累计 DeepSeek 模型的 token 用量。
// 2. 从 models.dev 拉取 DeepSeek 单价（内存缓存 24h + 硬编码兜底），
//    展示时用最新单价把累计 token 换算成人民币估算花费。
// 3. 通过 credentials 服务读取 DEEPSEEK_API_KEY，curl 官方 /user/balance 查余额。
// 4. 注册 /deepseek-balance/status HTTP route 供 client 轮询。

const inject = ["webServer", "credentials", "subprocess"];

const CNY_PER_USD = 7.2;
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_URL = "https://models.dev/api.json";

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
  const state = { lastModel: null };
  const tokensBySession = new Map();

  function recordUsage(options, usage) {
    if (!usage || !isDeepSeekModel(options && options.model)) return;
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

  // 透传每个 chunk，流结束后把 usage 记入本会话累计；不改变下游语义。
  ctx.on("llm/stream", function (options, next) {
    if (options && typeof options.model === "string") state.lastModel = options.model;
    const upstream = next();
    return (async function* () {
      let usage = null;
      try {
        for await (const chunk of upstream) {
          if (chunk && chunk.type === "usage" && chunk.usage) usage = chunk.usage;
          yield chunk;
        }
      } finally {
        if (usage) {
          try {
            recordUsage(options, usage);
          } catch (error) {
            console.error("deepseek-balance: record usage failed", error);
          }
        }
      }
    })();
  });

  function defaultModel() {
    if (!agentDefaultModel) return null;
    try {
      const sel = agentDefaultModel.currentSelection();
      return sel && typeof sel.model === "string" ? sel.model : null;
    } catch {
      return null;
    }
  }

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

  async function queryBalance() {
    let resolved;
    try {
      resolved = await credentials.resolve("DEEPSEEK_API_KEY");
    } catch {
      return { ok: false, error: "读取凭据失败" };
    }
    if (!resolved || !resolved.value) return { ok: false, error: "未配置 DEEPSEEK_API_KEY" };

    // 密钥经 curl 的 stdin config 注入，避免出现在 argv（ps 可见）。
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

  async function getStatus(sessionId) {
    const key = sessionId ? String(sessionId) : "__global__";
    const model = state.lastModel || defaultModel();
    const tokens = tokensBySession.get(key) || {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      requests: 0,
    };

    if (!isDeepSeekModel(model)) {
      return { ok: true, isDeepSeek: false, model: model || null, requests: tokens.requests };
    }

    await ensurePricing();
    const p = matchPricing(model);
    const usd =
      (p ? p.input : 0) * (tokens.inputTokens / 1000000) +
      (p ? p.cacheRead : 0) * (tokens.cacheReadTokens / 1000000) +
      (p ? p.output : 0) * (tokens.outputTokens / 1000000);
    const spendCny = round2(usd * CNY_PER_USD);

    const balance = await queryBalance();
    return {
      ok: true,
      isDeepSeek: true,
      model: model,
      spendCny: spendCny,
      requests: tokens.requests,
      pricingSource: pricing.source,
      balance: balance.ok ? balance.body : null,
      balanceError: balance.ok ? null : balance.error,
    };
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
