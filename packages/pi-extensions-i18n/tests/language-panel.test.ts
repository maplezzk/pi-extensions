import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, getKeybindings } from "@earendil-works/pi-tui";
import {
  LANGUAGE_PANEL_FIELD,
  LANGUAGE_PANEL_FIELD_IDS,
  buildLanguageSettingItems,
  languageLabelForValue,
  languageValueFromLabel,
  type PanelTranslator,
} from "../src/language-panel.ts";
import {
  SUPPORTED_LOCALES,
  loadCatalog,
  type Locale,
} from "../src/index.ts";

// 不读本机真实配置：把 Pi 的 agent 目录指向临时目录。
const agentDir = mkdtempSync(join(tmpdir(), "pi-extensions-i18n-panel-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

/** 语言面板的文案目录就是命令用的 command.json。 */
const catalog = loadCatalog(new URL("../locales/command.json", import.meta.url));

/** 固定用中文目录做断言，避免跟随本机 locale 变化。 */
const translator: PanelTranslator = {
  /** 从固定 zh-CN 取文案，方便断言展示文本。 */
  t: (key) => catalog[key]?.["zh-CN"] ?? key,
};

test("语言面板覆盖配置里的全部字段", () => {
  // 共享语言只有一个可配置字段：locale。
  const configFields: readonly string[] = ["locale"];
  assert.deepEqual([...LANGUAGE_PANEL_FIELD_IDS].sort(), [...configFields].sort());
});

test("面板只有一行、带标题与说明，并显示当前语言", () => {
  for (const preference of ["zh-CN", "en-US", "auto"] as const) {
    const items = buildLanguageSettingItems(translator, preference);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.id, LANGUAGE_PANEL_FIELD);
    assert.ok(item.label.length > 0);
    assert.ok((item.description ?? "").length > 0);
    assert.equal(item.currentValue, languageLabelForValue(translator, preference));
  }
});

test("三个语言选项都能按展示文本往返回取值", () => {
  for (const preference of ["zh-CN", "en-US", "auto"] as const) {
    const label = languageLabelForValue(translator, preference);
    assert.equal(languageValueFromLabel(label, translator), preference);
  }
});

test("候选表覆盖全部受支持语言加 auto", () => {
  const labels = (["zh-CN", "en-US", "auto"] as const).map((value) =>
    languageLabelForValue(translator, value),
  );
  assert.equal(new Set(labels).size, labels.length);
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(labels.includes(languageLabelForValue(translator, locale)));
  }
  assert.ok(labels.includes(languageLabelForValue(translator, "auto")));
});

test("未知展示文本不写回，未知取值原样显示", () => {
  assert.equal(languageValueFromLabel("Klingon", translator), undefined);
  assert.equal(languageLabelForValue(translator, "xx-YY"), "xx-YY");
});

test("catalog 的 panelDesc 在 zh-CN 与 en-US 都有，否则目录校验会失败", () => {
  const entry = catalog["panelDesc"];
  assert.ok(entry, "panelDesc missing from command.json");
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok((entry[locale as Locale] ?? "").length > 0, `panelDesc missing ${locale}`);
  }
});

test("用键盘选定子菜单回传展示文案，反查得到真正要写的取值", () => {
  initTheme();
  // 建真实 SettingsList 行，模拟「回车开子菜单 → 下移 → 回车选定」。
  const items = buildLanguageSettingItems(translator, "zh-CN");
  let changedTo: string | undefined;
  const list = new SettingsList(
    items,
    1,
    getSettingsListTheme(),
    (_id, newValue) => { changedTo = languageValueFromLabel(newValue, translator); },
    () => undefined,
  );
  const enter = "\r";
  const down = "\u001b[B";
  assert.ok(getKeybindings().matches(enter, "tui.select.confirm"));
  assert.ok(getKeybindings().matches(down, "tui.select.down"));
  list.handleInput(enter);
  list.handleInput(down);
  list.handleInput(enter);
  assert.equal(changedTo, "en-US");
});
