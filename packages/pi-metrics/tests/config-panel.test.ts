import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_PANEL_IDS,
  applyPanelChange,
  optionLabelForValue,
  toSettingItems,
} from "../src/config-panel.ts";
import { configPath, loadConfig, saveConfig, type MetricsConfig } from "../src/config.ts";
import { i18n } from "../src/i18n.ts";

/** 配置里的字段名；新增字段必须同时出现在面板上，否则这条用例会失败。 */
const CONFIG_FIELDS: readonly string[] = ["enabled", "display"];

/** 全部取非默认值，避免往返一致靠默认值蒙对。 */
const CUSTOM_CONFIG: MetricsConfig = { enabled: false, display: "live" };

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

/** 开关项必须给出可循环的取值，枚举项必须给二级列表而不是轮流循环。 */
test("开关项提供 values，枚举项提供 submenu", () => {
  const items = toSettingItems(CUSTOM_CONFIG);
  const enabled = items.find((item) => item.id === "enabled");
  const display = items.find((item) => item.id === "display");
  assert.deepEqual(enabled?.values, [i18n.t("configOn"), i18n.t("configOff")]);
  assert.equal(enabled?.submenu, undefined);
  assert.equal(typeof display?.submenu, "function");
  assert.equal(display?.values, undefined);
});

/** 取每一行当前显示的文本写回去，配置必须原样保持。 */
test("把每一行的当前显示值写回后配置往返一致", () => {
  for (const config of [CUSTOM_CONFIG, { enabled: true, display: "on-stop" } as MetricsConfig]) {
    for (const item of toSettingItems(config)) {
      const next = applyPanelChange(config, item.id, item.currentValue);
      assert.notEqual(next, undefined, `${item.id} 拒绝了自己的当前值`);
      assert.deepEqual(next, config, `${item.id} 往返不一致`);
    }
  }
});

/** 面板存的是配置值，不是本地化文案。 */
test("开关和枚举写回的是配置值而不是文案", () => {
  assert.equal(applyPanelChange(CUSTOM_CONFIG, "enabled", i18n.t("configOff"))?.enabled, false);
  assert.equal(applyPanelChange(CUSTOM_CONFIG, "enabled", i18n.t("configOn"))?.enabled, true);
  assert.equal(applyPanelChange(CUSTOM_CONFIG, "display", i18n.t("configDisplayLive"))?.display, "live");
  assert.equal(
    applyPanelChange(CUSTOM_CONFIG, "display", i18n.t("configDisplayOnStop"))?.display,
    "on-stop",
  );
});

/** 未知字段或候选表外的值一律不写，避免过期面板写进没人提供的配置。 */
test("未知字段和候选表外的值不会改配置", () => {
  assert.equal(applyPanelChange(CUSTOM_CONFIG, "not.a.field", "x"), undefined);
  assert.equal(applyPanelChange(CUSTOM_CONFIG, "display", "sometimes"), undefined);
  assert.equal(applyPanelChange(CUSTOM_CONFIG, "enabled", "yes"), undefined);
});

/** 候选表里没有的显示值原样展示，面板不会把它显示成空白。 */
test("候选表外的显示值原样展示", () => {
  assert.equal(optionLabelForValue([], "legacy"), "legacy");
});

/** 配置读取走 PI_CODING_AGENT_DIR，且面板改动落盘后能重新读出来。 */
test("面板改动写入配置目录后可以重新读出", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-metrics-panel-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const path = join(directory, "extensions", "pi-metrics", "config.json");
    assert.equal(configPath(), path);
    const next = applyPanelChange(loadConfig(), "enabled", i18n.t("configOff"));
    assert.notEqual(next, undefined);
    saveConfig(next as MetricsConfig);
    assert.deepEqual(loadConfig(), { enabled: false, display: "on-stop" });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
