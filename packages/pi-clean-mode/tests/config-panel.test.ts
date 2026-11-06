import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_PANEL_IDS, applyPanelChange, panelToggleLabels, toSettingItems } from "../src/config-panel.ts";
import { i18n } from "../src/i18n.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, ACTIVITY_ROWS_RANGE, type CleanModeConfig } from "../src/types.ts";

/** 面板上不该出现的行数取值：比合法上限还大，用于校验非法输入被拒绝。 */
const OUT_OF_RANGE_ROWS = String(ACTIVITY_ROWS_RANGE.max + 1);
/** 测试里反复引用的字段名，避免字面量散落。 */
const ACTIVITY_ROWS_ID = "activityRows";
const ENABLED_ID = "enabled";
const HIDE_THINKING_ID = "hideThinking";

/** 造一份指定配置的副本，避免测试之间互相污染。 */
function configWith(patch: Partial<CleanModeConfig>): CleanModeConfig {
	return { ...DEFAULT_CLEAN_MODE_CONFIG, ...patch };
}

test("面板覆盖全部配置字段，且没有重复项", () => {
	const configKeys = Object.keys(DEFAULT_CLEAN_MODE_CONFIG).sort();
	assert.deepEqual([...CONFIG_PANEL_IDS].sort(), configKeys);
	assert.equal(new Set(CONFIG_PANEL_IDS).size, CONFIG_PANEL_IDS.length);
});

test("每个面板项都有本地化标题、说明与当前值", () => {
	const items = toSettingItems(configWith({ activityRows: 2, enabled: false }));
	assert.equal(items.length, CONFIG_PANEL_IDS.length);

	for (const item of items) {
		assert.ok(item.label.trim().length > 0, `${item.id} 缺标题`);
		assert.ok((item.description ?? "").trim().length > 0, `${item.id} 缺说明`);
		assert.notEqual(item.label, item.description, `${item.id} 的标题与说明不该相同`);
	}

	const enabled = items.find((item) => item.id === ENABLED_ID);
	const labels = panelToggleLabels();
	assert.equal(enabled?.currentValue, labels.off, "关闭态应显示关闭文案");

	const rows = items.find((item) => item.id === ACTIVITY_ROWS_ID);
	assert.equal(rows?.currentValue, i18n.t("configActivityRowsOption", { count: "2" }));
	assert.equal(typeof rows?.submenu, "function", "行数项应打开二级选择列表");
});

test("开关项可切换，未知字段或未知取值不写配置", () => {
	const labels = panelToggleLabels();
	const config = configWith({ enabled: true });

	for (const id of CONFIG_PANEL_IDS) {
		if (id === ACTIVITY_ROWS_ID) {
			continue;
		}
		assert.equal(applyPanelChange(config, id, labels.off)?.[id], false, `${id} 应能关掉`);
		assert.equal(applyPanelChange(config, id, labels.on)?.[id], true, `${id} 应能打开`);
	}

	assert.equal(applyPanelChange(config, "nope", labels.off), undefined);
	assert.equal(applyPanelChange(config, ENABLED_ID, "maybe"), undefined);
});

test("行数项按展示文本写回，未知取值不写配置", () => {
	const config = configWith({ activityRows: 4 });
	const threeRows = i18n.t("configActivityRowsOption", { count: "3" });
	assert.equal(applyPanelChange(config, ACTIVITY_ROWS_ID, threeRows)?.activityRows, 3);
	// 裸数字不再是合法输入：面板回传的是展示文本，两侧必须用同一套候选表。
	assert.equal(applyPanelChange(config, ACTIVITY_ROWS_ID, "3"), undefined);
	assert.equal(applyPanelChange(config, ACTIVITY_ROWS_ID, OUT_OF_RANGE_ROWS), undefined);
	assert.equal(applyPanelChange(config, ACTIVITY_ROWS_ID, "abc"), undefined);
});

test("二级列表回传展示文本，选中后行内不会退回裸数字", () => {
	const item = toSettingItems(configWith({ activityRows: 4 })).find(
		(entry) => entry.id === ACTIVITY_ROWS_ID,
	);
	assert.ok(item?.submenu);

	const picked: string[] = [];
	const submenu = item.submenu(item.currentValue, (value?: string) => {
		if (value !== undefined) picked.push(value);
	});
	// 列表刚打开就选中当前值，直接回车等于不改动，但回传的仍应是展示文本。
	submenu.handleInput("\r");

	assert.deepEqual(picked, [i18n.t("configActivityRowsOption", { count: "4" })]);
});

test("自定义开关文案同样能写回配置", () => {
	const labels = { on: "YES", off: "NO" };
	const items = toSettingItems(configWith({ hideThinking: true }), labels);
	const thinking = items.find((item) => item.id === HIDE_THINKING_ID);
	assert.equal(thinking?.currentValue, "YES");
	assert.equal(
		applyPanelChange(DEFAULT_CLEAN_MODE_CONFIG, HIDE_THINKING_ID, "NO", labels)?.hideThinking,
		false,
	);
});

test("面板标题文案已本地化", () => {
	assert.ok(i18n.t("configPanelTitle").trim().length > 0);
});
