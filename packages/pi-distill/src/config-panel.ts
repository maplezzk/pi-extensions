/**
 * pi-distill 的 TUI 配置面板。
 *
 * 原来用 `ctx.ui.select` 摆一串「字段：值」文本，屏幕上分不清哪行是状态、哪行按下去会怎样。
 * 这里改用 Pi 自带 `SettingsList`：左边字段名、右边当前值、选中项下方一行说明；开关原地切换，
 * 枚举与模型回车打开二级列表，二级列表上方带过滤输入框。改一项立即写盘并对本次会话生效，
 * Esc 关闭即可。
 *
 * 工具开关是运行期才知道名字的动态字段：可用工具列表有几个工具，面板就多几行 `tools.<工具名>`。
 */

import {
	getSelectListTheme,
	getSettingsListTheme,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Component,
	Input,
	SelectList,
	SettingsList,
	type SelectItem,
	type SettingItem,
	Text,
	fuzzyFilter,
	getKeybindings,
} from "@earendil-works/pi-tui";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

/** 面板上固定出现的字段名；工具开关按运行期工具名动态追加。 */
export const PANEL_FIELD = {
	enabled: "enabled",
	model: "model",
	minChars: "minChars",
	maxChars: "maxChars",
	maxOutputChars: "maxOutputChars",
	timeoutSeconds: "timeoutSeconds",
	timeoutRetryCount: "timeoutRetryCount",
	errorRetryCount: "errorRetryCount",
	missedCompressionRatio: "missedCompressionRatio",
	summarizeErrors: "summarizeErrors",
	renderEnabled: "render.enabled",
	renderShowPrompt: "render.showPrompt",
	renderShowResult: "render.showResult",
} as const;

/** 固定字段名的联合类型。 */
export type PanelFieldId = (typeof PANEL_FIELD)[keyof typeof PANEL_FIELD];

/** 工具开关字段名的前缀；完整字段名是 `tools.<工具名>`。 */
export const TOOL_FIELD_PREFIX = "tools.";

/** 工具开关的字段名。 */
export function toolFieldId(toolName: string): string {
	return `${TOOL_FIELD_PREFIX}${toolName}`;
}

/** 从工具开关字段名里取回工具名；不是工具字段时返回 undefined。 */
export function toolNameFromFieldId(id: string): string | undefined {
	return id.startsWith(TOOL_FIELD_PREFIX) ? id.slice(TOOL_FIELD_PREFIX.length) : undefined;
}

/** 面板读取的配置快照：与配置文件结构一致，缺省字段按默认值补齐。 */
export interface DistillPanelConfig {
	/** 总开关。 */
	enabled: boolean;
	/** `provider/model`；空串表示用当前会话模型。 */
	model: string;
	/** 触发提炼的最小输出字符数。 */
	minChars: number;
	/** 提炼结果超过此字符数时写文件。 */
	maxChars: number;
	/** 最终返回内容超过此字符数时写文件。 */
	maxOutputChars: number;
	/** 提炼模型调用超时秒数。 */
	timeoutSeconds: number;
	/** 超时后的额外重试次数。 */
	timeoutRetryCount: number;
	/** 非超时异常后的额外重试次数。 */
	errorRetryCount: number;
	/** 没有 outputRequest 的长输出触发提醒的倍数。 */
	missedCompressionRatio: number;
	/** 工具报错时是否仍提炼。 */
	summarizeErrors: boolean;
	/** 是否启用审计渲染器。 */
	renderEnabled: boolean;
	/** 审计卡是否显示 outputRequest。 */
	renderShowPrompt: boolean;
	/** 审计卡是否显示提炼结果。 */
	renderShowResult: boolean;
	/** 每个工具的开关覆盖；写回时只保留与默认值不同的项。 */
	tools: Record<string, boolean>;
}

/** 面板可选的模型：Pi 运行期注册的模型。 */
export interface ModelRef {
	/** provider id，例如 `llm-proxy`。 */
	provider: string;
	/** provider 内的模型 id，例如 `LOW`。 */
	id: string;
}

/** 字段的取值方式。 */
const PANEL_KIND = {
	/** 开关：Enter/空格原地切换。 */
	toggle: "toggle",
	/** 枚举/数值：Enter 打开二级列表。 */
	choice: "choice",
	/** 模型：Enter 打开可搜索的二级列表。 */
	model: "model",
} as const;

/** 字段的取值方式联合类型。 */
type PanelKind = (typeof PANEL_KIND)[keyof typeof PANEL_KIND];

/** 一个固定面板项：叫什么、怎么编辑。 */
interface PanelFieldSpec {
	/** 字段名。 */
	id: PanelFieldId;
	/** 取值方式。 */
	kind: PanelKind;
	/** 展示标题的文案 key。 */
	labelKey: string;
	/** 说明行的文案 key。 */
	descriptionKey: string;
}

/** 面板顺序：总开关、模型、阈值，最后是渲染开关。 */
const PANEL_FIELDS: readonly PanelFieldSpec[] = [
	{ id: PANEL_FIELD.enabled, kind: PANEL_KIND.toggle, labelKey: "panelLabelEnabled", descriptionKey: "panelDescEnabled" },
	{ id: PANEL_FIELD.model, kind: PANEL_KIND.model, labelKey: "panelLabelModel", descriptionKey: "panelDescModel" },
	{ id: PANEL_FIELD.minChars, kind: PANEL_KIND.choice, labelKey: "panelLabelMinChars", descriptionKey: "panelDescMinChars" },
	{ id: PANEL_FIELD.maxChars, kind: PANEL_KIND.choice, labelKey: "panelLabelMaxChars", descriptionKey: "panelDescMaxChars" },
	{ id: PANEL_FIELD.maxOutputChars, kind: PANEL_KIND.choice, labelKey: "panelLabelMaxOutputChars", descriptionKey: "panelDescMaxOutputChars" },
	{ id: PANEL_FIELD.timeoutSeconds, kind: PANEL_KIND.choice, labelKey: "panelLabelTimeoutSeconds", descriptionKey: "panelDescTimeoutSeconds" },
	{ id: PANEL_FIELD.timeoutRetryCount, kind: PANEL_KIND.choice, labelKey: "panelLabelTimeoutRetryCount", descriptionKey: "panelDescTimeoutRetryCount" },
	{ id: PANEL_FIELD.errorRetryCount, kind: PANEL_KIND.choice, labelKey: "panelLabelErrorRetryCount", descriptionKey: "panelDescErrorRetryCount" },
	{ id: PANEL_FIELD.missedCompressionRatio, kind: PANEL_KIND.choice, labelKey: "panelLabelMissedCompressionRatio", descriptionKey: "panelDescMissedCompressionRatio" },
	{ id: PANEL_FIELD.summarizeErrors, kind: PANEL_KIND.toggle, labelKey: "panelLabelSummarizeErrors", descriptionKey: "panelDescSummarizeErrors" },
	{ id: PANEL_FIELD.renderEnabled, kind: PANEL_KIND.toggle, labelKey: "panelLabelRenderEnabled", descriptionKey: "panelDescRenderEnabled" },
	{ id: PANEL_FIELD.renderShowPrompt, kind: PANEL_KIND.toggle, labelKey: "panelLabelRenderShowPrompt", descriptionKey: "panelDescRenderShowPrompt" },
	{ id: PANEL_FIELD.renderShowResult, kind: PANEL_KIND.toggle, labelKey: "panelLabelRenderShowResult", descriptionKey: "panelDescRenderShowResult" },
];

/** 固定字段名清单，测试用它核对没有配置字段漏在面板外。 */
export const PANEL_FIELD_IDS: readonly string[] = PANEL_FIELDS.map((field) => field.id);

/** 数值字段的候选值。 */
const NUMBER_FIELD_VALUES: Readonly<Record<string, readonly string[]>> = {
	[PANEL_FIELD.minChars]: ["50", "100", "200", "500", "1000", "5000"],
	[PANEL_FIELD.maxChars]: ["10000", "50000", "100000", "500000"],
	[PANEL_FIELD.maxOutputChars]: ["2000", "5000", "10000", "50000"],
	[PANEL_FIELD.timeoutSeconds]: ["5", "10", "30", "60", "120"],
	[PANEL_FIELD.timeoutRetryCount]: ["0", "1", "2", "3"],
	[PANEL_FIELD.errorRetryCount]: ["0", "1", "2", "3"],
	[PANEL_FIELD.missedCompressionRatio]: ["2", "5", "10", "20", "50"],
};

/** 二级列表最多同时显示几行；超出的部分由 SelectList 滚动。 */
const CHOICE_MENU_MAX_VISIBLE = 10;

/** 开关在面板上的两种显示文案。 */
export interface ToggleLabels {
	/** 打开态文案。 */
	on: string;
	/** 关闭态文案。 */
	off: string;
}

/** 取本地化后的开关文案。 */
export function panelToggleLabels(): ToggleLabels {
	return { on: i18n.t("on"), off: i18n.t("off") };
}

/** 模型字段里「当前会话模型」那一项的展示文案。 */
export function panelCurrentModelLabel(): string {
	return i18n.t("currentModel");
}

/** 二级列表的一项：label 是展示文本，value 是写回配置的值。 */
export interface PanelOption {
	/** 展示文本。 */
	label: string;
	/** 写回配置的值。 */
	value: string;
}

/** 开关字段的候选项。 */
function toggleOptions(): PanelOption[] {
	const labels = panelToggleLabels();
	return [
		{ label: labels.on, value: "true" },
		{ label: labels.off, value: "false" },
	];
}

/** 数值字段的候选项。 */
function numberOptions(id: string): PanelOption[] {
	const values = NUMBER_FIELD_VALUES[id] ?? [];
	return values.map((value) => ({ label: value, value }));
}

/** 模型字段的候选项：空串是「当前会话模型」，其余是 `provider/modelId`。 */
function modelOptions(models: readonly ModelRef[]): PanelOption[] {
	const options: PanelOption[] = [{ label: panelCurrentModelLabel(), value: "" }];
	const seen = new Set<string>([""]);
	for (const model of models) {
		const reference = `${model.provider}/${model.id}`;
		if (seen.has(reference)) continue;
		seen.add(reference);
		options.push({ label: reference, value: reference });
	}
	return options;
}

/** 按存储值取展示文本；不在候选表里就直接显示原值。 */
export function optionLabelForValue(options: readonly PanelOption[], value: string): string {
	return options.find((option) => option.value === value)?.label ?? value;
}

/** 按展示文本反查存储值；找不到返回 undefined。 */
export function optionValueFromLabel(
	options: readonly PanelOption[],
	label: string,
): string | undefined {
	return options.find((option) => option.label === label)?.value;
}

/** 开关值对应展示文本。 */
function toggleLabel(value: boolean, labels: ToggleLabels): string {
	return value ? labels.on : labels.off;
}

/** 按展示文本换算开关值；未知文本返回 undefined。 */
function toggleValueFromLabel(value: string, labels: ToggleLabels): boolean | undefined {
	if (value === labels.on) return true;
	if (value === labels.off) return false;
	return undefined;
}

/**
 * 按关键词过滤候选项；空关键词原样返回。
 *
 * `SelectList` 自带的 setFilter 只做前缀匹配，输入 `low` 永远找不到 `llm-proxy/LOW`。
 * 模糊匹配会给词边界加分，所以 `provider/model` 这种名字从哪一段搜都行。
 */
export function filterOptions(options: readonly PanelOption[], query: string): PanelOption[] {
	return query.trim() ? fuzzyFilter([...options], query, (option) => option.label) : [...options];
}

/** 面板需要手动输入的字段（数值与模型）允许把输入框里的原样文本当成候选项。 */
function isFreetextField(id: string): boolean {
	return id === PANEL_FIELD.model || id in NUMBER_FIELD_VALUES;
}

/** 取小数合法的字段：只有长输出阈值允许小数，其余都是整数。 */
function isDecimalField(id: string): boolean {
	return id === PANEL_FIELD.missedCompressionRatio;
}

/** 校验手动输入：数值字段必须是正数（阈值可为小数），模型字段必须是 `provider/model`；空串合法。 */
export function isCustomValueValid(id: string, value: string): boolean {
	const trimmed = value.trim();
	if (id === PANEL_FIELD.model) return trimmed === "" || /^[^/\s]+\/[^/\s]+$/.test(trimmed);
	if (id in NUMBER_FIELD_VALUES) {
		if (trimmed === "") return true;
		return isDecimalField(id) ? /^\d+(?:\.\d+)?$/.test(trimmed) : /^\d+$/.test(trimmed);
	}
	return false;
}

/** 二级列表的构造参数。 */
interface ChoiceSubmenuOptions {
	/** 字段名，决定手动输入内容按哪种规则校验。 */
	id: string;
	/** 候选项。 */
	options: readonly PanelOption[];
	/** 当前值，用来预选中对应候选。 */
	currentValue: string;
	/** 选定回调；传 undefined 表示用户按 Esc 放弃。 */
	done: (selectedLabel?: string) => void;
	/** 是否在列表上方加一个过滤输入框。 */
	search: boolean;
}

/**
 * 二级选择列表：Enter 选定并回传展示文本，Esc 不改动直接返回。
 *
 * `search` 打开时，列表上方多一个输入框：方向键仍然给列表，其余按键（含 Enter）给输入框，
 * 每次输入都按 `filterOptions` 重建列表。候选表很长时这是唯一顺手的做法。
 *
 * 允许手动输入的字段（数值、模型）在过滤框有内容时，列表顶部固定一项「使用 “xxx”」，
 * 于是「从候选里挑」和「自己填一个」在同一个列表里完成，不用再开一层菜单。
 */
function createChoiceSubmenu(params: ChoiceSubmenuOptions): Component {
	const { id, options, currentValue, done, search } = params;
	/** 输入框里的内容能不能直接当值用。 */
	const customOption = (query: string): PanelOption | undefined => {
		const trimmed = query.trim();
		if (!isFreetextField(id) || trimmed === "" || !isCustomValueValid(id, trimmed)) {
			return undefined;
		}
		if (options.some((option) => option.value === trimmed)) return undefined;
		return { label: i18n.t("panelUseCustom", { value: trimmed }), value: trimmed };
	};

	/** 建一份列表快照，能对上当前值就预选中它。 */
	const buildList = (list: readonly PanelOption[], preselect: string | undefined): SelectList => {
		// 列表项的 value 与 label 取同一段文本：SettingsList 会把回传值直接显示在右侧，
		// 回传展示文本才能让「当前会话模型」这类文案在选中后仍然可读。
		const items: SelectItem[] = list.map((option) => ({ value: option.label, label: option.label }));
		const selectList = new SelectList(
			items,
			Math.max(1, Math.min(items.length, CHOICE_MENU_MAX_VISIBLE)),
			getSelectListTheme(),
		);
		const index = list.findIndex((option) => option.value === preselect);
		if (index >= 0) selectList.setSelectedIndex(index);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		return selectList;
	};

	/** 过滤后的列表：手动输入项排在候选前面。 */
	const composeList = (query: string, preselect: string | undefined): readonly PanelOption[] => {
		const custom = customOption(query);
		const filtered = filterOptions(options, query);
		return custom ? [custom, ...filtered] : filtered;
	};

	if (!search) return buildList(options, currentValue);

	const input = new Input({ prompt: `${i18n.t("panelSearchPrompt")} ` });
	input.focused = true;
	input.onEscape = () => done(undefined);

	let list = buildList(options, currentValue);
	let query = "";
	input.onSubmit = () => {
		const selected = list.getSelectedItem();
		if (selected) done(selected.value);
	};

	// SettingsList 的 submenu 要求返回 Component，这里只把三个方法转发给两个子组件。
	return {
		/** 上面过滤输入框，下面过滤后的候选。 */
		render: (width) => [...input.render(width), ...list.render(width)],
		/** 两个子组件都没有共享缓存。 */
		invalidate: () => {
			input.invalidate();
			list.invalidate();
		},
		/** 方向键给列表，其余按键（含 Enter）给输入框。 */
		handleInput: (data) => {
			const keybindings = getKeybindings();
			if (
				keybindings.matches(data, "tui.select.up") ||
				keybindings.matches(data, "tui.select.down")
			) {
				list.handleInput(data);
				return;
			}
			input.handleInput(data);
			const next = input.getValue();
			if (next !== query) {
				query = next;
				list = buildList(composeList(next, customOption(next)?.value), undefined);
			}
		},
	};
}

/** 把配置快照转成 Pi 设置列表的条目；工具开关按传入的工具名逐行生成。 */
export function buildSettingItems(
	config: DistillPanelConfig,
	models: readonly ModelRef[],
	toolNames: readonly string[] = [],
): SettingItem[] {
	const labels = panelToggleLabels();
	const modelChoices = modelOptions(models);
	const items: SettingItem[] = PANEL_FIELDS.map((field) => {
		const label = i18n.t(field.labelKey);
		const description = i18n.t(field.descriptionKey);
		switch (field.kind) {
			case PANEL_KIND.toggle:
				return {
					id: field.id,
					label,
					description,
					currentValue: toggleLabel(readToggle(config, field.id), labels),
					values: toggleOptions().map((option) => option.label),
				};
			case PANEL_KIND.model:
				return {
					id: field.id,
					label,
					description,
					currentValue: optionLabelForValue(modelChoices, config.model),
					// 二级列表接管 Enter，模型动辄上百条，所以这一项要过滤输入框。
					submenu: (currentValue: string, done) =>
						createChoiceSubmenu({ id: field.id, options: modelChoices, currentValue, done, search: true }),
				};
			case PANEL_KIND.choice:
				return {
					id: field.id,
					label,
					description,
					currentValue: optionLabelForValue(numberOptions(field.id), readNumber(config, field.id)),
					submenu: (currentValue: string, done) =>
						createChoiceSubmenu({
							id: field.id,
							options: numberOptions(field.id),
							currentValue,
							done,
							search: true,
						}),
				};
		}
	});

	for (const toolName of toolNames) {
		items.push({
			id: toolFieldId(toolName),
			label: i18n.t("panelLabelTool", { tool: toolName }),
			description: i18n.t("panelDescTool", { tool: toolName }),
			currentValue: toggleLabel(config.tools[toolName] ?? defaultToolEnabled(toolName), labels),
			values: toggleOptions().map((option) => option.label),
		});
	}
	return items;
}

/** edit/write 未配置时默认关闭，其余工具默认开启；与 summary-utils 的规则保持一致。 */
const DEFAULT_DISABLED_TOOL_NAMES = new Set(["edit", "write"]);

/** 工具没被配置过时的默认开关。 */
export function defaultToolEnabled(toolName: string): boolean {
	return !DEFAULT_DISABLED_TOOL_NAMES.has(toolName);
}

/** 读一个开关字段的当前值。 */
function readToggle(config: DistillPanelConfig, id: PanelFieldId): boolean {
	switch (id) {
		case PANEL_FIELD.enabled:
			return config.enabled;
		case PANEL_FIELD.summarizeErrors:
			return config.summarizeErrors;
		case PANEL_FIELD.renderEnabled:
			return config.renderEnabled;
		case PANEL_FIELD.renderShowPrompt:
			return config.renderShowPrompt;
		case PANEL_FIELD.renderShowResult:
			return config.renderShowResult;
		default:
			return false;
	}
}

/** 读一个数值字段的当前值，字符串形式（面板统一按字符串传递）。 */
function readNumber(config: DistillPanelConfig, id: PanelFieldId): string {
	switch (id) {
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
		default:
			return "";
	}
}

/** 写一个数值字段；不合法或参与校验失败时返回 undefined。 */
function writeNumber(config: DistillPanelConfig, id: PanelFieldId, value: string): DistillPanelConfig | undefined {
	const normalized = value.trim();
	const parsed = Number(normalized);
	const isNonNegativeField =
		id === PANEL_FIELD.timeoutRetryCount || id === PANEL_FIELD.errorRetryCount;
	if (!isCustomValueValid(id, normalized)) return undefined;
	if (!Number.isFinite(parsed)) return undefined;
	if (isNonNegativeField && (!Number.isSafeInteger(parsed) || parsed < 0)) return undefined;
	if (!isNonNegativeField && !isDecimalField(id) && parsed <= 0) return undefined;
	if (isDecimalField(id) && parsed <= 0) return undefined;
	switch (id) {
		case PANEL_FIELD.minChars:
			return { ...config, minChars: parsed };
		case PANEL_FIELD.maxChars:
			return { ...config, maxChars: parsed };
		case PANEL_FIELD.maxOutputChars:
			return { ...config, maxOutputChars: parsed };
		case PANEL_FIELD.timeoutSeconds:
			return { ...config, timeoutSeconds: parsed };
		case PANEL_FIELD.timeoutRetryCount:
			return { ...config, timeoutRetryCount: parsed };
		case PANEL_FIELD.errorRetryCount:
			return { ...config, errorRetryCount: parsed };
		case PANEL_FIELD.missedCompressionRatio:
			return { ...config, missedCompressionRatio: parsed };
		default:
			return undefined;
	}
}

/**
 * 把面板回传的一项改动写回配置；无法识别时返回 undefined，由调用方保持不变。
 *
 * 开关与枚举只接受候选表里的展示文本；数值与模型这两类还能接受手动输入的合法原值
 * （二级列表顶部的「使用 “xxx”」就是走这条路），非法输入一律拒绝。
 */
export function applyPanelChange(
	config: DistillPanelConfig,
	id: string,
	value: string,
	models: readonly ModelRef[] = [],
): DistillPanelConfig | undefined {
	const labels = panelToggleLabels();
	const toolName = toolNameFromFieldId(id);
	if (toolName !== undefined) {
		const enabled = toggleValueFromLabel(value, labels);
		if (enabled === undefined) return undefined;
		return { ...config, tools: { ...config.tools, [toolName]: enabled } };
	}

	const field = PANEL_FIELDS.find((candidate) => candidate.id === id);
	if (!field) return undefined;

	if (field.kind === PANEL_KIND.toggle) {
		const enabled = toggleValueFromLabel(value, labels);
		if (enabled === undefined) return undefined;
		switch (field.id) {
			case PANEL_FIELD.enabled:
				return { ...config, enabled };
			case PANEL_FIELD.summarizeErrors:
				return { ...config, summarizeErrors: enabled };
			case PANEL_FIELD.renderEnabled:
				return { ...config, renderEnabled: enabled };
			case PANEL_FIELD.renderShowPrompt:
				return { ...config, renderShowPrompt: enabled };
			case PANEL_FIELD.renderShowResult:
				return { ...config, renderShowResult: enabled };
			default:
				return undefined;
		}
	}

	if (field.kind === PANEL_KIND.model) {
		if (value === panelCurrentModelLabel()) return { ...config, model: "" };
		const normalized = value.trim();
		if (normalized !== "" && !isCustomValueValid(field.id, normalized)) return undefined;
		return { ...config, model: normalized };
	}

	const stored = optionValueFromLabel(numberOptions(field.id), value) ?? value;
	return writeNumber(config, field.id, stored);
}

/** 面板与宿主之间的接口；配置读写与生效动作都由入口注入。 */
export interface ConfigPanelHandlers {
	/** 读取当前配置。 */
	getConfig(): DistillPanelConfig;
	/** 读取当前可用模型，供模型候选使用。 */
	getModels(): readonly ModelRef[];
	/** 读取当前可配置的工具名，供工具开关逐行生成。 */
	getToolNames(): readonly string[];
	/** 某一项被改动后调用，由入口负责保存并让本次会话立即生效。 */
	onChange(config: DistillPanelConfig): void;
}

/** 打开配置面板；用户改动即时生效，Esc 关闭。 */
export async function openConfigPanel(
	ctx: ExtensionCommandContext,
	handlers: ConfigPanelHandlers,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(i18n.t("settingsTitle"))), 1, 1));

		const itemCount = PANEL_FIELDS.length + handlers.getToolNames().length;
		const settingsList = new SettingsList(
			buildSettingItems(handlers.getConfig(), handlers.getModels(), handlers.getToolNames()),
			Math.max(1, itemCount),
			getSettingsListTheme(),
			(id, newValue) => {
				const next = applyPanelChange(handlers.getConfig(), id, newValue, handlers.getModels());
				if (next) handlers.onChange(next);
			},
			() => done(undefined),
		);
		container.addChild(settingsList);

		// ctx.ui.custom 要求返回 Component：整体布局交给 Container，键盘转给设置列表，
		// 列表改了数据后必须 requestRender，否则画面停在上一帧。
		return {
			/** 面板整体按 Container 布局渲染。 */
			render: (width: number) => container.render(width),
			/** 无本地缓存，交给 Container 清理。 */
			invalidate: () => container.invalidate(),
			/** 键盘输入交给设置列表，并触发一次重绘。 */
			handleInput: (data: string) => {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
