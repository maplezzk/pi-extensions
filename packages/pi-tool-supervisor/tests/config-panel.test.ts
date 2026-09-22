/**
 * pi-tool-supervisor 配置面板的测试。
 *
 * 只验证纯函数层：字段覆盖、每个字段「取当前显示值写回」能往返一致、
 * 展示文本与写回值的映射、可搜索模型列表的过滤行为。
 * 不打开 TUI，也不读本机真实 config.json —— PI_CODING_AGENT_DIR 指向临时目录。
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	PANEL_FIELD_IDS,
	REVIEWER_CONFIG_FIELD_IDS,
	REVIEWER_FIELD,
	ROOT_CONFIG_FIELD_IDS,
	ROOT_FIELD,
	applyReviewerChange,
	applyRootChange,
	buildReviewerItems,
	buildRootItems,
	filterOptions,
	parseListValue,
	displayListValue,
	type ModelRef,
	type PanelOption,
} from "../src/config-panel.ts";
import {
	DEFAULT_TYPESAFE_MODEL,
	type FileEditReviewConfig,
	type FileEditReviewReviewerConfig,
} from "../src/review-utils.ts";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

// 面板文案在测试里要能取到，指向临时 agent 目录以免读用户真实配置。
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-panel-"));
const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

/** `FileEditReviewConfig` 的顶层键；新增字段后必须同步加面板行，这份列表就是断言依据。 */
const ROOT_CONFIG_KEYS: readonly string[] = [
	"enabled",
	"timeoutSeconds",
	"maxFileContextChars",
	"maxRuleLines",
	"typesafe.apiKey",
	"typesafe.endpoint",
];

/** 面板提供给测试的可用模型。 */
const MODELS: readonly ModelRef[] = [
	{ provider: "llm-proxy", model: "LOW" },
	{ provider: "llm-proxy", model: "DEFAULT" },
	{ provider: "cider", model: "gpt-5" },
];

/** 一份每个值都远离默认值的配置，往返测试才不会碰巧通过。 */
function customConfig(): FileEditReviewConfig {
	return {
		enabled: true,
		timeoutSeconds: 60,
		maxFileContextChars: 20_000,
		maxRuleLines: 200,
		typesafe: { apiKey: "apik-from-config", endpoint: "http://127.0.0.1:9/v1" },
		reviewers: [customReviewer()],
	};
}

/** 一个字段都被改过的对话模型 reviewer。 */
function customReviewer(): FileEditReviewReviewerConfig {
	return {
		name: "java-quality",
		model: "llm-proxy/LOW",
		rulesFiles: ["rules/java.md", "rules/general.md"],
		enabled: false,
		filePatterns: ["**/*.java"],
		tools: ["edit"],
		trigger: "before",
		condition: "./conditions/java.js",
	};
}

/** 一个字段都被改过的 TypeSafe reviewer。 */
function typesafeReviewer(): FileEditReviewReviewerConfig {
	return {
		name: "taste",
		backend: "typesafe",
		typesafeModel: "jev-latest",
		rulesFiles: ["rules/taste.md"],
		enabled: true,
		filePatterns: [],
		tools: ["*"],
		trigger: "after",
	};
}

test("面板覆盖配置的每一个顶层字段", () => {
	assert.deepEqual([...ROOT_CONFIG_FIELD_IDS].sort(), [...ROOT_CONFIG_KEYS].sort());
});

test("面板覆盖 reviewer 的全部可编辑字段", () => {
	const covered = PANEL_FIELD_IDS
		.filter((id) => id.startsWith("reviewer."))
		.map((id) => id.slice("reviewer.".length))
		.sort();
	assert.deepEqual(covered, [...REVIEWER_CONFIG_FIELD_IDS].sort());
});

test("面板顶层行包含每个配置字段、每个 reviewer 和「添加」入口", () => {
	const items = buildRootItems({ config: customConfig() });
	assert.equal(items.length, ROOT_CONFIG_KEYS.length + 1 + 1);
	for (const id of ROOT_CONFIG_FIELD_IDS) {
		assert.ok(items.some((item) => item.id === id), `顶层缺少 ${id}`);
	}
	assert.ok(items.some((item) => item.id === "reviewer:java-quality"), "顶层没有列出 reviewer");
	assert.ok(items.some((item) => item.id === ROOT_FIELD.addReviewer), "顶层没有「添加 reviewer」入口");
});

test("顶层每一行都有标题、说明和当前值", () => {
	for (const item of buildRootItems({ config: customConfig() })) {
		assert.ok(item.label.length > 0, `${item.id} 没有标题`);
		assert.ok((item.description ?? "").length > 0, `${item.id} 没有说明`);
		assert.ok(item.currentValue.length > 0, `${item.id} 没有当前值`);
	}
});

test("reviewer 字段页的每一行都有标题、说明和当前值", () => {
	for (const reviewer of [customReviewer(), typesafeReviewer()]) {
		for (const item of buildReviewerItems(reviewer, MODELS)) {
			assert.ok(item.label.length > 0, `${item.id} 没有标题`);
			assert.ok((item.description ?? "").length > 0, `${item.id} 没有说明`);
			assert.ok(item.currentValue.length > 0, `${item.id} 没有当前值`);
		}
	}
});

test("对话模型 reviewer 显示模型行，TypeSafe reviewer 显示 TypeSafe 模型行", () => {
	const modelIds = buildReviewerItems(customReviewer(), MODELS).map((item) => item.id);
	assert.ok(modelIds.includes(REVIEWER_FIELD.model));
	assert.ok(!modelIds.includes(REVIEWER_FIELD.typesafeModel));

	const typesafeIds = buildReviewerItems(typesafeReviewer(), MODELS).map((item) => item.id);
	assert.ok(typesafeIds.includes(REVIEWER_FIELD.typesafeModel));
	assert.ok(!typesafeIds.includes(REVIEWER_FIELD.model));
});

test("取当前显示值写回，顶层每个字段都能往返一致", () => {
	const config = customConfig();
	for (const item of buildRootItems({ config })) {
		if (item.id === ROOT_FIELD.addReviewer || item.id.startsWith("reviewer:")) continue;
		const next = applyRootChange(config, item.id, item.currentValue);
		assert.notEqual(next, undefined, `${item.id} 拒绝了自己的当前值`);
		assert.deepEqual(next, config, `${item.id} 没有往返一致`);
	}
});

test("取当前显示值写回，reviewer 每个可编辑字段都能往返一致", () => {
	for (const reviewer of [customReviewer(), typesafeReviewer()]) {
		for (const item of buildReviewerItems(reviewer, MODELS)) {
			if (item.id === REVIEWER_FIELD.remove) continue;
			const next = applyReviewerChange(reviewer, item.id, item.currentValue);
			assert.notEqual(next, undefined, `${reviewer.name}.${item.id} 拒绝了自己的当前值`);
			assert.deepEqual(next, reviewer, `${reviewer.name}.${item.id} 没有往返一致`);
		}
	}
});

test("空闲的 TypeSafe 字段不会让顶层往返失败", () => {
	const { typesafe: _unused, ...withoutTypesafe } = customConfig();
	const config: FileEditReviewConfig = withoutTypesafe;
	const items = buildRootItems({ config });
	for (const item of items.filter((candidate) => candidate.id.startsWith("typesafe."))) {
		assert.equal(item.currentValue, i18n.t("panelValueUnset"));
		assert.deepEqual(applyRootChange(config, item.id, item.currentValue), config);
	}
});

test("下拉与开关写回的是机器值，不是本地化文案", () => {
	const off = applyReviewerChange(customReviewer(), REVIEWER_FIELD.enabled, i18n.t("panelOff"));
	assert.equal(off?.enabled, false);

	const on = applyReviewerChange({ ...customReviewer(), enabled: false }, REVIEWER_FIELD.enabled, i18n.t("panelOn"));
	assert.equal(on?.enabled, true);

	const before = applyReviewerChange(customReviewer(), REVIEWER_FIELD.trigger, i18n.t("panelTriggerAfter"));
	assert.equal(before?.trigger, "after");

	const typesafe = applyReviewerChange(customReviewer(), REVIEWER_FIELD.backend, i18n.t("backendTypesafe"));
	assert.equal(typesafe?.backend, "typesafe");
	// 切到 TypeSafe 会清掉对话模型字段并补上默认 TypeSafe 模型，避免两个引擎字段并存。
	assert.equal(typesafe?.model, undefined);
	assert.equal(typesafe?.typesafeModel, DEFAULT_TYPESAFE_MODEL);

	const back = applyReviewerChange(typesafeReviewer(), REVIEWER_FIELD.backend, i18n.t("backendModel"));
	assert.equal(back?.backend, undefined);
});

test("切回对话模型时没有可用模型就保持不变，不会写出半成品配置", () => {
	const withoutModel: FileEditReviewReviewerConfig = { ...typesafeReviewer() };
	assert.equal(applyReviewerChange(withoutModel, REVIEWER_FIELD.backend, i18n.t("backendModel")), undefined);
});

test("未知字段或没人提供过的候选值不会改配置", () => {
	assert.equal(applyReviewerChange(customReviewer(), "not.a.field", "x"), undefined);
	assert.equal(applyReviewerChange(customReviewer(), REVIEWER_FIELD.trigger, "sometime"), undefined);
	assert.equal(applyReviewerChange(customReviewer(), REVIEWER_FIELD.enabled, "maybe"), undefined);
	assert.equal(applyRootChange(customConfig(), "not.a.field", "x"), undefined);
	// 超时不接受任意数字：只能选候选表里的值。
	assert.equal(applyRootChange(customConfig(), ROOT_FIELD.timeoutSeconds, "7"), undefined);
});

test("模型字段只接受 provider/model 形式", () => {
	assert.equal(applyReviewerChange(customReviewer(), REVIEWER_FIELD.model, "no-slash")?.model, undefined);
	const picked = applyReviewerChange(customReviewer(), REVIEWER_FIELD.model, "cider/gpt-5");
	assert.equal(picked?.model, "cider/gpt-5");
});

test("数组字段解析与展示是一对往返", () => {
	assert.deepEqual(parseListValue("a.md, b.md ,"), ["a.md", "b.md"]);
	assert.deepEqual(parseListValue(""), []);
	assert.equal(displayListValue([]), i18n.t("panelValueUnset"));
	assert.equal(displayListValue(["a.md", "b.md"]), "a.md, b.md");
});

test("工具范围填 * 时只剩一个通配项，避免与具体工具重复", () => {
	const tools = applyReviewerChange(customReviewer(), REVIEWER_FIELD.tools, "edit, write, *");
	assert.deepEqual(tools?.tools, ["*"]);
});

test("规则文件与工具范围不接受空值", () => {
	assert.equal(applyReviewerChange(customReviewer(), REVIEWER_FIELD.rulesFiles, "  "), undefined);
	assert.equal(applyReviewerChange(customReviewer(), REVIEWER_FIELD.tools, ""), undefined);
	// 文件匹配可以为空：空数组表示匹配全部文件。
	assert.deepEqual(applyReviewerChange(customReviewer(), REVIEWER_FIELD.filePatterns, "")?.filePatterns, []);
});

test("名称不接受空值", () => {
	assert.equal(applyReviewerChange(customReviewer(), REVIEWER_FIELD.name, "   "), undefined);
	assert.equal(applyReviewerChange(customReviewer(), REVIEWER_FIELD.name, " quality ")?.name, "quality");
});

test("条件模块留空就删掉该键，而不是存一个空串", () => {
	const cleared = applyReviewerChange(customReviewer(), REVIEWER_FIELD.condition, "");
	assert.equal(cleared?.condition, undefined);
	assert.ok(!Object.hasOwn(cleared ?? {}, "condition"));
});

test("把 typesafe 两个字段都清空后整个 typesafe 块消失", () => {
	const keyOnly = applyRootChange(customConfig(), ROOT_FIELD.typesafeApiKey, "");
	assert.deepEqual(keyOnly?.typesafe, { endpoint: "http://127.0.0.1:9/v1" });
	const both = applyRootChange(keyOnly ?? customConfig(), ROOT_FIELD.typesafeEndpoint, "");
	assert.equal(both?.typesafe, undefined);
	assert.ok(!Object.hasOwn(both ?? {}, "typesafe"));
});

test("模型候选表按任意片段过滤，不只是前缀", () => {
	const options: PanelOption[] = [
		{ label: "llm-proxy/LOW", value: "llm-proxy/LOW" },
		{ label: "llm-proxy/DEFAULT", value: "llm-proxy/DEFAULT" },
		{ label: "cider/gpt-5", value: "cider/gpt-5" },
	];

	// SelectList.setFilter 只做前缀匹配，输入 low 找不到 llm-proxy/LOW。
	assert.deepEqual(
		filterOptions(options, "low").map((option) => option.value),
		["llm-proxy/LOW"],
	);
	assert.deepEqual(
		filterOptions(options, "gpt").map((option) => option.value),
		["cider/gpt-5"],
	);

	// 查询串也会按 "/" 切分，两段都得命中同一项。
	const proxies = filterOptions(options, "proxy").map((option) => option.value);
	assert.equal(proxies.length, 2);
	assert.ok(proxies.includes("llm-proxy/LOW"));
	assert.ok(proxies.includes("llm-proxy/DEFAULT"));
	assert.deepEqual(filterOptions(options, "proxy/gpt"), []);

	assert.equal(filterOptions(options, "").length, options.length);
	assert.equal(filterOptions(options, "   ").length, options.length);
	assert.deepEqual(filterOptions(options, "nothing-matches"), []);
});

test("模型候选项来自当前可用模型列表", () => {
	const items = buildReviewerItems(customReviewer(), MODELS);
	const modelRow = items.find((item) => item.id === REVIEWER_FIELD.model);
	assert.equal(modelRow?.currentValue, "llm-proxy/LOW");
	assert.ok(modelRow?.submenu, "模型行必须打开二级列表，而不是原地循环");
});
