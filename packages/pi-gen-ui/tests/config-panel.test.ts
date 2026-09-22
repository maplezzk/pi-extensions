import assert from "node:assert/strict";
import test from "node:test";
import {
	PANEL_FIELD,
	PANEL_FIELD_IDS,
	applyPanelChange,
	buildSettingItems,
	filterOptions,
	type ModelRef,
	type PanelOption,
} from "../src/config-panel.ts";
import { DEFAULT_CONFIG, type JsonRenderConfig } from "../src/config.ts";
import { i18n } from "../src/i18n.ts";

/** Every field set away from its default, so a round-trip cannot pass by accident. */
function customConfig(): JsonRenderConfig {
	return {
		enabled: false,
		maxResultLines: 200,
		interactiveView: "never",
		composition: {
			enabled: false,
			provider: "gateway",
			model: "typesafe-ai/jev",
			apiKeyEnv: "MY_KEY",
			endpoint: "https://example.test/v1",
			timeoutMs: 30000,
		},
	};
}

/** Models offered to the panel in these tests. */
const MODELS: readonly ModelRef[] = [
	{ provider: "llm-proxy", id: "LOW" },
	{ provider: "llm-proxy", id: "DEFAULT" },
	{ provider: "cider", id: "gpt-5" },
];

/** Every configuration field, so a new field cannot be added without a panel row. */
const CONFIG_FIELDS: readonly string[] = [
	"enabled",
	"interactiveView",
	"maxResultLines",
	"composition.enabled",
	"composition.provider",
	"composition.model",
	"composition.apiKeyEnv",
	"composition.endpoint",
	"composition.timeoutMs",
];

test("the panel covers every configuration field", () => {
	assert.deepEqual([...PANEL_FIELD_IDS].sort(), [...CONFIG_FIELDS].sort());
});

test("every row carries a label, a description and the current value", () => {
	const items = buildSettingItems(customConfig(), MODELS);
	assert.equal(items.length, CONFIG_FIELDS.length);
	for (const item of items) {
		assert.ok(item.label.length > 0, `${item.id} has no label`);
		assert.ok((item.description ?? "").length > 0, `${item.id} has no description`);
		assert.ok(item.currentValue.length > 0, `${item.id} has no current value`);
	}
});

test("an unset text field is shown as unset instead of blank", () => {
	const items = buildSettingItems(DEFAULT_CONFIG, MODELS);
	const apiKeyEnv = items.find((item) => item.id === PANEL_FIELD.apiKeyEnv);
	assert.equal(apiKeyEnv?.currentValue, i18n.t("configValueUnset"));
});

test("picking the displayed value of every row round-trips the configuration", () => {
	const config = customConfig();
	for (const item of buildSettingItems(config, MODELS)) {
		const next = applyPanelChange(config, item.id, item.currentValue, MODELS);
		assert.notEqual(next, undefined, `${item.id} rejected its own current value`);
		assert.deepEqual(next, config, `${item.id} did not round-trip`);
	}
});

test("toggles and choices store values, never the localized labels", () => {
	const off = applyPanelChange(DEFAULT_CONFIG, PANEL_FIELD.enabled, i18n.t("configOff"));
	assert.equal(off?.enabled, false);

	const on = applyPanelChange(customConfig(), PANEL_FIELD.compositionEnabled, i18n.t("configOn"));
	assert.equal(on?.composition.enabled, true);

	const never = applyPanelChange(DEFAULT_CONFIG, PANEL_FIELD.interactiveView, i18n.t("configViewNever"));
	assert.equal(never?.interactiveView, "never");

	const typesafe = applyPanelChange(
		DEFAULT_CONFIG,
		PANEL_FIELD.provider,
		i18n.t("configProviderTypesafe"),
	);
	assert.equal(typesafe?.composition.provider, "typesafe");
});

test("an unknown row or a value nobody offered leaves the configuration alone", () => {
	assert.equal(applyPanelChange(DEFAULT_CONFIG, "not.a.field", "x", MODELS), undefined);
	assert.equal(applyPanelChange(DEFAULT_CONFIG, PANEL_FIELD.interactiveView, "sometimes", MODELS), undefined);
	assert.equal(applyPanelChange(DEFAULT_CONFIG, PANEL_FIELD.provider, "openai", MODELS), undefined);
	// 9999 is not in the candidate list, so a stale panel cannot store it unclamped either.
	assert.equal(applyPanelChange(DEFAULT_CONFIG, PANEL_FIELD.maxResultLines, "9999", MODELS), undefined);
});

test("the model row accepts the channel default and any registered model", () => {
	const picked = applyPanelChange(DEFAULT_CONFIG, PANEL_FIELD.model, "llm-proxy/LOW", MODELS);
	assert.equal(picked?.composition.model, "llm-proxy/LOW");

	const cleared = applyPanelChange(
		customConfig(),
		PANEL_FIELD.model,
		i18n.t("configModelChannelDefault"),
		MODELS,
	);
	assert.equal(cleared?.composition.model, "");
});

test("a text field is trimmed before it reaches the configuration", () => {
	const next = applyPanelChange(DEFAULT_CONFIG, PANEL_FIELD.apiKeyEnv, "  MY_KEY  ", MODELS);
	assert.equal(next?.composition.apiKeyEnv, "MY_KEY");
});

test("model candidates are searchable by any part of the id, not just the prefix", () => {
	const options: PanelOption[] = [
		{ label: i18n.t("configModelChannelDefault"), value: "" },
		{ label: "llm-proxy/LOW", value: "llm-proxy/LOW" },
		{ label: "llm-proxy/DEFAULT", value: "llm-proxy/DEFAULT" },
		{ label: "cider/gpt-5", value: "cider/gpt-5" },
	];

	// SelectList.setFilter matches a prefix, so "low" would return nothing for "llm-proxy/LOW".
	assert.deepEqual(
		filterOptions(options, "low").map((option) => option.value),
		["llm-proxy/LOW"],
	);
	assert.deepEqual(
		filterOptions(options, "gpt").map((option) => option.value),
		["cider/gpt-5"],
	);

	// The query splits on "/" as well, so both tokens have to match the same option.
	const proxies = filterOptions(options, "proxy").map((option) => option.value);
	assert.equal(proxies.length, 2);
	assert.ok(proxies.includes("llm-proxy/LOW"));
	assert.ok(proxies.includes("llm-proxy/DEFAULT"));
	assert.deepEqual(filterOptions(options, "proxy/gpt"), []);

	assert.equal(filterOptions(options, "").length, options.length);
	assert.equal(filterOptions(options, "   ").length, options.length);
	assert.deepEqual(filterOptions(options, "nothing-matches"), []);
});
