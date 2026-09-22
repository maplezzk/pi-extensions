/**
 * 模型发现配置面板的测试。
 *
 * 只验证纯函数层：字段覆盖、每个字段「取当前显示值写回」能往返一致、
 * 展示文本与写回值的映射。不打开 TUI，也不读本机真实 models.json。
 * 环境变量 PI_CODING_AGENT_DIR 指向临时目录，避免任何测试意外碰到真实配置。
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	API_CHOICES,
	PANEL_FIELD_IDS,
	PROVIDER_FIELD,
	ROOT_FIELD,
	applyProviderChange,
	buildProviderItems,
	buildRootItems,
	optionLabelForValue,
	optionValueFromLabel,
	type PanelProvider,
} from "../src/config-panel.ts";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

// 面板文案在测试里要能取到，指向临时 agent 目录以免读用户真实设置。
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-models-discovery-panel-"));
const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

/** 面板里每个 provider 能够改动的字段名（与旧 select/input/confirm 流程一一对应）。 */
const PROVIDER_EDITABLE_FIELDS: readonly string[] = [
	"enabled",
	"name",
	"baseUrl",
	"api",
	"apiKey",
	"rediscover",
	"remove",
];

/** 一个非默认值的 provider，避免往返测试因为值恰好等于默认值而蒙混过关。 */
function customProvider(): PanelProvider {
	return {
		id: "llm-proxy",
		baseUrl: "http://127.0.0.1:9000/pi/v1",
		api: "anthropic-messages",
		apiKey: "$PROXY_KEY",
		name: "Proxy",
		enabled: true,
	};
}

test("面板覆盖 provider 层和顶层的全部可编辑字段", () => {
	const providerFields = PANEL_FIELD_IDS
		.filter((id) => id.startsWith("provider."))
		.map((id) => id.slice("provider.".length))
		.sort();
	assert.deepEqual(providerFields, [...PROVIDER_EDITABLE_FIELDS].sort());
	assert.ok(PANEL_FIELD_IDS.includes(ROOT_FIELD.add), "顶层缺少「添加 provider」入口");
});

test("provider 层的每一行都有标题、说明和当前值", () => {
	const items = buildProviderItems(customProvider());
	assert.equal(items.length, PROVIDER_EDITABLE_FIELDS.length);
	for (const item of items) {
		assert.ok(item.label.length > 0, `${item.id} 没有标题`);
		assert.ok((item.description ?? "").length > 0, `${item.id} 没有说明`);
		assert.ok(item.currentValue.length > 0, `${item.id} 没有当前值`);
	}
});

test("顶层列出每个 provider，并带「添加 provider」入口", () => {
	const items = buildRootItems([customProvider()]);
	assert.equal(items.length, 2);
	const providerRow = items[0];
	assert.ok(providerRow.id.startsWith("provider:"));
	assert.ok(providerRow.label.includes("llm-proxy"));
	assert.equal(items[1].id, ROOT_FIELD.add);
});

test("取当前显示值写回，每个可编辑字段都能往返一致", () => {
	const provider = customProvider();
	for (const item of buildProviderItems(provider)) {
		if (item.id === PROVIDER_FIELD.rediscover || item.id === PROVIDER_FIELD.remove) continue;
		const next = applyProviderChange(provider, item.id, item.currentValue);
		assert.notEqual(next, undefined, `${item.id} 拒绝了自己的当前值`);
		assert.deepEqual(next, provider, `${item.id} 没有往返一致`);
	}
});

test("开关与枚举写回的是机器值，不是本地化文案", () => {
	const off = applyProviderChange(customProvider(), PROVIDER_FIELD.enabled, i18n.t("panelOff"));
	assert.equal(off?.enabled, false);

	const on = applyProviderChange({ ...customProvider(), enabled: false }, PROVIDER_FIELD.enabled, i18n.t("panelOn"));
	assert.equal(on?.enabled, true);

	const api = applyProviderChange(customProvider(), PROVIDER_FIELD.api, "openai-responses");
	assert.equal(api?.api, "openai-responses");
});

test("文本字段写回前去掉首尾空白", () => {
	const next = applyProviderChange(customProvider(), PROVIDER_FIELD.baseUrl, "  https://example.test/v1  ");
	assert.equal(next?.baseUrl, "https://example.test/v1");
});

test("未知字段或没人提供过的候选值不会改配置", () => {
	assert.equal(applyProviderChange(customProvider(), "not.a.field", "x"), undefined);
	assert.equal(applyProviderChange(customProvider(), PROVIDER_FIELD.api, "grpc"), undefined);
	assert.equal(applyProviderChange(customProvider(), PROVIDER_FIELD.enabled, "maybe"), undefined);
});

test("api 候选表里既有展示文本也有写回值，两者一一对应", () => {
	for (const api of API_CHOICES) {
		const options = API_CHOICES.map((value) => ({ label: value, value }));
		assert.equal(optionLabelForValue(options, api), api);
		assert.equal(optionValueFromLabel(options, api), api);
	}
});

test("未设置的文本字段显示为「未设置」而不是空白", () => {
	const items = buildProviderItems({ ...customProvider(), name: "", apiKey: "" });
	const name = items.find((item) => item.id === PROVIDER_FIELD.name);
	const apiKey = items.find((item) => item.id === PROVIDER_FIELD.apiKey);
	assert.equal(name?.currentValue, i18n.t("panelValueUnset"));
	assert.equal(apiKey?.currentValue, i18n.t("panelValueUnset"));
});
