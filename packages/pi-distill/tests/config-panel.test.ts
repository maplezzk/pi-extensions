/**
 * pi-distill 配置面板的单元测试。
 *
 * 不打网络、不读本机真实配置：配置读写都走临时目录，模型列表由测试自己造。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getDistillConfigPath, loadDistillConfig } from "../src/summary-utils.ts";
import {
  PANEL_FIELD,
  PANEL_FIELD_IDS,
  applyPanelChange,
  buildSettingItems,
  defaultToolEnabled,
  filterOptions,
  isCustomValueValid,
  panelCurrentModelLabel,
  panelToggleLabels,
  toolFieldId,
  toolNameFromFieldId,
  type DistillPanelConfig,
  type ModelRef,
  type PanelOption,
} from "../src/config-panel.ts";

// 面板构造 SettingsList 时要取主题色，测试进程里先初始化一次。
initTheme();
process.env.PI_EXTENSIONS_LOCALE = "en-US";

/** 配置里的固定字段清单；面板漏一项就会在这里失败。 */
const CONFIG_FIELDS: readonly string[] = [
  "enabled",
  "model",
  "minChars",
  "maxChars",
  "maxOutputChars",
  "timeoutSeconds",
  "timeoutRetryCount",
  "errorRetryCount",
  "missedCompressionRatio",
  "summarizeErrors",
  "render.enabled",
  "render.showPrompt",
  "render.showResult",
];

/** 每个字段都取了非默认值，往返测试才不会碰巧通过。 */
function customConfig(): DistillPanelConfig {
  return {
    enabled: false,
    model: "llm-proxy/LOW",
    minChars: 111,
    maxChars: 22222,
    maxOutputChars: 3333,
    timeoutSeconds: 7,
    timeoutRetryCount: 2,
    errorRetryCount: 3,
    missedCompressionRatio: 4.5,
    summarizeErrors: false,
    renderEnabled: false,
    renderShowPrompt: false,
    renderShowResult: false,
    tools: { bash: false },
  };
}

/** 测试用的可用模型。 */
const MODELS: readonly ModelRef[] = [
  { provider: "llm-proxy", id: "LOW" },
  { provider: "llm-proxy", id: "DEFAULT" },
  { provider: "cider", id: "gpt-5" },
];

/** 测试用的可用工具名。 */
const TOOL_NAMES: readonly string[] = ["bash", "custom-tool", "edit", "write"];

/** 按 id 取面板项；缺项直接失败，避免测试里到处判空。 */
function itemOf(config: DistillPanelConfig, id: string) {
  const item = buildSettingItems(config, MODELS, TOOL_NAMES).find((entry) => entry.id === id);
  assert.ok(item, `panel is missing item ${id}`);
  return item;
}

test("面板覆盖配置里的每一个字段，固定字段与工具字段都不重不漏", () => {
  assert.deepEqual([...PANEL_FIELD_IDS].sort(), [...CONFIG_FIELDS].sort());

  const ids = buildSettingItems(customConfig(), MODELS, TOOL_NAMES).map((item) => item.id);
  const expected = [...CONFIG_FIELDS, ...TOOL_NAMES.map(toolFieldId)];
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, ids.length, "panel rows must be unique");
});

test("工具字段名可以还原出工具名", () => {
  assert.equal(toolFieldId("custom-tool"), "tools.custom-tool");
  assert.equal(toolNameFromFieldId("tools.custom-tool"), "custom-tool");
  assert.equal(toolNameFromFieldId("enabled"), undefined);
});

test("每个面板项都有本地化标题、说明和当前值", () => {
  for (const item of buildSettingItems(customConfig(), MODELS, TOOL_NAMES)) {
    assert.ok(item.label.trim().length > 0, `${item.id} has no label`);
    assert.ok((item.description ?? "").trim().length > 0, `${item.id} has no description`);
    assert.ok(item.currentValue.trim().length > 0, `${item.id} has no current value`);
  }
});

test("开关字段用 values 原地切换，枚举字段用二级列表", () => {
  const toggles = [
    PANEL_FIELD.enabled,
    PANEL_FIELD.summarizeErrors,
    PANEL_FIELD.renderEnabled,
    PANEL_FIELD.renderShowPrompt,
    PANEL_FIELD.renderShowResult,
    toolFieldId("bash"),
  ];
  const labels = panelToggleLabels();
  for (const id of toggles) {
    const item = itemOf(customConfig(), id);
    assert.deepEqual(item.values, [labels.on, labels.off], `${id} should cycle in place`);
    assert.equal(item.submenu, undefined, `${id} should not open a submenu`);
  }

  const choices = [
    PANEL_FIELD.model,
    PANEL_FIELD.minChars,
    PANEL_FIELD.maxChars,
    PANEL_FIELD.maxOutputChars,
    PANEL_FIELD.timeoutSeconds,
    PANEL_FIELD.timeoutRetryCount,
    PANEL_FIELD.errorRetryCount,
    PANEL_FIELD.missedCompressionRatio,
  ];
  for (const id of choices) {
    const item = itemOf(customConfig(), id);
    assert.equal(typeof item.submenu, "function", `${id} should open a submenu`);
    assert.equal(item.values, undefined, `${id} should not cycle in place`);
  }
});

test("每个字段「取当前显示值写回」都能往返一致", () => {
  const config = customConfig();
  for (const item of buildSettingItems(config, MODELS, TOOL_NAMES)) {
    const next = applyPanelChange(config, item.id, item.currentValue, MODELS);
    assert.notEqual(next, undefined, `${item.id} rejected its own current value`);
    assert.equal(readField(next!, item.id), readField(config, item.id), `${item.id} did not round-trip`);
  }
});

/** 从配置里按字段名取值；工具字段读 tools 映射（未配置时取默认开关），其余读固定字段。 */
function readField(config: DistillPanelConfig, id: string): string {
  const toolName = toolNameFromFieldId(id);
  if (toolName !== undefined) return String(config.tools[toolName] ?? defaultToolEnabled(toolName));
  switch (id) {
    case PANEL_FIELD.enabled:
      return String(config.enabled);
    case PANEL_FIELD.model:
      return config.model;
    case PANEL_FIELD.minChars:
      return String(config.minChars);
    case PANEL_FIELD.maxChars:
      return String(config.maxChars);
    case PANEL_FIELD.maxOutputChars:
      return String(config.maxOutputChars);
    case PANEL_FIELD.timeoutSeconds:
      return String(config.timeoutSeconds);
    case PANEL_FIELD.timeoutRetryCount:
      return String(config.timeoutRetryCount);
    case PANEL_FIELD.errorRetryCount:
      return String(config.errorRetryCount);
    case PANEL_FIELD.missedCompressionRatio:
      return String(config.missedCompressionRatio);
    case PANEL_FIELD.summarizeErrors:
      return String(config.summarizeErrors);
    case PANEL_FIELD.renderEnabled:
      return String(config.renderEnabled);
    case PANEL_FIELD.renderShowPrompt:
      return String(config.renderShowPrompt);
    case PANEL_FIELD.renderShowResult:
      return String(config.renderShowResult);
    default:
      throw new Error(`unknown field ${id}`);
  }
}

test("开关与模型存的是值而不是本地化文案", () => {
  const labels = panelToggleLabels();
  assert.equal(applyPanelChange(customConfig(), PANEL_FIELD.enabled, labels.on)?.enabled, true);
  assert.equal(applyPanelChange(customConfig(), PANEL_FIELD.enabled, labels.off)?.enabled, false);
  assert.equal(
    applyPanelChange(customConfig(), toolFieldId("bash"), labels.on)?.tools.bash,
    true,
  );
  assert.equal(
    applyPanelChange(customConfig(), PANEL_FIELD.model, panelCurrentModelLabel())?.model,
    "",
  );
  assert.equal(
    applyPanelChange(customConfig(), PANEL_FIELD.model, "cider/gpt-5")?.model,
    "cider/gpt-5",
  );
});

test("非法或不认识的输入一律拒绝，不改配置", () => {
  const config = customConfig();
  assert.equal(applyPanelChange(config, "not.a.field", "x", MODELS), undefined);
  assert.equal(applyPanelChange(config, PANEL_FIELD.enabled, "maybe", MODELS), undefined);
  assert.equal(applyPanelChange(config, PANEL_FIELD.model, "not-a-reference", MODELS), undefined);
  assert.equal(applyPanelChange(config, PANEL_FIELD.minChars, "-5", MODELS), undefined);
  assert.equal(applyPanelChange(config, PANEL_FIELD.minChars, "abc", MODELS), undefined);
  assert.equal(applyPanelChange(config, PANEL_FIELD.timeoutRetryCount, "1.5", MODELS), undefined);
});

test("手动输入的数值与模型按原值校验后写回", () => {
  assert.equal(isCustomValueValid(PANEL_FIELD.minChars, "123"), true);
  assert.equal(isCustomValueValid(PANEL_FIELD.minChars, "0"), true);
  assert.equal(isCustomValueValid(PANEL_FIELD.minChars, "-1"), false);
  assert.equal(isCustomValueValid(PANEL_FIELD.minChars, "1.5"), false);
  assert.equal(isCustomValueValid(PANEL_FIELD.errorRetryCount, "2"), true);
  assert.equal(isCustomValueValid(PANEL_FIELD.model, "provider/model"), true);
  assert.equal(isCustomValueValid(PANEL_FIELD.model, ""), true);
  assert.equal(isCustomValueValid(PANEL_FIELD.model, "no-slash"), false);

  assert.equal(applyPanelChange(customConfig(), PANEL_FIELD.maxChars, "4242", MODELS)?.maxChars, 4242);
  assert.equal(
    applyPanelChange(customConfig(), PANEL_FIELD.missedCompressionRatio, "1.4", MODELS)
      ?.missedCompressionRatio,
    1.4,
  );
  // 数值字段不接受 0；区间下界是正数。
  assert.equal(applyPanelChange(customConfig(), PANEL_FIELD.timeoutSeconds, "0", MODELS), undefined);
  assert.equal(applyPanelChange(customConfig(), PANEL_FIELD.errorRetryCount, "0", MODELS)?.errorRetryCount, 0);
});

test("模型与数值候选可以按任意片段搜索，不只前缀", () => {
  const options: PanelOption[] = [
    { label: panelCurrentModelLabel(), value: "" },
    { label: "llm-proxy/LOW", value: "llm-proxy/LOW" },
    { label: "llm-proxy/DEFAULT", value: "llm-proxy/DEFAULT" },
    { label: "cider/gpt-5", value: "cider/gpt-5" },
  ];

  // SelectList.setFilter 只认前缀，输入 low 找不到 llm-proxy/LOW；模糊匹配能找到。
  assert.deepEqual(
    filterOptions(options, "low").map((option) => option.value),
    ["llm-proxy/LOW"],
  );
  assert.deepEqual(
    filterOptions(options, "gpt").map((option) => option.value),
    ["cider/gpt-5"],
  );
  const proxies = filterOptions(options, "proxy").map((option) => option.value);
  assert.equal(proxies.length, 2);
  assert.ok(proxies.includes("llm-proxy/LOW"));
  assert.ok(proxies.includes("llm-proxy/DEFAULT"));

  assert.equal(filterOptions(options, "").length, options.length);
  assert.equal(filterOptions(options, "   ").length, options.length);
  assert.deepEqual(filterOptions(options, "nothing-matches"), []);
});

test("配置写盘后能被 loadDistillConfig 读回，且默认值不同才写入 tools", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-distill-panel-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const configPath = getDistillConfigPath(process.env);
    await mkdir(join(agentDir, "extensions", "pi-distill"), { recursive: true });
    // write 默认关闭、bash 默认开启：只有 bash 关掉才值得写进文件。
    const next = applyPanelChange(customConfig(), toolFieldId("bash"), panelToggleLabels().off, MODELS);
    assert.ok(next);
    const panelConfig = { ...next!, model: "llm-proxy/LOW" };
    assert.equal(panelConfig.tools.bash, false);

    await writeFile(
      configPath,
      `${JSON.stringify({
        enabled: panelConfig.enabled,
        model: panelConfig.model,
        minChars: panelConfig.minChars,
        maxChars: panelConfig.maxChars,
        maxOutputChars: panelConfig.maxOutputChars,
        timeoutSeconds: panelConfig.timeoutSeconds,
        timeoutRetryCount: panelConfig.timeoutRetryCount,
        errorRetryCount: panelConfig.errorRetryCount,
        missedCompressionRatio: panelConfig.missedCompressionRatio,
        summarizeErrors: panelConfig.summarizeErrors,
        tools: { bash: { enabled: false } },
        render: {
          enabled: panelConfig.renderEnabled,
          showPrompt: panelConfig.renderShowPrompt,
          showResult: panelConfig.renderShowResult,
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const saved = loadDistillConfig(process.env, configPath);
    assert.deepEqual(saved.warnings, []);
    assert.equal(saved.enabled, false);
    assert.equal(saved.config?.modelProvider, "llm-proxy");
    assert.equal(saved.config?.modelId, "LOW");
    assert.equal(saved.config?.minChars, 111);
    assert.equal(saved.config?.maxOutputChars, 3333);
    assert.equal(saved.config?.summarizeErrors, false);
    assert.deepEqual(saved.config?.tools, { bash: { enabled: false } });
    assert.deepEqual(saved.render, { enabled: false, showPrompt: false, showResult: false });
    assert.match(await readFile(configPath, "utf8"), /"model": "llm-proxy\/LOW"/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
