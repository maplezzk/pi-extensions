import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import {
  PANEL_FIELD,
  PANEL_FIELD_IDS,
  applyPanelChange,
  buildSettingItems,
  optionLabelForValue,
} from "../src/config-panel.ts";
import { DEFAULT_TITLE_CONFIG, parseConfig, type NamingConfig } from "../src/config.ts";
import { i18n } from "../src/i18n.ts";

// 测试不读本机真实配置：把 Pi 的 agent 目录指向临时目录。
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-naming-panel-"));

/** 每个字段都偏离默认值，往返测试才不会靠巧合通过。 */
function customConfig(): NamingConfig {
  return parseConfig({
    automaticNaming: false,
    manualNaming: false,
    targets: { session: false, workspace: false, tab: false },
    title: {
      maxLength: 60,
      preferredLength: 40,
      language: "English",
      instructions: "Use sentence case",
      timeoutMs: 30_000,
      maxTokens: 4096,
      effort: "high",
    },
  });
}

/** 配置里全部可与面板对应的字段名，新增字段却忘了加面板行时会失败。 */
const CONFIG_FIELDS: readonly string[] = [
  "automaticNaming",
  "manualNaming",
  "targets.session",
  "targets.workspace",
  "targets.tab",
  "title.maxLength",
  "title.preferredLength",
  "title.language",
  "title.instructions",
  "title.timeoutMs",
  "title.maxTokens",
  "title.effort",
];

test("面板覆盖配置里的每一个字段", () => {
  assert.deepEqual([...PANEL_FIELD_IDS].sort(), [...CONFIG_FIELDS].sort());
});

test("每一行都有标题、说明和当前值", () => {
  const items = buildSettingItems(customConfig());
  assert.equal(items.length, CONFIG_FIELDS.length);
  for (const item of items) {
    assert.ok(item.label.length > 0, `${item.id} has no label`);
    assert.ok((item.description ?? "").length > 0, `${item.id} has no description`);
    assert.ok(item.currentValue.length > 0, `${item.id} has no current value`);
  }
});

test("空的文本字段显示为未设置而不是空白", () => {
  const items = buildSettingItems(parseConfig({}));
  const instructions = items.find((item) => item.id === PANEL_FIELD.instructions);
  assert.equal(instructions?.currentValue, i18n.t("panelValueUnset"));
});

test("每一项取当前显示值写回都能往返一致", () => {
  const config = customConfig();
  for (const item of buildSettingItems(config)) {
    const next = applyPanelChange(config, item.id, item.currentValue);
    assert.notEqual(next, undefined, `${item.id} rejected its own current value`);
    assert.deepEqual(next, config, `${item.id} did not round-trip`);
  }
});

test("开关项存的是配置值，不是本地化文案", () => {
  const off = applyPanelChange(parseConfig({}), PANEL_FIELD.automaticNaming, i18n.t("configOff"));
  assert.equal(off?.automaticNaming, false);
  const on = applyPanelChange(customConfig(), PANEL_FIELD.manualNaming, i18n.t("configOn"));
  assert.equal(on?.manualNaming, true);
});

test("自定义语言代码即使不在预设里也能往返", () => {
  const config = parseConfig({ title: { language: "pt-BR" } });
  const item = buildSettingItems(config).find((entry) => entry.id === PANEL_FIELD.language);
  assert.equal(item?.currentValue, "pt-BR");
  const next = applyPanelChange(config, PANEL_FIELD.language, "pt-BR");
  assert.equal(next?.title.language, "pt-BR");
});

test("未知字段或非法取值不改动配置", () => {
  assert.equal(applyPanelChange(parseConfig({}), "title.unknown", "x"), undefined);
  assert.equal(applyPanelChange(parseConfig({}), PANEL_FIELD.effort, "none"), undefined);
  // 首选长度 40 大于默认最大长度 15，校验拒绝，面板不能把非法值写进去。
  const tooLong = applyPanelChange(parseConfig({}), PANEL_FIELD.preferredLength, "40");
  assert.equal(tooLong, undefined);
});

test("合法但不在候选表里的数值被明确拒绝，不做静默截断", () => {
  assert.equal(applyPanelChange(parseConfig({}), PANEL_FIELD.maxLength, "9999"), undefined);
});

test("面板行标签用本地化文案，配置里从不存界面文字", () => {
  const items = buildSettingItems(parseConfig({}));
  const effort = items.find((item) => item.id === PANEL_FIELD.effort);
  assert.equal(effort?.currentValue, "low");
  assert.notEqual(optionLabelForValue([], "low"), i18n.t("configOn"));
  assert.equal(parseConfig({}).title.effort, DEFAULT_TITLE_CONFIG.effort);
});

test("用键盘在真实 SettingsList 上切换开关，回传文案能反查回布尔值", () => {
  initTheme();
  const config = parseConfig({});
  let changedTo: NamingConfig | undefined;
  const list = new SettingsList(
    buildSettingItems(config),
    12,
    getSettingsListTheme(),
    (id, newValue) => { changedTo = applyPanelChange(config, id, newValue); },
    () => undefined,
  );
  // 第一行是「自动命名」，空格/回车原地切换，回传的是本地化开关文案。
  list.handleInput("\r");
  assert.equal(changedTo?.automaticNaming, false);
});

test("文本字段的子菜单预填当前值，敲进去的内容能写回配置", () => {
  initTheme();
  const config = parseConfig({ title: { instructions: "old note" } });
  const item = buildSettingItems(config).find((entry) => entry.id === PANEL_FIELD.instructions)!;
  let written: string | undefined;
  const submenu = item.submenu!(i18n.t("panelValueUnset"), (value) => { written = value; });
  // 预填内容的游标停在开头，先用 delete-to-line-end 清掉，再输入新文本。
  submenu.handleInput("\u000b");
  submenu.handleInput("new note");
  submenu.handleInput("\r");
  assert.equal(written, "new note");
  assert.equal(applyPanelChange(config, PANEL_FIELD.instructions, written!)?.title.instructions, "new note");
});
