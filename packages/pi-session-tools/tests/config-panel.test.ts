import assert from "node:assert/strict";
import test from "node:test";
import {
  FORCE_OFF_VALUE,
  PANEL_FIELD,
  PANEL_FIELD_IDS,
  applyPanelChange,
  buildSettingItems,
  forceOptions,
  formatRatioLabel,
  optionLabelForValue,
  parseThresholdText,
  serializeThresholdText,
  type SessionToolsPanelConfig,
} from "../src/config-panel.ts";
import { i18n } from "../src/i18n.ts";

/** 每个字段都偏离默认值，往返一致才不能靠默认值蒙对。 */
function customConfig(): SessionToolsPanelConfig {
  return {
    squashContextThresholds: parseThresholdText("150k,75%"),
    forceSquashContextThreshold: 0.75,
  };
}

/** 配置文件里所有字段名；新增字段而不加面板行时这条断言会失败。 */
const CONFIG_FIELDS: readonly string[] = [
  "squashContextThresholds",
  "forceSquashContextThreshold",
];

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

test("强制比例行给的是候选列表，而不是原地循环", () => {
  const items = buildSettingItems(customConfig());
  const force = items.find((item) => item.id === PANEL_FIELD.force);
  assert.ok(force);
  assert.equal(force.values, undefined, "强制比例应由二级列表接管 Enter");
  assert.ok(typeof force.submenu === "function");
  assert.equal(force.currentValue, formatRatioLabel(0.75));
});

test("阈值行给的是预填输入框，而不是候选列表", () => {
  const items = buildSettingItems(customConfig());
  const thresholds = items.find((item) => item.id === PANEL_FIELD.thresholds);
  assert.ok(thresholds);
  assert.equal(thresholds.currentValue, "150k, 75%");
  assert.ok(typeof thresholds.submenu === "function");
});

test("把每一行显示的当前值写回去，配置往返一致", () => {
  const config = customConfig();
  for (const item of buildSettingItems(config)) {
    const next = applyPanelChange(config, item.id, item.currentValue);
    assert.notEqual(next, undefined, `${item.id} 拒绝了自己的当前值`);
    assert.deepEqual(next, config, `${item.id} 往返不一致`);
  }
});

test("不在候选表里的强制比例仍然显示且能原样写回", () => {
  const config: SessionToolsPanelConfig = {
    squashContextThresholds: parseThresholdText("200k"),
    forceSquashContextThreshold: 0.42,
  };
  const force = buildSettingItems(config).find((item) => item.id === PANEL_FIELD.force);
  assert.ok(force);
  assert.equal(force.currentValue, formatRatioLabel(0.42));
  const next = applyPanelChange(config, PANEL_FIELD.force, force.currentValue);
  assert.deepEqual(next, config);
});

test("选「关闭强制」写入 null，选百分比写入数字", () => {
  const off = applyPanelChange(customConfig(), PANEL_FIELD.force, i18n.t("configForceOff"));
  assert.equal(off?.forceSquashContextThreshold, null);

  const on = applyPanelChange(
    customConfig(),
    PANEL_FIELD.force,
    formatRatioLabel(0.9),
  );
  assert.equal(on?.forceSquashContextThreshold, 0.9);
});

test("阈值文本解析回结构化数组，且保留 k 与百分比形态", () => {
  assert.deepEqual(parseThresholdText("150k, 75%"), [
    { kind: "tokens", value: 150000 },
    { kind: "percent", value: 75 },
  ]);
  assert.equal(serializeThresholdText(parseThresholdText("1.5k")), "1.5k");
});

test("未知字段、没人提供过的比例、解析不出阈值的文本都不写配置", () => {
  assert.equal(applyPanelChange(customConfig(), "not.a.field", "x"), undefined);
  assert.equal(applyPanelChange(customConfig(), PANEL_FIELD.force, "43%"), undefined);
  assert.equal(applyPanelChange(customConfig(), PANEL_FIELD.thresholds, "soon"), undefined);
  assert.equal(applyPanelChange(customConfig(), PANEL_FIELD.thresholds, ""), undefined);
});

test("「关闭强制」始终是候选列表的第一项", () => {
  const options = forceOptions(null);
  assert.equal(options[0]?.value, FORCE_OFF_VALUE);
  assert.equal(options[0]?.label, i18n.t("configForceOff"));
  assert.equal(optionLabelForValue(options, FORCE_OFF_VALUE), i18n.t("configForceOff"));
});
