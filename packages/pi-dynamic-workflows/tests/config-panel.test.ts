import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_PANEL_IDS,
  applyPanelChange,
  optionLabelForValue,
  toSettingItems,
} from "../src/config-panel.ts";
import { configPath, loadConfig, parseConfig, saveConfig, type WorkflowConfig } from "../src/config.ts";

/** 配置里的字段名；新增字段必须同时出现在面板上，否则这条用例会失败。 */
const CONFIG_FIELDS: readonly string[] = ["backend", "background"];

/** 全部取非默认值，避免往返一致靠默认值蒙对。 */
const CUSTOM_CONFIG: WorkflowConfig = { backend: "subagent", background: true };

/** 开关字段的面板 id。 */
const PANEL_ID_BACKGROUND = "background";

/**
 * 在干净的配置目录下跑一段回调：先清掉会干扰配置读取的环境变量。
 * 返回值就是回调的结果，目录无论成败都会被删掉。
 */
function withIsolatedAgentDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-panel-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousBackend = process.env.PI_WORKFLOW_BACKEND;
  const previousAsync = process.env.PI_WORKFLOW_ASYNC;
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.PI_WORKFLOW_BACKEND;
  delete process.env.PI_WORKFLOW_ASYNC;
  try {
    return run(directory);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousBackend === undefined) delete process.env.PI_WORKFLOW_BACKEND;
    else process.env.PI_WORKFLOW_BACKEND = previousBackend;
    if (previousAsync === undefined) delete process.env.PI_WORKFLOW_ASYNC;
    else process.env.PI_WORKFLOW_ASYNC = previousAsync;
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 面板覆盖的字段 == 配置类型里的字段。 */
test("面板覆盖了配置里的全部字段", () => {
  assert.deepEqual([...CONFIG_PANEL_IDS].sort(), [...CONFIG_FIELDS].sort());
});

/** 每一行都要有标题、说明行和当前值，缺一项在面板上就是空白。 */
test("每一行都带上标题、说明和当前值", () => {
  const items = toSettingItems(CUSTOM_CONFIG);
  assert.equal(items.length, CONFIG_FIELDS.length);
  for (const item of items) {
    assert.ok(item.label.length > 0, `${item.id} 缺少标题`);
    assert.ok((item.description ?? "").length > 0, `${item.id} 缺少说明`);
    assert.ok(item.currentValue.length > 0, `${item.id} 缺少当前值`);
  }
});

/** 枚举项必须给二级列表而不是轮流循环，开关项必须给可循环的取值。 */
test("枚举项提供 submenu，开关项提供 values", () => {
  const items = toSettingItems(CUSTOM_CONFIG);
  const backend = items.find((item) => item.id === "backend");
  const background = items.find((item) => item.id === PANEL_ID_BACKGROUND);
  assert.equal(typeof backend?.submenu, "function");
  assert.equal(backend?.values, undefined);
  assert.equal(background?.submenu, undefined);
  assert.equal(background?.values?.length, 2);
});

/** 取每一行当前显示的文本写回去，配置必须原样保持。 */
test("把每一行的当前显示值写回后配置往返一致", () => {
  for (const config of [CUSTOM_CONFIG, { backend: "workflow", background: false } as WorkflowConfig]) {
    for (const item of toSettingItems(config)) {
      const next = applyPanelChange(config, item.id, item.currentValue);
      assert.notEqual(next, undefined, `${item.id} 拒绝了自己的当前值`);
      assert.deepEqual(next, config, `${item.id} 往返不一致`);
    }
  }
});

/** 面板存的是配置值，不是本地化文案。 */
test("枚举和开关写回的是配置值而不是文案", () => {
  const onLabel = labelOf("on");
  const offLabel = labelOf("off");

  const workflow = applyPanelChange(CUSTOM_CONFIG, "backend", labelOf("configBackendWorkflow"));
  assert.equal(workflow?.backend, "workflow");

  assert.equal(applyPanelChange(CUSTOM_CONFIG, PANEL_ID_BACKGROUND, offLabel)?.background, false);
  assert.equal(
    applyPanelChange({ backend: "workflow", background: false }, PANEL_ID_BACKGROUND, onLabel)?.background,
    true,
  );
  // 候选表里没有的开关文案必须保持不变，而不是默默当成 off。
  assert.equal(applyPanelChange(CUSTOM_CONFIG, PANEL_ID_BACKGROUND, "也许"), undefined);
});

/** 未知字段或候选表外的值一律不写，避免过期面板写进没人提供的配置。 */
test("未知字段和候选表外的值不会改配置", () => {
  assert.equal(applyPanelChange(CUSTOM_CONFIG, "not.a.field", "x"), undefined);
  assert.equal(applyPanelChange(CUSTOM_CONFIG, "backend", "claude"), undefined);
  assert.equal(applyPanelChange(CUSTOM_CONFIG, PANEL_ID_BACKGROUND, "maybe"), undefined);
});

/** 候选表里没有的执行后端原样展示。 */
test("候选表外的执行后端原样展示", () => {
  assert.equal(optionLabelForValue([], "legacy"), "legacy");
});

/** 配置读取走 PI_CODING_AGENT_DIR，面板改动落盘后能重新读出；写盘字段名保持历史 `async`。 */
test("面板改动写入配置目录后可以重新读出", () => {
  withIsolatedAgentDir((directory) => {
    const path = join(directory, "extensions", "pi-dynamic-workflows", "config.json");
    assert.equal(configPath(), path);
    const next = applyPanelChange(loadConfig(), "backend", labelOf("configBackendSubagent"));
    assert.notEqual(next, undefined);
    saveConfig(next as WorkflowConfig);
    assert.deepEqual(loadConfig(), { backend: "subagent", background: false });
    const stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    assert.equal(stored.async, false, "落盘字段名保持历史 async");
    assert.equal(stored.background, undefined);
  });
});

/** 旧的 `async` 写法仍然读得出来，用户既有配置不会失效。 */
test("旧的 async 字段名仍然生效", () => {
  withIsolatedAgentDir((directory) => {
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({ backend: "subagent", async: true }), "utf-8");
    assert.deepEqual(loadConfig(path), { backend: "subagent", background: true });
    assert.deepEqual(parseConfig({ async: true }), { backend: "workflow", background: true });
  });
});

/** 配置可写目录不存在时 saveConfig 自己建目录。 */
test("saveConfig 会建出缺失的目录", () => {
  withIsolatedAgentDir((directory) => {
    const path = join(directory, "nested", "config.json");
    assert.deepEqual(saveConfig({ background: true }, path), { backend: "workflow", background: true });
    assert.deepEqual(loadConfig(path), { backend: "workflow", background: true });
  });
});

/** 取某个文案 key 当前语言的文本。 */
function labelOf(key: string): string {
  const catalog = JSON.parse(
    readFileSync(new URL("../locales/index.json", import.meta.url), "utf-8"),
  ) as Record<string, Record<string, string>>;
  return catalog[key]["zh-CN"];
}
