/**
 * PiExtensions 共享语言的 TUI 配置面板。
 *
 * 原来用 `ctx.ui.select` 开一行选择菜单；这里改用 Pi 自带 `SettingsList`：
 * 一行「语言」，右边显示当前值，回车打开二级列表（auto / zh-CN / en-US）。
 * 选定后立即写盘并更新运行期偏好，Esc 关闭；带参数用法保持不变。
 */

import {
	getSelectListTheme,
	getSettingsListTheme,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	SelectList,
	SettingsList,
	Text,
	type Component,
	type SelectItem,
	type SettingItem,
} from "@earendil-works/pi-tui";
import type { LocalePreference } from "./index.ts";

/** 语言字段名；面板与测试共用。 */
export const LANGUAGE_PANEL_FIELD = "locale";

/** 面板上每个语言选项的文案 key 与取值。 */
interface LanguageOption {
	/** 本地化文案的 catalog key。 */
	key: string;
	/** 写盘的取值。 */
	value: LocalePreference;
}

/** 候选语言：与命令带参数时接受的取值保持一致。 */
const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
	{ key: "zh", value: "zh-CN" },
	{ key: "en", value: "en-US" },
	{ key: "auto", value: "auto" },
];

/** 面板覆盖的字段名，测试用它核对没有字段漏在面板外。 */
export const LANGUAGE_PANEL_FIELD_IDS: readonly string[] = [LANGUAGE_PANEL_FIELD];

/** 面板里要用到的翻译函数。 */
export interface PanelTranslator {
	/** 按 catalog key 取当前语言的文案。 */
	t(key: string, params?: Record<string, string | number>): string;
}

/** 构造二级语言列表；Enter 选定并回传值，Esc 不改动直接返回。 */
function createLanguageSubmenu(
	translator: PanelTranslator,
	currentValue: LocalePreference,
	done: (selectedValue?: string) => void,
): Component {
	// 回传展示文案而不是取值：SettingsList 会把回传值直接显到右侧，回传文案才能让
	// 选中后右侧仍然可读；真正的取值由 languageValueFromLabel 反查。
	const items: SelectItem[] = LANGUAGE_OPTIONS.map((option) => ({
		value: translator.t(option.key),
		label: translator.t(option.key),
	}));
	const selectList = new SelectList(items, items.length, getSelectListTheme());
	const index = LANGUAGE_OPTIONS.findIndex((option) => option.value === currentValue);
	if (index >= 0) selectList.setSelectedIndex(index);
	selectList.onSelect = (item) => done(item.value);
	selectList.onCancel = () => done(undefined);
	return selectList;
}

/** 按取值取展示文案；未知取值直接显示原值。 */
export function languageLabelForValue(translator: PanelTranslator, value: string): string {
	const option = LANGUAGE_OPTIONS.find((candidate) => candidate.value === value);
	return option ? translator.t(option.key) : value;
}

/** 按展示文案反查取值；找不到返回 undefined，由调用方保持原值。 */
export function languageValueFromLabel(label: string, translator: PanelTranslator): LocalePreference | undefined {
	return LANGUAGE_OPTIONS.find((option) => translator.t(option.key) === label)?.value;
}

/** 把当前偏好转成 Pi 设置列表的条目：一行「语言」，回车开二级列表。 */
export function buildLanguageSettingItems(
	translator: PanelTranslator,
	preference: LocalePreference,
): SettingItem[] {
	return [
		{
			id: LANGUAGE_PANEL_FIELD,
			label: translator.t("title"),
			description: translator.t("panelDesc"),
			currentValue: languageLabelForValue(translator, preference),
			submenu: (_currentValue, done) => createLanguageSubmenu(translator, preference, done),
		},
	];
}

/** 面板与宿主之间的接口；读写与生效动作由入口注入。 */
export interface LanguagePanelHandlers {
	/** 面板文案的翻译函数。 */
	translator: PanelTranslator;
	/** 读取当前语言偏好。 */
	getPreference(): LocalePreference;
	/** 某一项被改动后调用，由入口负责保存并提示结果。 */
	onChange(preference: LocalePreference): void;
}

/** 打开语言面板；选定立即生效，Esc 关闭。 */
export async function openLanguagePanel(
	ctx: ExtensionCommandContext,
	handlers: LanguagePanelHandlers,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(handlers.translator.t("title"))), 1, 1));

		const settingsList = new SettingsList(
			buildLanguageSettingItems(handlers.translator, handlers.getPreference()),
			1,
			getSettingsListTheme(),
			(_id, newValue) => {
				const preference = languageValueFromLabel(newValue, handlers.translator);
				if (preference) handlers.onChange(preference);
			},
			() => done(undefined),
		);
		container.addChild(settingsList);

		// ctx.ui.custom 要求返回 Component：布局交给 Container，键盘转给设置列表，
		// 数据改了要 requestRender，否则画面停在上一帧。
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
