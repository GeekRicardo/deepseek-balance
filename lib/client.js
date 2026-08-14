window.__ModuleLoader__.load({
  id: "deepseek-balance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots"];

    var STYLE_ID = "deepseek-balance-style";
    var cssText =
      ".dsb-readout { display: inline-flex; align-items: center; gap: 10px; font-size: 11px; line-height: 1.5; " +
      "color: var(--dsw-alias-label-secondary); white-space: nowrap; user-select: none; } " +
      ".dsb-readout__item { display: inline-flex; align-items: center; } " +
      ".dsb-readout__dot { width: 6px; height: 6px; border-radius: 50%; margin-right: 5px; flex: none; " +
      "background: var(--dsw-alias-state-success-primary); } " +
      ".dsb-readout__dot--off { background: var(--dsw-alias-state-error-primary); } " +
      ".dsb-readout__dot--muted { background: var(--dsw-alias-label-secondary); } " +
      ".dsb-readout--error { color: var(--dsw-alias-state-error-primary); }";

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
            fetch("/deepseek-balance/status" + qs)
              .then(function (r) {
                return r.json();
              })
              .then(function (res) {
                if (!alive) return;
                if (res && res.ok) setView({ phase: "ok", res: res });
                else setView({ phase: "error", message: (res && res.error) || "查询失败" });
              })
              .catch(function (err) {
                if (!alive) return;
                setView({ phase: "error", message: String((err && err.message) || err) });
              });
          }
          load();
          var timer = setInterval(load, 60000);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        },
        [sessionId],
      );

      if (view.phase === "loading") {
        return React.createElement("span", { className: "dsb-readout" }, "DeepSeek ···");
      }
      if (view.phase === "error") {
        return React.createElement("span", { className: "dsb-readout dsb-readout--error" }, "DeepSeek 状态不可用");
      }

      var res = view.res;

      if (!res.isDeepSeek) {
        return React.createElement(
          "span",
          {
            className: "dsb-readout",
            title: "当前模型：" + (res.model || "未知") + "，非 DeepSeek 官方，不展示余额/花费",
          },
          React.createElement("span", { className: "dsb-readout__dot dsb-readout__dot--muted" }),
          "非 DeepSeek 供应商",
        );
      }

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
            React.createElement(
              "span",
              { className: "dsb-readout__dot" + (available ? "" : " dsb-readout__dot--off") },
            ),
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

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          { name: "conversation.composer.dock", id: "deepseek-balance", order: 10, label: "DeepSeek 余额" },
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
