/**
 * pi-auto-goal 的 TUI 配置面板。
 *
 * 原来用 `ctx.ui.select` 开菜单，一行文字里既放当前值又放「按下去会变成什么」，
 * 屏幕上看不出哪项是状态、哪项是按钮。这里改用 Pi 自带 `SettingsList`：
 * 左边字段名、右边当前值、选中项下方给一行说明，枚举项回车打开二级列表。
 * 改一项立即写文件并同步运行期配置，Esc 关闭。
 */

import {
	type ExtensionCommandContext,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	type SelectItem,
	SelectList,
	SettingsList,
	type SettingItem,
	Text,
} from "@earendil-works/pi-tui";
import { parseConfig, type AutoGoalConfig } from "./config.ts";
import { buildModelChoices } from "./model-choice.ts";
import { i18n } from "./i18n.ts";

/** 开关字段名。 */
type ToggleFieldId = "enabled" | "showVerdictNotice";

/** 数值字段名：配置里存数字，面板上从候选表里选。 */
type NumericFieldId = "maxAutoContinues" | "confidenceThreshold" | "judgeMaxTokens";

/** 面板项的取值方式。 */
const PANEL_ITEM_KIND = {
	/** 开关：Enter/空格在开与关之间切换。 */
	toggle: "toggle",
	/** 枚举：Enter 打开二级选择列表。 */
	choice: "choice",
	/** 判定模型：候选来自当前可用模型。 */
	model: "model",
} as const;

/** 面板项：每种取值方式对应不同的字段类型。 */
type PanelItemSpec =
	| { kind: typeof PANEL_ITEM_KIND.toggle; id: ToggleFieldId; labelKey: string; descriptionKey: string }
	| { kind: typeof PANEL_ITEM_KIND.choice; id: NumericFieldId; labelKey: string; descriptionKey: string }
	| { kind: typeof PANEL_ITEM_KIND.model; id: "model"; labelKey: string; descriptionKey: string };

/** 面板顺序：总开关在最前，模型次之，其余按影响从大到小。 */
const PANEL_ITEMS: readonly PanelItemSpec[] = [
	{
		kind: PANEL_ITEM_KIND.toggle,
		id: "enabled",
		labelKey: "configLabelEnabled",
		descriptionKey: "configDescEnabled",
	},
	{
		kind: PANEL_ITEM_KIND.model,
		id: "model",
		labelKey: "configLabelModel",
		descriptionKey: "configDescModel",
	},
	{
		kind: PANEL_ITEM_KIND.choice,
		id: "maxAutoContinues",
		labelKey: "configLabelMaxAutoContinues",
		descriptionKey: "configDescMaxAutoContinues",
	},
	{
		kind: PANEL_ITEM_KIND.choice,
		id: "confidenceThreshold",
		labelKey: "configLabelConfidence",
		descriptionKey: "configDescConfidence",
	},
	{
		kind: PANEL_ITEM_KIND.choice,
		id: "judgeMaxTokens",
		labelKey: "configLabelJudgeTokens",
		descriptionKey: "configDescJudgeTokens",
	},
	{
		kind: PANEL_ITEM_KIND.toggle,
		id: "showVerdictNotice",
		labelKey: "configLabelVerdictNotice",
		descriptionKey: "configDescVerdictNotice",
	},
];

/** 面板覆盖的配置字段名，测试用它核对没有字段漏在面板外。 */
export const CONFIG_PANEL_IDS: readonly string[] = PANEL_ITEMS.map((item) => item.id);

/** 干预上限的候选值；0 表示不限制。 */
const MAX_AUTO_CONTINUES_VALUES: readonly string[] = ["0", "1", "2", "3", "4", "5"];
/** 无上限在配置里的取值。 */
const UNLIMITED_VALUE = "0";
/** 置信度阈值的步数：0.0 到 1.0，步长 0.1。 */
const CONFIDENCE_STEPS = 10;
/** 置信度阈值候选值。 */
const CONFIDENCE_THRESHOLD_VALUES: readonly string[] = Array.from(
	{ length: CONFIDENCE_STEPS + 1 },
	(_unused, index) => (index / CONFIDENCE_STEPS).toFixed(1),
);
/** 判定输出上限候选值。 */
const JUDGE_MAX_TOKENS_VALUES: readonly string[] = ["512", "1000", "2000", "4000", "8000", "16000"];

/** 数值字段到候选值的映射。 */
const NUMBER_FIELD_VALUES: Readonly<Record<NumericFieldId, readonly string[]>> = {
	maxAutoContinues: MAX_AUTO_CONTINUES_VALUES,
	confidenceThreshold: CONFIDENCE_THRESHOLD_VALUES,
	judgeMaxTokens: JUDGE_MAX_TOKENS_VALUES,
};

/** 二级列表最多同时显示几行；超出的部分由 SelectList 滚动。 */
const CHOICE_MENU_MAX_VISIBLE = 8;

/** 二级列表的一项：label 是展示文本，value 是写回配置的值。 */
export interface PanelOption {
	/** 展示文本。 */
	label: string;
	/** 写回配置的值。 */
	value: string;
}

/** 开关在面板上显示的两个文案。 */
export interface ToggleLabels {
	/** 打开态文案。 */
	on: string;
	/** 关闭态文案。 */
	off: string;
}

/** 取本地化后的开关文案。 */
export function panelToggleLabels(): ToggleLabels {
	return { on: i18n.t("configOn"), off: i18n.t("configOff") };
}

/** 判断字段名是否为数值字段。 */
function isNumericFieldId(id: string): id is NumericFieldId {
	return id in NUMBER_FIELD_VALUES;
}

/** 数值字段的候选项；无上限那项显示为「不限制」。 */
function numberOptions(id: NumericFieldId): PanelOption[] {
	return NUMBER_FIELD_VALUES[id].map((value) => ({
		label: value === UNLIMITED_VALUE ? i18n.t("configUnlimited") : value,
		value,
	}));
}

/** 模型候选项：第一项是「当前会话模型」，其余是 `provider/modelId`。 */
function modelOptions(models: ReadonlyArray<{ provider: string; id: string }>): PanelOption[] {
	const reuseLabel = i18n.t("configModelCurrent");
	return buildModelChoices(models, reuseLabel).map((choice) => ({
		label: choice.value === "" ? reuseLabel : choice.label,
		value: choice.value,
	}));
}

/** 按配置值取展示文本；不在候选表里就直接显示原值。 */
export function optionLabelForValue(options: readonly PanelOption[], value: string): string {
	return options.find((option) => option.value === value)?.label ?? value;
}

/** 按展示文本反查写回值；找不到说明候选表变了，返回 undefined 由调用方保持不变。 */
export function optionValueFromLabel(
	options: readonly PanelOption[],
	label: string,
): string | undefined {
	return options.find((option) => option.label === label)?.value;
}

/** 开关当前值对应的展示文本。 */
function toggleLabel(value: boolean, labels: ToggleLabels): string {
	return value ? labels.on : labels.off;
}

/** 按展示文本换算开关值；未知文本返回 undefined。 */
function toggleValueFromLabel(value: string, labels: ToggleLabels): boolean | undefined {
	if (value === labels.on) return true;
	if (value === labels.off) return false;
	return undefined;
}

/** 二级选择列表：Enter 选定并回传展示文本，Esc 不改动直接返回。 */
function createChoiceSubmenu(
	options: readonly PanelOption[],
	currentValue: string,
	done: (selectedLabel?: string) => void,
): Component {
	// 列表项的 value 与 label 取同一段文本：SettingsList 会把回传值直接显示在右侧，
	// 回传展示文本才能让「不限制」这类文案在选中后仍然可读。
	const items: SelectItem[] = options.map((option) => ({
		value: option.label,
		label: option.label,
	}));
	const list = new SelectList(
		items,
		Math.min(items.length, CHOICE_MENU_MAX_VISIBLE),
		getSelectListTheme(),
	);
	const currentIndex = options.findIndex((option) => option.value === currentValue);
	if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done(undefined);

	// SettingsList 的 submenu 要求返回 Component，这里只把三个方法转发给列表。
	return {
		/** 行数与宽度都由 SelectList 自己算。 */
		render: (width) => list.render(width),
		/** 无本地缓存，交给列表清理。 */
		invalidate: () => list.invalidate(),
		/** 键盘输入全部转给列表。 */
		handleInput: (data) => list.handleInput(data),
	};
}

/** 把当前配置转成 Pi 设置列表的条目。 */
export function toSettingItems(
	config: AutoGoalConfig,
	models: ReadonlyArray<{ provider: string; id: string }>,
): SettingItem[] {
	const labels = panelToggleLabels();
	const modelChoices = modelOptions(models);
	return PANEL_ITEMS.map((item) => {
		const label = i18n.t(item.labelKey);
		const description = i18n.t(item.descriptionKey);
		switch (item.kind) {
			case PANEL_ITEM_KIND.toggle:
				return {
					id: item.id,
					label,
					description,
					currentValue: toggleLabel(config[item.id], labels),
					values: [labels.on, labels.off],
				};
			case PANEL_ITEM_KIND.model:
				return {
					id: item.id,
					label,
					description,
					currentValue: optionLabelForValue(modelChoices, config.model),
					// 二级列表接管 Enter，避免在「当前会话模型」与具体模型之间反复循环。
					submenu: (currentValue: string, done) =>
						createChoiceSubmenu(modelChoices, currentValue, done),
				};
			case PANEL_ITEM_KIND.choice:
				return {
					id: item.id,
					label,
					description,
					currentValue: optionLabelForValue(numberOptions(item.id), String(config[item.id])),
					submenu: (currentValue: string, done) =>
						createChoiceSubmenu(numberOptions(item.id), currentValue, done),
				};
		}
	});
}

/**
 * 把面板返回的展示文本写回配置；无法识别时返回 undefined，由调用方保持不变。
 *
 * 结果统一过一遍 parseConfig，保证写盘的值仍在合法区间内（候选表与校验规则不会各走各的）。
 */
export function applyPanelChange(
	config: AutoGoalConfig,
	id: string,
	value: string,
): AutoGoalConfig | undefined {
	const labels = panelToggleLabels();
	if (id === "enabled" || id === "showVerdictNotice") {
		const enabled = toggleValueFromLabel(value, labels);
		return enabled === undefined ? undefined : parseConfig({ ...config, [id]: enabled });
	}
	if (id === "model") {
		const reuseLabel = i18n.t("configModelCurrent");
		return parseConfig({ ...config, model: value === reuseLabel ? "" : value });
	}
	if (isNumericFieldId(id)) {
		const raw = optionValueFromLabel(numberOptions(id), value);
		return raw === undefined ? undefined : parseConfig({ ...config, [id]: Number(raw) });
	}
	return undefined;
}

/** 面板与宿主之间的接口；配置读写与生效动作都由入口注入。 */
export interface ConfigPanelHandlers {
	/** 读取当前配置。 */
	getConfig(): AutoGoalConfig;
	/** 读取当前可用模型，供判定模型候选使用。 */
	getModels(): ReadonlyArray<{ provider: string; id: string }>;
	/** 某一项被改动后调用，由入口负责保存、同步运行期配置并重绘。 */
	onChange(config: AutoGoalConfig): void;
}

/** 打开配置面板；用户改动即时生效，Esc 关闭。 */
export async function openConfigPanel(
	ctx: ExtensionCommandContext,
	handlers: ConfigPanelHandlers,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(i18n.t("configMenuTitle"))), 1, 1));

		const settingsList = new SettingsList(
			toSettingItems(handlers.getConfig(), handlers.getModels()),
			PANEL_ITEMS.length,
			getSettingsListTheme(),
			(id, newValue) => {
				const next = applyPanelChange(handlers.getConfig(), id, newValue);
				if (next) {
					handlers.onChange(next);
				}
			},
			() => done(undefined),
		);
		container.addChild(settingsList);

		// ctx.ui.custom 要求返回 Component：整体布局交给 Container，键盘转给设置列表，
		// 列表改了数据后必须 requestRender，否则画面停在上一帧。
		return {
			/** 面板整体按 Container 布局渲染。 */
			render: (width) => container.render(width),
			/** 无本地缓存，交给 Container 清理。 */
			invalidate: () => container.invalidate(),
			/** 键盘输入交给设置列表，并触发一次重绘。 */
			handleInput: (data) => {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
