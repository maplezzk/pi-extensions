import assert from "node:assert/strict";
import test from "node:test";
import {
  PANEL_FIELD,
  PANEL_FIELD_IDS,
  applyPanelChange,
  argsToText,
  buildSettingItems,
  textToArgs,
} from "../src/config-panel.ts";
import { DEFAULT_NOTIFICATION_CONFIG, type NotificationConfig } from "../src/config.ts";
import { i18n } from "../src/i18n.ts";

/** 每项都偏离默认值的配置，避免往返测试因为值恰好相同而蒙混过关。 */
function customConfig(): NotificationConfig {
  return {
    enabled: false,
    adapter: { command: "notify-send", args: ["{title}", "{message}"] },
    timeoutMs: 30000,
  };
}

/** 配置里的全部字段名，新增字段必须同时出现在面板上。 */
const CONFIG_FIELDS: readonly string[] = [
  "enabled",
  "adapter.command",
  "adapter.args",
  "timeoutMs",
];

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

test("开关与枚举回传的是取值而不是本地化文案", () => {
  const off = applyPanelChange(DEFAULT_NOTIFICATION_CONFIG, PANEL_FIELD.enabled, i18n.t("configOff"));
  assert.equal(off?.enabled, false);

  const on = applyPanelChange(customConfig(), PANEL_FIELD.enabled, i18n.t("configOn"));
  assert.equal(on?.enabled, true);

  const fifty = applyPanelChange(DEFAULT_NOTIFICATION_CONFIG, PANEL_FIELD.timeoutMs, "5000");
  assert.equal(fifty?.timeoutMs, 5000);
});

test("未知字段或未提供的取值不修改配置", () => {
  assert.equal(applyPanelChange(DEFAULT_NOTIFICATION_CONFIG, "not.a.field", "x"), undefined);
  assert.equal(applyPanelChange(DEFAULT_NOTIFICATION_CONFIG, PANEL_FIELD.timeoutMs, "9999"), undefined);
  assert.equal(applyPanelChange(DEFAULT_NOTIFICATION_CONFIG, PANEL_FIELD.enabled, "maybe"), undefined);
});

test("文本字段写回时去掉首尾空白，参数按逗号切分", () => {
  const command = applyPanelChange(DEFAULT_NOTIFICATION_CONFIG, PANEL_FIELD.command, "  notify-send  ");
  assert.equal(command?.adapter.command, "notify-send");

  const args = applyPanelChange(DEFAULT_NOTIFICATION_CONFIG, PANEL_FIELD.args, " -title , {title} ,, ");
  assert.deepEqual(args?.adapter.args, ["-title", "{title}"]);
});

test("非法输入被拒绝，不会写入坏配置", () => {
  // 空命令违反 config.ts 的校验，面板必须保持原值而不是存下来。
  assert.equal(applyPanelChange(DEFAULT_NOTIFICATION_CONFIG, PANEL_FIELD.command, "   "), undefined);
});

test("参数数组与面板文本互相转换", () => {
  assert.equal(argsToText(["-title", "{title}"]), "-title, {title}");
  assert.deepEqual(textToArgs("-title, {title}"), ["-title", "{title}"]);
});
