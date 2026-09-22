import assert from "node:assert/strict";
import test from "node:test";
import {
  PANEL_FIELD,
  PANEL_FIELD_IDS,
  applyPanelChange,
  buildSettingItems,
  rootsToText,
  textToRoots,
} from "../src/config-panel.ts";
import type { NestedSkillsConfig } from "../src/config.ts";
import { i18n } from "../src/i18n.ts";

/** 偏离默认值的配置，避免往返测试因为值恰好相同而蒙混过关。 */
function customConfig(): NestedSkillsConfig {
  return { skillRoots: ["skills", "~/shared-skills"] };
}

/** 配置里的全部字段名，新增字段必须同时出现在面板上。 */
const CONFIG_FIELDS: readonly string[] = ["skillRoots"];

test("面板覆盖配置里的每一个字段", () => {
  assert.deepEqual([...PANEL_FIELD_IDS].sort(), [...CONFIG_FIELDS].sort());
});

test("每一行都有标签、说明和当前值", () => {
  const items = buildSettingItems(customConfig());
  assert.equal(items.length, CONFIG_FIELDS.length);
  for (const item of items) {
    assert.ok(item.label.length > 0, `${item.id} 缺少标签`);
    assert.ok((item.description ?? "").length > 0, `${item.id} 缺少说明`);
    assert.ok(item.currentValue.length > 0, `${item.id} 缺少当前值`);
  }
});

test("取每一行显示的当前值写回，配置保持不变", () => {
  const config = customConfig();
  for (const item of buildSettingItems(config)) {
    const next = applyPanelChange(config, item.id, item.currentValue);
    assert.notEqual(next, undefined, `${item.id} 拒绝了自己的当前值`);
    assert.deepEqual(next, config, `${item.id} 未能在往返中保持一致`);
  }
});

test("根目录按逗号切分写回，忽略空白和空项", () => {
  const next = applyPanelChange(customConfig(), PANEL_FIELD.skillRoots, " a ,b , ,c ");
  assert.deepEqual(next?.skillRoots, ["a", "b", "c"]);
});

test("未知字段不修改配置，清空根目录得到空数组", () => {
  assert.equal(applyPanelChange(customConfig(), "not.a.field", "x"), undefined);
  // 清空是合法状态：配置读作空数组，加载时扫描不到任何技能。
  assert.deepEqual(applyPanelChange(customConfig(), PANEL_FIELD.skillRoots, "   ")?.skillRoots, []);
  assert.deepEqual(applyPanelChange(customConfig(), PANEL_FIELD.skillRoots, ",, ,")?.skillRoots, []);
});

test("空配置的当前值显示为未设置", () => {
  const items = buildSettingItems({ skillRoots: [] });
  const roots = items.find((item) => item.id === PANEL_FIELD.skillRoots);
  assert.equal(roots?.currentValue, i18n.t("configValueUnset"));
});

test("根目录数组与面板文本互相转换", () => {
  assert.equal(rootsToText(["skills", "~/shared-skills"]), "skills, ~/shared-skills");
  assert.deepEqual(textToRoots("skills, ~/shared-skills"), ["skills", "~/shared-skills"]);
});
