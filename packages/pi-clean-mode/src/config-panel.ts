/**
 * 清爽模式的 TUI 配置面板。
 *
 * Pi 的 `/settings` 只管理内核选项，不接受扩展注册配置项，所以扩展要自己提供界面：
 * 用 `ctx.ui.custom` 临时接管编辑器，里面用 Pi 自带的 `SettingsList` 画配置列表，
 * 行数项再开一层 `SelectList` 二级选择。改一项立刻写文件并重装补丁，关掉面板即已生效。
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
	type SettingItem,
	SelectList,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import { withActivityRows, withBooleanConfigField, type BooleanConfigKey } from "./config-fields.js";
import { i18n } from "./i18n.js";
import { ACTIVITY_ROWS_RANGE, type CleanModeConfig } from "./types.js";

/** 解析十进制行数用的进制。 */
const DECIMAL_RADIX = 10;

/** 活动区行数在配置里的字段名；面板各处引用同一个常量。 */
const ACTIVITY_ROWS_ID = "activityRows" as const;

/** 面板项的取值方式。 */
const PANEL_ITEM_KIND = {
	/** 开关：Enter/空格在两个值之间切换。 */
	toggle: "toggle",
	/** 行数：Enter 打开二级选择列表。 */
	rows: "rows",
} as const;

/** 面板里活动区行数的候选值，直接由合法区间生成。 */
const ACTIVITY_ROW_VALUES: string[] = Array.from(
	{ length: ACTIVITY_ROWS_RANGE.max - ACTIVITY_ROWS_RANGE.min + 1 },
	(_unused, index) => String(ACTIVITY_ROWS_RANGE.min + index),
);
/** 行数列表最多同时显示几行；超出的部分由 SelectList 滚动。 */
const ROW_MENU_MAX_VISIBLE = 8;

/** 面板项。 */
interface PanelItemSpec {
	/** 配置字段名。 */
	id: BooleanConfigKey | typeof ACTIVITY_ROWS_ID;
	/** 标题文案 key。 */
	labelKey: string;
	/** 说明文案 key。 */
	descriptionKey: string;
	/** 取值方式。 */
	kind: (typeof PANEL_ITEM_KIND)[keyof typeof PANEL_ITEM_KIND];
}

/** 面板顺序：总开关在最前，活动区三项相邻。 */
const PANEL_ITEMS: readonly PanelItemSpec[] = [
	{
		id: "enabled",
		labelKey: "configLabelEnabled",
		descriptionKey: "configDescEnabled",
		kind: PANEL_ITEM_KIND.toggle,
	},
	{
		id: "showRunHeader",
		labelKey: "configLabelShowRunHeader",
		descriptionKey: "configDescShowRunHeader",
		kind: PANEL_ITEM_KIND.toggle,
	},
	{
		id: "autoExpandWhileRunning",
		labelKey: "configLabelAutoExpand",
		descriptionKey: "configDescAutoExpand",
		kind: PANEL_ITEM_KIND.toggle,
	},
	{
		id: "enableActionGroups",
		labelKey: "configLabelActionGroups",
		descriptionKey: "configDescActionGroups",
		kind: PANEL_ITEM_KIND.toggle,
	},
	{
		id: "showActivityArea",
		labelKey: "configLabelActivityArea",
		descriptionKey: "configDescActivityArea",
		kind: PANEL_ITEM_KIND.toggle,
	},
	{
		id: ACTIVITY_ROWS_ID,
		labelKey: "configLabelActivityRows",
		descriptionKey: "configDescActivityRows",
		kind: PANEL_ITEM_KIND.rows,
	},
	{
		id: "animateActivity",
		labelKey: "configLabelAnimateActivity",
		descriptionKey: "configDescAnimateActivity",
		kind: PANEL_ITEM_KIND.toggle,
	},
	{
		id: "hideThinking",
		labelKey: "configLabelHideThinking",
		descriptionKey: "configDescHideThinking",
		kind: PANEL_ITEM_KIND.toggle,
	},
];

/** 面板覆盖的配置字段名，测试用它核对没有字段漏在面板外。 */
export const CONFIG_PANEL_IDS: readonly string[] = PANEL_ITEMS.map((item) => item.id);

/** 开关在面板上显示的两个文案。 */
export interface ToggleLabels {
	/** 打开态文案。 */
	on: string;
	/** 关闭态文案。 */
	off: string;
}

/** 取本地化后的开关文案。 */
export function panelToggleLabels(): ToggleLabels {
	return { on: i18n.t("configValueOn"), off: i18n.t("configValueOff") };
}

/** 活动区行数的二级选择列表：Enter 选定，Esc 不改动直接返回。 */
function createRowCountSubmenu(
	currentValue: string,
	done: (selectedValue?: string) => void,
): Component {
	const items: SelectItem[] = ACTIVITY_ROW_VALUES.map((value) => ({
		value,
		label: i18n.t("configActivityRowsOption", { count: value }),
	}));
	const list = new SelectList(
		items,
		Math.min(items.length, ROW_MENU_MAX_VISIBLE),
		getSelectListTheme(),
	);
	const currentIndex = ACTIVITY_ROW_VALUES.indexOf(currentValue);
	if (currentIndex >= 0) {
		list.setSelectedIndex(currentIndex);
	}
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
	config: CleanModeConfig,
	labels: ToggleLabels = panelToggleLabels(),
): SettingItem[] {
	return PANEL_ITEMS.map((item) => {
		const label = i18n.t(item.labelKey);
		const description = i18n.t(item.descriptionKey);
		if (item.kind === PANEL_ITEM_KIND.rows) {
			return {
				id: item.id,
				label,
				description,
				currentValue: String(config[item.id]),
				// 二级列表接管 Enter，避免在 1-6 之间反复循环。
				submenu: createRowCountSubmenu,
			};
		}
		return {
			id: item.id,
			label,
			description,
			currentValue: config[item.id] ? labels.on : labels.off,
			values: [labels.on, labels.off],
		};
	});
}

/** 把面板返回值写回配置；无法识别时返回 undefined，由调用方保持不变。 */
export function applyPanelChange(
	config: CleanModeConfig,
	id: string,
	value: string,
	labels: ToggleLabels = panelToggleLabels(),
): CleanModeConfig | undefined {
	// SettingsList 回调只给 id 字符串，所以这里按字段名分派，与面板项声明保持一致。
	if (id === ACTIVITY_ROWS_ID) {
		return withActivityRows(config, Number.parseInt(value, DECIMAL_RADIX));
	}
	if (value === labels.on) {
		return withBooleanConfigField(config, id, true);
	}
	if (value === labels.off) {
		return withBooleanConfigField(config, id, false);
	}
	return undefined;
}

/** 面板与宿主之间的接口；配置读写与生效动作都由入口注入。 */
export interface ConfigPanelHandlers {
	/** 读取当前配置。 */
	getConfig(): CleanModeConfig;
	/** 某一项被改动后调用，由入口负责保存、重装补丁并重绘。 */
	onChange(config: CleanModeConfig, id: string): void;
}

/** 打开配置面板；用户改动即时生效，Esc 关闭。 */
export async function openConfigPanel(
	ctx: ExtensionCommandContext,
	handlers: ConfigPanelHandlers,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(i18n.t("configPanelTitle"))), 1, 1));

		const settingsList = new SettingsList(
			toSettingItems(handlers.getConfig()),
			PANEL_ITEMS.length,
			getSettingsListTheme(),
			(id, newValue) => {
				const next = applyPanelChange(handlers.getConfig(), id, newValue);
				if (next) {
					handlers.onChange(next, id);
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
