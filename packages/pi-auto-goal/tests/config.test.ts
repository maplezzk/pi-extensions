import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTO_GOAL_CONFIG, loadConfig, parseConfig } from "../src/config.ts";

test("空配置回落默认值，且默认允许自动催停两次", () => {
  assert.deepEqual(parseConfig({}), DEFAULT_AUTO_GOAL_CONFIG);
  assert.equal(DEFAULT_AUTO_GOAL_CONFIG.enabled, true);
  assert.equal(DEFAULT_AUTO_GOAL_CONFIG.maxAutoContinues, 2);
});

test("布尔、字符串与数值字段按类型校验", () => {
  assert.equal(parseConfig({ enabled: false }).enabled, false);
  assert.equal(parseConfig({ includeToolTrace: false }).includeToolTrace, false);
  assert.equal(parseConfig({ notifyOnStopDecision: true }).notifyOnStopDecision, true);
  assert.equal(parseConfig({ maxAutoContinues: 0 }).maxAutoContinues, 0);
  assert.equal(parseConfig({ maxAutoContinues: 5 }).maxAutoContinues, 5);
  assert.equal(parseConfig({ confidenceThreshold: 1 }).confidenceThreshold, 1);
  assert.equal(parseConfig({ timeoutSeconds: 2 }).timeoutSeconds, 2);
  assert.equal(parseConfig({ continueMessageTemplate: "继续：{reason}" }).continueMessageTemplate, "继续：{reason}");
  assert.equal(parseConfig({ forcedDecision: "continue" }).forcedDecision, "continue");
  assert.equal(parseConfig({ forcedDecision: "stop" }).forcedDecision, "stop");

  for (const value of [
    { enabled: "true" },
    { includeToolTrace: 1 },
    { maxAutoContinues: -1 },
    { maxAutoContinues: 1.5 },
    { maxToolTraceEntries: -1 },
    { maxUserRequestChars: 0 },
    { confidenceThreshold: -0.1 },
    { confidenceThreshold: 1.1 },
    { confidenceThreshold: "0.6" },
    { timeoutSeconds: 0 },
    { timeoutSeconds: 601 },
    { continueMessageTemplate: 1 },
    { model: 1 },
    { forcedDecision: "yes" },
    { forcedDecision: 1 },
    null,
    [],
    "config",
    { unknown: true },
  ]) {
    assert.throws(() => parseConfig(value), /must be|unknown configuration field|configuration/);
  }
});

test("model 字段接受 provider/modelId 或留空", () => {
  assert.equal(parseConfig({ model: "" }).model, "");
  assert.equal(parseConfig({ model: "openai/gpt-5-mini" }).model, "openai/gpt-5-mini");
  assert.equal(parseConfig({ model: "  anthropic/claude-haiku  " }).model, "anthropic/claude-haiku");
  for (const model of ["gpt-5-mini", "/model", "provider/", "provider model/id"]) {
    assert.throws(() => parseConfig({ model }), /model must look like/);
  }
});

test("配置读取：文件不存在用默认，损坏内容显式报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-goal-config-"));
  try {
    assert.deepEqual(loadConfig(join(dir, "missing.json")), DEFAULT_AUTO_GOAL_CONFIG);
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ maxAutoContinues: 3 }));
    assert.equal(loadConfig(path).maxAutoContinues, 3);
    writeFileSync(path, "{");
    assert.throws(() => loadConfig(path));
    assert.throws(() => loadConfig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
