import test from "node:test";
import assert from "node:assert/strict";
import { toNum, round2, isDeepSeekModel, isDeepSeekProvider, codexWindowName } from "../lib/index.js";

test("toNum 兼容字符串与数字", () => {
  assert.equal(toNum("69"), 69);
  assert.equal(toNum(3.14), 3.14);
  assert.equal(toNum("abc"), null);
  assert.equal(toNum(null), null);
});

test("round2 保留两位小数", () => {
  assert.equal(round2(1.234), 1.23);
  assert.equal(round2(0.005), 0.01);
});

test("isDeepSeekModel 前缀匹配", () => {
  assert.equal(isDeepSeekModel("deepseek-v4-flash"), true);
  assert.equal(isDeepSeekModel("kimi-k3"), false);
});

test("isDeepSeekProvider 兼容两条官方路由", () => {
  assert.equal(isDeepSeekProvider("deepseek"), true);
  assert.equal(isDeepSeekProvider("deepseek-official"), true);
  assert.equal(isDeepSeekProvider("kimi-coding"), false);
});

test("codexWindowName 窗口秒数映射", () => {
  assert.deepEqual(codexWindowName(18000), { label: "5小时", key: "5h" });
  assert.deepEqual(codexWindowName(604800), { label: "7天", key: "7d" });
  assert.deepEqual(codexWindowName(2592000), { label: "30天", key: "30d" });
  assert.deepEqual(codexWindowName(3600), { label: "1小时", key: "1h" });
});
