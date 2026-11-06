import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AUTO_GOAL_CONFIG, parseConfig, type AutoGoalConfig } from "../src/config.ts";
import {
  applyPanelChange,
  CONFIG_PANEL_IDS,
  filterOptions,
  panelToggleLabels,
  toSettingItems,
} from "../src/config-panel.ts";
import { i18n } from "../src/i18n.ts";

/** 面板上出现的字段顺序；面板加项或换序必须同步这里。 */
const EXPECTED_IDS = [
  "enabled",
  "model",
  "maxAutoContinues",
  "confidenceThreshold",
  "judgeMaxTokens",
  "showVerdictNotice",
];

/** 走二级列表的字段（其余是开关）。 */
const SUBMENU_IDS = ["model", "maxAutoContinues", "confidenceThreshold", "judgeMaxTokens"];

/** 没有可用模型时的候选：只剩「当前会话模型」一项。 */
const NO_MODELS: ReadonlyArray<{ provider: string; id: string }> = [];

/** 造一份指定配置的副本，避免测试之间互相污染。 */
function configWith(patch: Partial<AutoGoalConfig>): AutoGoalConfig {
  return { ...DEFAULT_AUTO_GOAL_CONFIG, ...patch };
}

/** 按 id 取面板项；缺项直接失败，避免测试里到处判空。 */
function itemOf(config: AutoGoalConfig, id: string) {
  const item = toSettingItems(config, NO_MODELS).find((entry) => entry.id === id);
  assert.ok(item, `面板缺少配置项 ${id}`);
  return item;
}

test("面板覆盖开关、模型与三个数值字段，且没有重复项", () => {
  assert.deepEqual(CONFIG_PANEL_IDS, EXPECTED_IDS);
  assert.equal(new Set(CONFIG_PANEL_IDS).size, CONFIG_PANEL_IDS.length);
});

test("每个面板项都有本地化标题、说明与当前值", () => {
  const items = toSettingItems(configWith({ enabled: false, showVerdictNotice: false }), NO_MODELS);
  assert.equal(items.length, CONFIG_PANEL_IDS.length);

  for (const item of items) {
    assert.ok(item.label.trim().length > 0, `${item.id} 缺标题`);
    assert.ok((item.description ?? "").trim().length > 0, `${item.id} 缺说明`);
    assert.notEqual(item.label, item.description, `${item.id} 的标题与说明不该相同`);
  }
});

test("开关项显示当前值，回车在开与关之间切换", () => {
  const labels = panelToggleLabels();
  const enabled = itemOf(configWith({ enabled: false }), "enabled");

  assert.equal(enabled.currentValue, labels.off);
  assert.deepEqual(enabled.values, [labels.on, labels.off]);
  assert.equal(enabled.submenu, undefined);

  const verdictNotice = itemOf(configWith({ showVerdictNotice: false }), "showVerdictNotice");
  assert.equal(verdictNotice.currentValue, labels.off);
});

test("模型项与数值项走二级列表，不靠回车循环取值", () => {
  for (const id of SUBMENU_IDS) {
    const item = itemOf(DEFAULT_AUTO_GOAL_CONFIG, id);
    assert.equal(typeof item.submenu, "function", `${id} 应该打开二级列表`);
    assert.equal(item.values, undefined, `${id} 不应该循环取值`);
  }
});

test("数值项的当前值按候选文案显示，无上限显示为「不限制」", () => {
  assert.equal(itemOf(DEFAULT_AUTO_GOAL_CONFIG, "maxAutoContinues").currentValue, "2");
  assert.equal(
    itemOf(configWith({ maxAutoContinues: 0 }), "maxAutoContinues").currentValue,
    i18n.t("configUnlimited"),
  );
  assert.equal(itemOf(DEFAULT_AUTO_GOAL_CONFIG, "confidenceThreshold").currentValue, "0.6");
  assert.equal(itemOf(DEFAULT_AUTO_GOAL_CONFIG, "judgeMaxTokens").currentValue, "2000");
});

test("手工改过的值不在候选表里也原样显示，不显示成空白", () => {
  assert.equal(itemOf(configWith({ confidenceThreshold: 0.65 }), "confidenceThreshold").currentValue, "0.65");
  assert.equal(itemOf(configWith({ judgeMaxTokens: 3000 }), "judgeMaxTokens").currentValue, "3000");
});

test("模型项显示当前会话模型或具体模型标识", () => {
  const reuseLabel = i18n.t("configModelCurrent");
  assert.equal(itemOf(DEFAULT_AUTO_GOAL_CONFIG, "model").currentValue, reuseLabel);
  assert.equal(itemOf(configWith({ model: "p/m" }), "model").currentValue, "p/m");
});

test("选中开关文案写回布尔值", () => {
  const labels = panelToggleLabels();
  const disabled = applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "enabled", labels.off);
  const noticeOff = applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "showVerdictNotice", labels.off);

  assert.equal(disabled?.enabled, false);
  assert.equal(noticeOff?.showVerdictNotice, false);
  // 其余字段保持不变。
  assert.equal(disabled?.maxAutoContinues, DEFAULT_AUTO_GOAL_CONFIG.maxAutoContinues);
});

test("选中数值文案写回数字，且结果仍在合法区间内", () => {
  const unlimited = applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "maxAutoContinues", i18n.t("configUnlimited"));
  const limit = applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "maxAutoContinues", "5");
  const threshold = applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "confidenceThreshold", "0.7");
  const tokens = applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "judgeMaxTokens", "4000");

  assert.equal(unlimited?.maxAutoContinues, 0);
  assert.equal(limit?.maxAutoContinues, 5);
  assert.equal(threshold?.confidenceThreshold, 0.7);
  assert.equal(tokens?.judgeMaxTokens, 4000);

  // 写回的结果必须能通过配置校验，面板不能绕过 parseConfig。
  for (const next of [unlimited, limit, threshold, tokens]) {
    assert.deepEqual(parseConfig(next), next);
  }
});

test("选中「当前会话模型」写回空字符串，选中具体模型写回模型标识", () => {
  const reused = applyPanelChange(configWith({ model: "p/m" }), "model", i18n.t("configModelCurrent"));
  const picked = applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "model", "p/other");

  assert.equal(reused?.model, "");
  assert.equal(picked?.model, "p/other");
});

test("无法识别的字段或文案不做改动", () => {
  assert.equal(applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "unknownField", "开"), undefined);
  assert.equal(applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "enabled", "maybe"), undefined);
  assert.equal(applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "judgeMaxTokens", "无数值"), undefined);
});

test("二级列表回车选中当前值对应的那一项", () => {
  const item = toSettingItems(DEFAULT_AUTO_GOAL_CONFIG, [{ provider: "llm-proxy", id: "LOW" }]).find(
    (entry) => entry.id === "model",
  );
  assert.ok(item?.submenu);

  const selected: string[] = [];
  const submenu = item.submenu("", (value?: string) => {
    if (value !== undefined) selected.push(value);
  });
  // 列表刚打开时选中项就是当前值，直接回车等于不改动。
  submenu.handleInput("\r");

  assert.deepEqual(selected, [i18n.t("configModelCurrent")]);
  assert.equal(applyPanelChange(DEFAULT_AUTO_GOAL_CONFIG, "model", selected[0] ?? "")?.model, "");
});

test("模型列表可以直接打字过滤，不用逐条翻", () => {
  const item = toSettingItems(DEFAULT_AUTO_GOAL_CONFIG, [
    { provider: "llm-proxy", id: "LOW" },
    { provider: "cider", id: "gpt-5" },
  ]).find((entry) => entry.id === "model");
  assert.ok(item?.submenu);

  const selected: string[] = [];
  const submenu = item.submenu("", (value?: string) => {
    if (value !== undefined) selected.push(value);
  });
  // 「low」不是任何候选的前缀，靠模糊匹配才能命中 llm-proxy/LOW。
  for (const char of "low") submenu.handleInput(char);
  submenu.handleInput("\r");

  assert.deepEqual(selected, ["llm-proxy/LOW"]);
});

test("过滤按关键词缩小候选，空关键词不丢任何项", () => {
  const options = [
    { label: i18n.t("configModelCurrent"), value: "" },
    { label: "llm-proxy/LOW", value: "llm-proxy/LOW" },
    { label: "cider/gpt-5", value: "cider/gpt-5" },
  ];
  assert.deepEqual(
    filterOptions(options, "low").map((option) => option.value),
    ["llm-proxy/LOW"],
  );
  assert.deepEqual(
    filterOptions(options, "gpt").map((option) => option.value),
    ["cider/gpt-5"],
  );
  assert.equal(filterOptions(options, "").length, options.length);
  assert.equal(filterOptions(options, "   ").length, options.length);
  assert.deepEqual(filterOptions(options, "nothing-matches"), []);
});
