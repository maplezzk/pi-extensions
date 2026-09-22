import assert from "node:assert/strict";
import test from "node:test";
import {
  PANEL_FIELD,
  PANEL_FIELD_IDS,
  applyPanelChange,
  buildSettingItems,
  panelToggleLabels,
} from "../src/config-panel.ts";
import { DEFAULT_SESSION_RESOURCES_CONFIG, type SessionResourcesConfig } from "../src/config.ts";
import { i18n } from "../src/i18n.ts";

/** 每个字段都偏离默认值，往返一致才不能靠默认值蒙对。 */
function customConfig(): SessionResourcesConfig {
  return { enabled: false };
}

/** 配置里所有字段名；新增字段而不加面板行时这条断言会失败。 */
const CONFIG_FIELDS: readonly string[] = ["enabled"];

test("面板覆盖配置里的每一个字段", () => {
  assert.deepEqual([...PANEL_FIELD_IDS].sort(), [...CONFIG_FIELDS].sort());
});

test("每一行都有标题、说明和当前值", () => {
  const items = buildSettingItems(customConfig());
  assert.equal(items.length, CONFIG_FIELDS.length);
  for (const item of items) {
    assert.ok(item.label.length > 0, `${item.id} 没有标题`);
    assert.ok((item.description ?? "").length > 0, `${item.id} 没有说明`);
    assert.ok(item.currentValue.length > 0, `${item.id} 没有当前值`);
  }
});

test("开关行用候选值原地切换，回传的是本地化文案", () => {
  const labels = panelToggleLabels();
  const items = buildSettingItems(DEFAULT_SESSION_RESOURCES_CONFIG);
  const enabled = items.find((item) => item.id === PANEL_FIELD.enabled);
  assert.ok(enabled);
  assert.deepEqual(enabled.values, [labels.on, labels.off]);
  assert.equal(enabled.currentValue, labels.on);
});

test("把每一行显示的当前值写回去，配置往返一致", () => {
  const config = customConfig();
  for (const item of buildSettingItems(config)) {
    const next = applyPanelChange(config, item.id, item.currentValue);
    assert.notEqual(next, undefined, `${item.id} 拒绝了自己的当前值`);
    assert.deepEqual(next, config, `${item.id} 往返不一致`);
  }
});

test("开关存的是布尔值，不是本地化文案", () => {
  const labels = panelToggleLabels();
  const off = applyPanelChange(DEFAULT_SESSION_RESOURCES_CONFIG, PANEL_FIELD.enabled, labels.off);
  assert.equal(off?.enabled, false);

  const on = applyPanelChange(customConfig(), PANEL_FIELD.enabled, labels.on);
  assert.equal(on?.enabled, true);
});

test("未知字段或没人提供过的值不写配置", () => {
  assert.equal(applyPanelChange(DEFAULT_SESSION_RESOURCES_CONFIG, "not.a.field", "on"), undefined);
  assert.equal(applyPanelChange(DEFAULT_SESSION_RESOURCES_CONFIG, PANEL_FIELD.enabled, "maybe"), undefined);
});
