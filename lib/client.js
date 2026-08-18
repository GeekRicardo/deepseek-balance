window.__ModuleLoader__.load({
  id: "dsh-balance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots"];

    var STYLE_ID = "dsh-balance-style";
    var cssText =
      ".dsb-readout { display: inline-flex; align-items: center; gap: 10px; font-size: 11px; line-height: 1.5; " +
      "color: var(--dsw-alias-label-secondary); white-space: nowrap; user-select: none; } " +
      ".dsb-readout__item { display: inline-flex; align-items: center; gap: 4px; } " +
      ".dsb-readout__dot { width: 6px; height: 6px; border-radius: 50%; margin-right: 5px; flex: none; " +
      "background: var(--dsw-alias-state-success-primary); } " +
      ".dsb-readout__dot--off { background: var(--dsw-alias-state-error-primary); } " +
      ".dsb-readout__dot--muted { background: var(--dsw-alias-label-secondary); } " +
      ".dsb-readout--error { color: var(--dsw-alias-state-error-primary); } " +
      ".dsb-readout__pct { font-weight: 600; font-variant-numeric: tabular-nums; } " +
      ".dsb-pct-ok { color: var(--dsw-alias-state-success-primary); } " +
      ".dsb-pct-warn { color: #d97706; } " +
      ".dsb-pct-crit { color: var(--dsw-alias-state-error-primary); } " +
      ".dsb-readout__ago { color: var(--dsw-alias-label-secondary); }";

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = cssText;
      document.head.appendChild(style);
    }

    function fmtMoney(cny) {
      var n = Number(cny);
      var val = n === n ? n : 0;
      if (val > 0 && val < 0.01) return "¥" + val.toFixed(4);
      return "¥" + val.toFixed(2);
    }

    function currencySymbol(code) {
      if (code === "CNY") return "¥";
      if (code === "USD") return "$";
      if (code === "EUR") return "€";
      return code + " ";
    }

    // ── DeepSeek 读数 ────────────────────────────────────────

    function DeepSeekReadout(res) {
      var items = [];
      var pricingTitle = res.pricingSource === "live" ? "定价来自 models.dev（实时）" : "定价来自内置兜底";

      items.push(
        React.createElement(
          "span",
          {
            key: "spend",
            className: "dsb-readout__item",
            title: "本会话估算花费（" + res.requests + " 次请求，" + pricingTitle + "）",
          },
          React.createElement("span", { className: "dsb-readout__dot" }),
          "本会话 " + fmtMoney(res.spendCny),
        ),
      );

      if (res.balance) {
        var infos = Array.isArray(res.balance.balance_infos) ? res.balance.balance_infos : [];
        var parts = infos.map(function (info) {
          var sym = currencySymbol(info.currency || "CNY");
          var n = Number(info.total_balance);
          var text = n === n ? sym + n.toFixed(2) : String(info.total_balance);
          return (info.currency || "") + " " + text;
        });
        var available = res.balance.is_available !== false;
        items.push(
          React.createElement(
            "span",
            { key: "balance", className: "dsb-readout__item", title: "DeepSeek 账户余额" },
            React.createElement("span", { className: "dsb-readout__dot" + (available ? "" : " dsb-readout__dot--off") }),
            "余额 " + (parts.length ? parts.join(" · ") : "—"),
          ),
        );
      } else {
        items.push(
          React.createElement(
            "span",
            { key: "balance", className: "dsb-readout__item dsb-readout--error", title: res.balanceError || "余额不可用" },
            "余额不可用",
          ),
        );
      }

      return React.createElement("span", { className: "dsb-readout" }, items);
    }

    // ── Kimi Coding 读数（对齐 cc-switch SubscriptionQuotaFooter）──

    function countdownStr(resetsAt) {
      if (!resetsAt) return null;
      var t = Date.parse(resetsAt);
      if (t !== t) return null;
      var diffMs = t - Date.now();
      if (diffMs <= 0) return null;
      var hours = Math.floor(diffMs / 3600000);
      var minutes = Math.floor((diffMs % 3600000) / 60000);
      if (hours > 24) return Math.floor(hours / 24) + "d" + (hours % 24) + "h";
      if (hours > 0) return hours + "h" + minutes + "m";
      return minutes + "m";
    }

    function agoStr(queriedAt) {
      if (!queriedAt) return null;
      var diff = Math.floor((Date.now() - queriedAt) / 1000);
      if (diff < 0) return "刚刚";
      if (diff < 60) return "刚刚";
      if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
      if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
      return Math.floor(diff / 86400) + "天前";
    }

    function pctClass(u) {
      var v = Number(u);
      if (v !== v) return "dsb-pct-ok";
      if (v >= 90) return "dsb-pct-crit";
      if (v >= 70) return "dsb-pct-warn";
      return "dsb-pct-ok";
    }

    function fmtPct(u) {
      var v = Number(u);
      return v === v ? Math.round(v) + "%" : "—";
    }

    function fmtInt(n) {
      var v = Number(n);
      return v === v ? String(Math.round(v)) : "—";
    }

    function fmtTime(iso) {
      try {
        var d = new Date(iso);
        return d.getTime() !== d.getTime() ? iso : d.toLocaleString();
      } catch {
        return iso;
      }
    }

    function membershipName(level) {
      if (typeof level !== "string") return null;
      return level.indexOf("LEVEL_") === 0 ? level.slice(6) : level;
    }

    function KimiReadout(res) {
      var fh = res.fiveHour;
      var wk = res.weekly;

      if (!fh && !wk) {
        return React.createElement(
          "span",
          { className: "dsb-readout dsb-readout--error", title: res.balanceError || "用量不可用" },
          "余额不可用",
        );
      }

      var tip = [];
      if (fh) {
        tip.push(
          "5小时：已用 " + fmtInt(fh.used) + "/" + fmtInt(fh.limit) + "（剩 " + fmtInt(fh.remaining) + "）" +
          (fh.resetsAt ? "，重置 " + fmtTime(fh.resetsAt) : ""),
        );
      }
      if (wk) {
        tip.push(
          "7天：已用 " + fmtInt(wk.used) + "/" + fmtInt(wk.limit) + "（剩 " + fmtInt(wk.remaining) + "）" +
          (wk.resetsAt ? "，重置 " + fmtTime(wk.resetsAt) : ""),
        );
      }
      var mem = membershipName(res.membership);
      if (mem) tip.push("会员 " + mem);

      var items = [];
      if (fh) {
        var fhCd = countdownStr(fh.resetsAt);
        items.push(
          React.createElement(
            "span",
            { key: "fh", className: "dsb-readout__item" },
            "5小时 ",
            React.createElement("span", { className: "dsb-readout__pct " + pctClass(fh.utilization) }, fmtPct(fh.utilization)),
            fhCd ? " " + fhCd : "",
          ),
        );
      }
      if (wk) {
        var wkCd = countdownStr(wk.resetsAt);
        items.push(
          React.createElement(
            "span",
            { key: "wk", className: "dsb-readout__item" },
            "7天 ",
            React.createElement("span", { className: "dsb-readout__pct " + pctClass(wk.utilization) }, fmtPct(wk.utilization)),
            wkCd ? " " + wkCd : "",
          ),
        );
      }
      var ago = agoStr(res.queriedAt);
      if (ago) items.push(React.createElement("span", { key: "ago", className: "dsb-readout__item dsb-readout__ago" }, ago));

      return React.createElement("span", { className: "dsb-readout", title: tip.join("\n") }, items);
    }

    // ── OpenCode Go 读数（5小时 / 7天 / 30天 + 刷新时间）────

    function OpencodeReadout(res) {
      var w = res.windows;
      if (!w || (!w.rolling && !w.weekly && !w.monthly)) {
        return React.createElement(
          "span",
          { className: "dsb-readout dsb-readout--error", title: res.balanceError || "用量不可用" },
          "余额不可用",
        );
      }

      var tip = [];
      var labelOf = { rolling: "5小时", weekly: "7天", monthly: "30天" };
      var usedUsdOf = function (win, key) {
        if (!win || win.percent === null || win.percent === undefined || !win.limitUsd) return null;
        return (Number(win.percent) / 100 * Number(win.limitUsd)).toFixed(2);
      };
      for (var k of ["rolling", "weekly", "monthly"]) {
        var win = w[k];
        if (!win) continue;
        var usd = usedUsdOf(win, k);
        tip.push(
          labelOf[k] + "：已用 " + fmtPct(win.percent) + (usd !== null ? "（$" + usd + "/$" + fmtInt(win.limitUsd) + "）" : "") +
          (win.resetsAt ? "，重置 " + fmtTime(win.resetsAt) : ""),
        );
      }

      var items = [];
      for (var k2 of ["rolling", "weekly", "monthly"]) {
        var win2 = w[k2];
        if (!win2) continue;
        var cd = countdownStr(win2.resetsAt);
        items.push(
          React.createElement(
            "span",
            { key: k2, className: "dsb-readout__item" },
            labelOf[k2] + " ",
            React.createElement("span", { className: "dsb-readout__pct " + pctClass(win2.percent) }, fmtPct(win2.percent)),
            cd ? " " + cd : "",
          ),
        );
      }
      var ago = agoStr(res.queriedAt);
      if (ago) items.push(React.createElement("span", { key: "ago", className: "dsb-readout__item dsb-readout__ago" }, ago));

      return React.createElement("span", { className: "dsb-readout", title: tip.join("\n") }, items);
    }

    // ── 统一读数（按 provider 分发）──────────────────────────

    function StatusReadout(props) {
      var sessionId = props && props.sessionId;
      var viewState = React.useState({ phase: "loading" });
      var view = viewState[0];
      var setView = viewState[1];

      React.useEffect(
        function () {
          var alive = true;
          function load() {
            var qs = sessionId ? "?sessionId=" + encodeURIComponent(String(sessionId)) : "";
            fetch("/dsh-balance/status" + qs)
              .then(function (r) {
                return r.json();
              })
              .then(function (res) {
                if (!alive) return;
                if (res && res.ok) setView({ phase: "ok", res: res });
                else setView({ phase: "error" });
              })
              .catch(function () {
                if (!alive) return;
                setView({ phase: "error" });
              });
          }
          load();
          // 2 秒轮询：切换 provider/对话后最多 2 秒更新；余额/用量实际 5 分钟才重新查（host 端缓存）。
          var timer = setInterval(load, 2000);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        },
        [sessionId],
      );

      // 加载中 / 异常 / 不支持的 provider 一律不渲染。
      if (view.phase !== "ok") return null;
      var res = view.res;
      if (!res.isSupported) return null;

      if (res.provider === "deepseek") return DeepSeekReadout(res);
      if (res.provider === "kimi-coding") return KimiReadout(res);
      if (res.provider === "opencode-go") return OpencodeReadout(res);
      return null;
    }

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          { name: "conversation.composer.dock", id: "dsh-balance", order: 10, label: "余额" },
          function (props) {
            return React.createElement(StatusReadout, { sessionId: props && props.sessionId });
          },
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
