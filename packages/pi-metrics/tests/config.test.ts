import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_METRICS_CONFIG, loadConfig, parseConfig, saveConfig } from "../src/config.ts";

test("默认启用指标，并在整段停下后才汇总显示", () => {
  assert.deepEqual(DEFAULT_METRICS_CONFIG, { enabled: true, display: "on-stop" });
});

test("读取不到文件时用默认值，写入后按文件配置生效", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-metrics-config-"));
  const path = join(directory, "extensions", "pi-metrics", "config.json");
  try {
    assert.deepEqual(loadConfig(path), { enabled: true, display: "on-stop" });
    saveConfig(parseConfig({ enabled: false, display: "live" }), path);
    assert.deepEqual(loadConfig(path), { enabled: false, display: "live" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("旧配置只写 enabled 时 display 走默认值", () => {
  assert.deepEqual(parseConfig({ enabled: false }), { enabled: false, display: "on-stop" });
});

test("未知字段和非法取值被拒绝", () => {
  assert.throws(() => parseConfig({ unknown: true }), /unknown configuration field/);
  assert.throws(() => parseConfig({ enabled: "yes" }), /enabled must be a boolean/);
  assert.throws(() => parseConfig({ display: "sometimes" }), /display must be one of: live, on-stop/);
});
