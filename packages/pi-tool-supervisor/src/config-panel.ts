/**
 * pi-tool-supervisor 的 TUI 配置面板。
 *
 * 原来用 `ctx.ui.select` 摆一串「状态：值」文本，屏幕上分不清哪行是状态、哪行按下去会怎样；
 * 改一个 reviewer 的字段要走十几次回车。这里改用 Pi 自带 `SettingsList`：
 * 左边字段名、右边当前值、选中项下方一行说明。开关原地切换，枚举回车开二级列表，
 * 自由文本回车开预填当前值的输入框。reviewer 是列表，所以面板分两层：
 * 顶层管全局字段并列出每个 reviewer，回车进入该 reviewer 自己的字段页。
 *
 * 审查模型是可搜索的二级列表（上方输入框 + 模糊匹配）：`SelectList.setFilter` 只做前缀匹配，
 * 输入 `low` 找不到 `llm-proxy/LOW`，所以用 `fuzzyFilter` 按词边界打分。
 *
 * 改一项先写回内存里的配置副本，由调用方负责落盘；落盘后重新加载配置即生效，不需要 /reload。
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
import {
	DEFAULT_TYPESAFE_MODEL,
	reviewerBackend,
	type FileEditReviewConfig,
	type FileEditReviewReviewerConfig,
	type ReviewBackend,
	type ReviewTrigger,
} from "./review-utils.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

/** 顶层面板的字段名。 */
export const ROOT_FIELD = {
	/** 总开关。 */
	enabled: "enabled",
	/** 审查超时秒数。 */
	timeoutSeconds: "timeoutSeconds",
	/** 修改后文件上下文最大字符数。 */
	maxFileContextChars: "maxFileContextChars",
	/** 规则文件最大行数。 */
	maxRuleLines: "maxRuleLines",
	/** TypeSafe API Key。 */
	typesafeApiKey: "typesafe.apiKey",
	/** TypeSafe 端点。 */
	typesafeEndpoint: "typesafe.endpoint",
	/** 添加一个 reviewer。 */
	addReviewer: "addReviewer",
} as const;

/** reviewer 字段页的字段名。 */
export const REVIEWER_FIELD = {
	/** 是否启用该 reviewer。 */
	enabled: "enabled",
	/** 名称。 */
	name: "name",
	/** 审查引擎。 */
	backend: "backend",
	/** 对话模型（`provider/model`）。 */
	model: "model",
	/** TypeSafe 模型名。 */
	typesafeModel: "typesafeModel",
	/** 规则文件列表。 */
	rulesFiles: "rulesFiles",
	/** 工具范围。 */
	tools: "tools",
	/** 触发阶段。 */
	trigger: "trigger",
	/** 条件模块路径。 */
	condition: "condition",
	/** 文件匹配模式。 */
	filePatterns: "filePatterns",
	/** 删除该 reviewer。 */
	remove: "remove",
} as const;

/** reviewer 字段名联合类型。 */
export type ReviewerFieldId = (typeof REVIEWER_FIELD)[keyof typeof REVIEWER_FIELD];

/**
 * 面板覆盖的字段名，测试用它核对没有字段漏在面板外。
 * token 形如 `reviewer.<字段>`，与顶层字段区分开。
 */
export const PANEL_FIELD_IDS: readonly string[] = [
	...Object.values(ROOT_FIELD),
	...Object.values(REVIEWER_FIELD).map((field) => `reviewer.${field}`),
];

/**
 * 面板覆盖的顶层配置字段（不含 reviewers 与 addReviewer 动作），
 * 测试用它对比 `FileEditReviewConfig` 的键，避免新增字段后忘了加面板行。
 */
export const ROOT_CONFIG_FIELD_IDS: readonly string[] = [
	ROOT_FIELD.enabled,
	ROOT_FIELD.timeoutSeconds,
	ROOT_FIELD.maxFileContextChars,
	ROOT_FIELD.maxRuleLines,
	ROOT_FIELD.typesafeApiKey,
	ROOT_FIELD.typesafeEndpoint,
];

/**
 * 面板覆盖的 reviewer 可编辑字段。
 *
 * 与旧 select 菜单能改的字段一一对应：
 * status/name/backend/model/rules/tools/trigger/condition/patterns/delete。
 */
export const REVIEWER_CONFIG_FIELD_IDS: readonly string[] = [
	REVIEWER_FIELD.enabled,
	REVIEWER_FIELD.name,
	REVIEWER_FIELD.backend,
	REVIEWER_FIELD.model,
	REVIEWER_FIELD.typesafeModel,
	REVIEWER_FIELD.rulesFiles,
	REVIEWER_FIELD.tools,
	REVIEWER_FIELD.trigger,
	REVIEWER_FIELD.condition,
	REVIEWER_FIELD.filePatterns,
	REVIEWER_FIELD.remove,
];

/** 审查引擎的候选值。 */
const BACKEND_VALUES: readonly ReviewBackend[] = ["model", "typesafe"];
/** 触发阶段的候选值。 */
const TRIGGER_VALUES: readonly ReviewTrigger[] = ["after", "before"];
/** 超时候选值（秒）。 */
const TIMEOUT_VALUES: readonly number[] = [5, 10, 30, 60, 120, 300];
/** 修改后文件上下文候选值（字符）。 */
const FILE_CONTEXT_VALUES: readonly number[] = [10_000, 20_000, 50_000, 100_000, 200_000];
/** 规则文件最大行数候选值。 */
const RULE_LINES_VALUES: readonly number[] = [50, 100, 200, 400, 800];
/** 二级列表最多同时显示几行；超出的部分由 SelectList 滚动。 */
const CHOICE_MENU_MAX_VISIBLE = 10;

/** 表示「打开」的存储值。 */
const TOGGLE_ON = "on";
/** 表示「关闭」的存储值。 */
const TOGGLE_OFF = "off";

/** 二级列表的一项：label 是展示文本，value 是写回配置的值。 */
export interface PanelOption {
	/** 展示文本。 */
	label: string;
	/** 写回配置的值。 */
	value: string;
}

/** 面板可用的模型：Pi 运行期注册的模型。 */
export interface ModelRef {
	/** provider id，例如 `llm-proxy`。 */
	provider: string;
	/** provider 内的模型 id，例如 `LOW`。 */
	model: string;
}

/** reviewer 字段页里一行的取值方式。 */
type ReviewerRowKind = "toggle" | "choice" | "text" | "model" | "textList" | "action";

/** reviewer 字段页的一行。 */
interface ReviewerRow {
	/** 字段名。 */
	id: ReviewerFieldId;
	/** 取值方式。 */
	kind: ReviewerRowKind;
	/** 只在某个 backend 下出现时填该 backend；留空表示两种 backend 都显示。 */
	backend?: ReviewBackend;
	/** 标题文案 key。 */
	labelKey: string;
	/** 说明文案 key。 */
	descriptionKey: string;
}

/** reviewer 字段页的行顺序：开关 → 身份 → 引擎 → 模型 → 规则 → 范围 → 动作。 */
const REVIEWER_ROWS: readonly ReviewerRow[] = [
	{ id: REVIEWER_FIELD.enabled, kind: "toggle", labelKey: "panelLabelReviewerEnabled", descriptionKey: "panelDescReviewerEnabled" },
	{ id: REVIEWER_FIELD.name, kind: "text", labelKey: "panelLabelReviewerName", descriptionKey: "panelDescReviewerName" },
	{ id: REVIEWER_FIELD.backend, kind: "choice", labelKey: "panelLabelBackend", descriptionKey: "panelDescBackend" },
	{ id: REVIEWER_FIELD.model, kind: "model", backend: "model", labelKey: "panelLabelModel", descriptionKey: "panelDescModel" },
	{ id: REVIEWER_FIELD.typesafeModel, kind: "text", backend: "typesafe", labelKey: "panelLabelTypesafeModel", descriptionKey: "panelDescTypesafeModel" },
	{ id: REVIEWER_FIELD.rulesFiles, kind: "textList", labelKey: "panelLabelRulesFiles", descriptionKey: "panelDescRulesFiles" },
	{ id: REVIEWER_FIELD.tools, kind: "textList", labelKey: "panelLabelTools", descriptionKey: "panelDescTools" },
	{ id: REVIEWER_FIELD.trigger, kind: "choice", labelKey: "panelLabelTrigger", descriptionKey: "panelDescTrigger" },
	{ id: REVIEWER_FIELD.condition, kind: "text", labelKey: "panelLabelCondition", descriptionKey: "panelDescCondition" },
	{ id: REVIEWER_FIELD.filePatterns, kind: "textList", labelKey: "panelLabelFilePatterns", descriptionKey: "panelDescFilePatterns" },
	{ id: REVIEWER_FIELD.remove, kind: "action", labelKey: "panelLabelRemove", descriptionKey: "panelDescRemove" },
];

/** 开关文案。 */
function toggleLabels(): { on: string; off: string } {
	return { on: i18n.t("panelOn"), off: i18n.t("panelOff") };
}

/** 开关候选项。 */
function toggleOptions(): PanelOption[] {
	const labels = toggleLabels();
	return [
		{ label: labels.on, value: TOGGLE_ON },
		{ label: labels.off, value: TOGGLE_OFF },
	];
}

/** 审查引擎候选项。 */
function backendOptions(): PanelOption[] {
	return BACKEND_VALUES.map((value) => ({
		label: i18n.t(value === "typesafe" ? "backendTypesafe" : "backendModel"),
		value,
	}));
}

/** 触发阶段候选项。 */
function triggerOptions(): PanelOption[] {
	return TRIGGER_VALUES.map((value) => ({
		label: i18n.t(value === "before" ? "panelTriggerBefore" : "panelTriggerAfter"),
		value,
	}));
}

/** 数值字段候选项；设置列表一律按字符串传递。 */
function numberOptions(values: readonly number[]): PanelOption[] {
	return values.map((value) => ({ label: String(value), value: String(value) }));
}

/** 模型候选项：第一项是默认/自定义入口，其余是 Pi 注册的 `provider/model`。 */
function modelOptions(models: readonly ModelRef[]): PanelOption[] {
	const options: PanelOption[] = [];
	const seen = new Set<string>();
	/** 追加一项，已出现过的 id 跳过。 */
	const push = (value: string): void => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		options.push({ label: value, value });
	};
	for (const model of models) push(`${model.provider}/${model.model}`);
	return options;
}

/** 按配置值取展示文本；不在候选表里就直接显示原值。 */
export function optionLabelForValue(options: readonly PanelOption[], value: string): string {
	return options.find((option) => option.value === value)?.label ?? value;
}

/** 按展示文本反查写回值；找不到返回 undefined，由调用方保持不变。 */
export function optionValueFromLabel(
	options: readonly PanelOption[],
	label: string,
): string | undefined {
	return options.find((option) => option.label === label)?.value;
}

/**
 * 按关键词过滤候选项；空关键词原样返回。
 *
 * `SelectList` 自带的 setFilter 只做前缀匹配，输入 `low` 永远找不到 `llm-proxy/LOW`。
 * 模糊匹配还会给词边界加分，所以 `provider/model` 这种名字从哪一段搜都行。
 */
export function filterOptions(options: readonly PanelOption[], query: string): PanelOption[] {
	return query.trim() ? fuzzyFilter([...options], query, (option) => option.label) : [...options];
}

/** 数组字段在面板上的展示文本：空数组显示「（未设置）」，否则逗号分隔。 */
export function displayListValue(values: readonly string[]): string {
	return values.length > 0 ? values.join(", ") : i18n.t("panelValueUnset");
}

/** 把输入框里的逗号分隔文本解析成数组；空串和「未设置」占位文案都解析成空数组。 */
export function parseListValue(raw: string): string[] {
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => Boolean(item) && item !== unsetPlaceholder());
}

/** 读取一个 reviewer 字段当前值的机器形态。 */
function readReviewerField(reviewer: FileEditReviewReviewerConfig, id: ReviewerFieldId): string {
	switch (id) {
		case REVIEWER_FIELD.enabled:
			return reviewer.enabled === false ? TOGGLE_OFF : TOGGLE_ON;
		case REVIEWER_FIELD.name:
			return reviewer.name;
		case REVIEWER_FIELD.backend:
			return reviewerBackend(reviewer);
		case REVIEWER_FIELD.model:
			return reviewer.model ?? "";
		case REVIEWER_FIELD.typesafeModel:
			return reviewer.typesafeModel ?? "";
		case REVIEWER_FIELD.condition:
			return reviewer.condition ?? "";
		case REVIEWER_FIELD.trigger:
			return reviewer.trigger ?? "after";
		default:
			return "";
	}
}

/** 读取一个 reviewer 的规则文件列表（兼容旧配置的单文件写法）。 */
function reviewerRulesFiles(reviewer: FileEditReviewReviewerConfig): string[] {
	if (reviewer.rulesFiles && reviewer.rulesFiles.length > 0) return reviewer.rulesFiles;
	return reviewer.rulesFile ? [reviewer.rulesFile] : [];
}

/** reviewer 字段页上显示的当前值。 */
export function displayReviewerValue(
	reviewer: FileEditReviewReviewerConfig,
	id: ReviewerFieldId,
): string {
	if (id === REVIEWER_FIELD.enabled) {
		const labels = toggleLabels();
		return readReviewerField(reviewer, id) === TOGGLE_ON ? labels.on : labels.off;
	}
	if (id === REVIEWER_FIELD.backend) {
		return optionLabelForValue(backendOptions(), readReviewerField(reviewer, id));
	}
	if (id === REVIEWER_FIELD.trigger) {
		return optionLabelForValue(triggerOptions(), readReviewerField(reviewer, id));
	}
	if (id === REVIEWER_FIELD.rulesFiles) return displayListValue(reviewerRulesFiles(reviewer));
	if (id === REVIEWER_FIELD.tools) {
		const tools = reviewer.tools ?? ["edit", "write"];
		return tools.length > 0 ? tools.join(", ") : i18n.t("panelValueUnset");
	}
	if (id === REVIEWER_FIELD.filePatterns) return displayListValue(reviewer.filePatterns ?? []);
	const stored = readReviewerField(reviewer, id);
	return stored || i18n.t("panelValueUnset");
}

/** 面板上代表「未设置」的占位文案；写回时把它当成清空，保证展示值与写回值是一对往返。 */
function unsetPlaceholder(): string {
	return i18n.t("panelValueUnset");
}

/** 把面板回传的文本去空白；等于「未设置」占位文案时视为空串。 */
function normalizeTextValue(value: string): string {
	return value.trim() === unsetPlaceholder() ? "" : value.trim();
}

/**
 * 把 reviewer 字段页回传的值写回配置对象。
 *
 * 返回 undefined 表示这一项不该由面板改或值无法识别，调用方保持原值。
 * 切换 backend 时会清掉另一个引擎专用的字段，避免同时存在 `model` 与 `backend: typesafe`。
 */
export function applyReviewerChange(
	reviewer: FileEditReviewReviewerConfig,
	id: string,
	value: string,
): FileEditReviewReviewerConfig | undefined {
	const labels = toggleLabels();
	const next: FileEditReviewReviewerConfig = { ...reviewer };
	switch (id) {
		case REVIEWER_FIELD.enabled:
			if (value !== labels.on && value !== labels.off) return undefined;
			next.enabled = value === labels.on;
			return next;
		case REVIEWER_FIELD.name:
			if (!value.trim()) return undefined;
			next.name = value.trim();
			return next;
		case REVIEWER_FIELD.backend: {
			const backend = optionValueFromLabel(backendOptions(), value);
			if (backend !== "model" && backend !== "typesafe") return undefined;
			if (backend === "typesafe") {
				next.backend = "typesafe";
				next.typesafeModel ??= DEFAULT_TYPESAFE_MODEL;
				delete next.model;
				return next;
			}
			if (!next.model) return undefined;
			delete next.backend;
			delete next.typesafeModel;
			return next;
		}
		case REVIEWER_FIELD.model: {
			const model = normalizeTextValue(value);
			// 「未设置」写回不改动：对话模型 reviewer 必须有模型，不能存空值。
			if (!model) return next;
			if (!/^[^/\s]+\/[^/\s]+$/.test(model)) return undefined;
			next.model = model;
			return next;
		}
		case REVIEWER_FIELD.typesafeModel:
			// 「未设置」写回默认值，与面板上显示的默认值一致。
			next.typesafeModel = normalizeTextValue(value) || DEFAULT_TYPESAFE_MODEL;
			return next;
		case REVIEWER_FIELD.rulesFiles: {
			const files = parseListValue(value);
			if (files.length === 0) return undefined;
			delete next.rulesFile;
			next.rulesFiles = files;
			return next;
		}
		case REVIEWER_FIELD.tools: {
			const tools = parseListValue(value);
			if (tools.length === 0) return undefined;
			next.tools = tools.includes("*") ? ["*"] : tools;
			return next;
		}
		case REVIEWER_FIELD.trigger: {
			const trigger = optionValueFromLabel(triggerOptions(), value);
			return trigger === undefined ? undefined : { ...next, trigger: trigger as ReviewTrigger };
		}
		case REVIEWER_FIELD.condition: {
			const condition = normalizeTextValue(value);
			if (condition) next.condition = condition;
			else delete next.condition;
			return next;
		}
		case REVIEWER_FIELD.filePatterns:
			next.filePatterns = parseListValue(value);
			return next;
		default:
			return undefined;
	}
}

/**
 * 顶层配置字段的写回。
 *
 * 数值字段只接受候选表里的值，所以面板不会写出超范围配置；`reviewers` 不由这里改。
 */
export function applyRootChange(
	config: FileEditReviewConfig,
	id: string,
	value: string,
): FileEditReviewConfig | undefined {
	const labels = toggleLabels();
	if (id === ROOT_FIELD.enabled) {
		if (value !== labels.on && value !== labels.off) return undefined;
		return { ...config, enabled: value === labels.on };
	}
	if (id === ROOT_FIELD.timeoutSeconds) {
		const picked = optionValueFromLabel(numberOptions(TIMEOUT_VALUES), value);
		return picked === undefined ? undefined : { ...config, timeoutSeconds: Number(picked) };
	}
	if (id === ROOT_FIELD.maxFileContextChars) {
		const picked = optionValueFromLabel(numberOptions(FILE_CONTEXT_VALUES), value);
		return picked === undefined ? undefined : { ...config, maxFileContextChars: Number(picked) };
	}
	if (id === ROOT_FIELD.maxRuleLines) {
		const picked = optionValueFromLabel(numberOptions(RULE_LINES_VALUES), value);
		return picked === undefined ? undefined : { ...config, maxRuleLines: Number(picked) };
	}
	if (id === ROOT_FIELD.typesafeApiKey || id === ROOT_FIELD.typesafeEndpoint) {
		const field = id === ROOT_FIELD.typesafeApiKey ? "apiKey" : "endpoint";
		const trimmed = normalizeTextValue(value);
		const typesafe: { apiKey?: string; endpoint?: string } = { ...(config.typesafe ?? {}) };
		if (trimmed) typesafe[field] = trimmed;
		else delete typesafe[field];
		if (typesafe.apiKey === undefined && typesafe.endpoint === undefined) {
			const { typesafe: _removed, ...rest } = config;
			return rest;
		}
		return { ...config, typesafe };
	}
	return undefined;
}

/** 自由文本子菜单：一个预填当前值的输入框。 */
function createTextSubmenu(
	value: string,
	placeholder: string,
	done: (value?: string) => void,
): Component {
	const input = new Input({ prompt: `${i18n.t("panelInputPrompt")} `, placeholder });
	input.setValue(value);
	input.focused = true;
	input.onSubmit = (submitted) => done(submitted);
	input.onEscape = () => done(undefined);
	return {
		/** 一行可编辑文本。 */
		render: (width) => input.render(width),
		/** 无本地缓存。 */
		invalidate: () => input.invalidate(),
		/** 按键全部交给输入框。 */
		handleInput: (data) => input.handleInput(data),
	};
}

/** 二级选择列表：Enter 选定并回传展示文本，Esc 不改动直接返回。 */
function createChoiceSubmenu(
	options: readonly PanelOption[],
	currentLabel: string,
	done: (selectedLabel?: string) => void,
	search: boolean,
): Component {
	/** 建一份列表快照，能对上当前值就预选中它。 */
	const buildList = (list: readonly PanelOption[], preselect: string | undefined): SelectList => {
		const items: SelectItem[] = list.map((option) => ({ value: option.label, label: option.label }));
		const selectList = new SelectList(
			items,
			Math.max(1, Math.min(items.length, CHOICE_MENU_MAX_VISIBLE)),
			getSelectListTheme(),
		);
		const index = list.findIndex((option) => option.label === preselect || option.value === preselect);
		if (index >= 0) selectList.setSelectedIndex(index);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		return selectList;
	};

	if (!search) return buildList(options, currentLabel);

	const input = new Input({ prompt: `${i18n.t("panelSearchPrompt")} ` });
	input.focused = true;
	input.onEscape = () => done(undefined);

	let list = buildList(options, currentLabel);
	let query = "";
	input.onSubmit = () => {
		const selected = list.getSelectedItem();
		if (selected) done(selected.value);
	};

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
				list = buildList(filterOptions(options, next), undefined);
			}
		},
	};
}

/** reviewer 字段页的动作钩子：由入口注入真正的删除与新增逻辑。 */
export interface ReviewerRowActions {
	/** 删除该 reviewer；返回 true 表示已删除，面板回到顶层。 */
	remove(reviewer: FileEditReviewReviewerConfig): Promise<boolean>;
}

/**
 * 把一行变成「Enter 就触发」的动作行。
 *
 * SettingsList 只在有 submenu 或 values 时才会触发 onChange，所以动作行给一个只有单值的
 * values：Enter/空格 会把同一个值再报一次，等于「按下执行」，而不会改变任何配置。
 */
function actionRow(item: SettingItem): SettingItem {
	return { ...item, values: [item.currentValue] };
}

/** 构造 reviewer 字段页的设置行；只显示当前 backend 用得到的模型字段。 */
export function buildReviewerItems(
	reviewer: FileEditReviewReviewerConfig,
	models: readonly ModelRef[],
): SettingItem[] {
	const backend = reviewerBackend(reviewer);
	return REVIEWER_ROWS
		.filter((row) => row.backend === undefined || row.backend === backend)
		.map((row) => {
			const label = i18n.t(row.labelKey);
			const description = i18n.t(row.descriptionKey);
			const currentValue = displayReviewerValue(reviewer, row.id);
			if (row.kind === "toggle") {
				return {
					id: row.id,
					label,
					description,
					currentValue,
					values: toggleOptions().map((option) => option.label),
				};
			}
			if (row.kind === "choice") {
				const options = row.id === REVIEWER_FIELD.backend
					? backendOptions()
					: row.id === REVIEWER_FIELD.trigger
						? triggerOptions()
						: [];
				return {
					id: row.id,
					label,
					description,
					currentValue,
					// 二级列表接管 Enter，避免在少量候选之间反复循环。
					submenu: (current, done) => createChoiceSubmenu(options, current, done, false),
				};
			}
			if (row.kind === "model") {
				const options = modelOptions(models);
				return {
					id: row.id,
					label,
					description,
					currentValue,
					// 模型动辄上百条，所以这一项要过滤输入框。
					submenu: (current, done) => createChoiceSubmenu(options, current, done, true),
				};
			}
			if (row.kind === "textList") {
				const stored = row.id === REVIEWER_FIELD.rulesFiles
					? reviewerRulesFiles(reviewer)
					: row.id === REVIEWER_FIELD.tools
						? reviewer.tools ?? []
						: reviewer.filePatterns ?? [];
				return {
					id: row.id,
					label,
					description,
					currentValue,
					submenu: (_current, done) =>
						createTextSubmenu(stored.join(", "), description, done),
				};
			}
			if (row.kind === "text") {
				return {
					id: row.id,
					label,
					description,
					currentValue,
					submenu: (_current, done) =>
						createTextSubmenu(readReviewerField(reviewer, row.id), description, done),
				};
			}
			return actionRow({ id: row.id, label, description, currentValue: i18n.t("panelActionHint") });
		});
}

/** 顶层设置行的构建参数。 */
export interface RootItemsOptions {
	/** 当前配置。 */
	config: FileEditReviewConfig;
}

/** 构造顶层设置行：全局字段 + 每个 reviewer 一行 + 「添加 reviewer」。 */
export function buildRootItems(options: RootItemsOptions): SettingItem[] {
	const { config } = options;
	const labels = toggleLabels();
	const items: SettingItem[] = [
		{
			id: ROOT_FIELD.enabled,
			label: i18n.t("panelLabelEnabled"),
			description: i18n.t("panelDescEnabled"),
			currentValue: config.enabled ? labels.on : labels.off,
			values: toggleOptions().map((option) => option.label),
		},
		{
			id: ROOT_FIELD.timeoutSeconds,
			label: i18n.t("panelLabelTimeout"),
			description: i18n.t("panelDescTimeout"),
			currentValue: String(config.timeoutSeconds),
			submenu: (current, done) =>
				createChoiceSubmenu(numberOptions(TIMEOUT_VALUES), current, done, false),
		},
		{
			id: ROOT_FIELD.maxFileContextChars,
			label: i18n.t("panelLabelFileContext"),
			description: i18n.t("panelDescFileContext"),
			currentValue: String(config.maxFileContextChars),
			submenu: (current, done) =>
				createChoiceSubmenu(numberOptions(FILE_CONTEXT_VALUES), current, done, false),
		},
		{
			id: ROOT_FIELD.maxRuleLines,
			label: i18n.t("panelLabelRuleLines"),
			description: i18n.t("panelDescRuleLines"),
			currentValue: String(config.maxRuleLines),
			submenu: (current, done) =>
				createChoiceSubmenu(numberOptions(RULE_LINES_VALUES), current, done, false),
		},
		{
			id: ROOT_FIELD.typesafeApiKey,
			label: i18n.t("panelLabelTypesafeApiKey"),
			description: i18n.t("panelDescTypesafeApiKey"),
			currentValue: config.typesafe?.apiKey || i18n.t("panelValueUnset"),
			submenu: (_current, done) =>
				createTextSubmenu(config.typesafe?.apiKey ?? "", i18n.t("panelDescTypesafeApiKey"), done),
		},
		{
			id: ROOT_FIELD.typesafeEndpoint,
			label: i18n.t("panelLabelTypesafeEndpoint"),
			description: i18n.t("panelDescTypesafeEndpoint"),
			currentValue: config.typesafe?.endpoint || i18n.t("panelValueUnset"),
			submenu: (_current, done) =>
				createTextSubmenu(config.typesafe?.endpoint ?? "", i18n.t("panelDescTypesafeEndpoint"), done),
		},
	];
	for (const reviewer of config.reviewers) {
		items.push(actionRow({
			id: `reviewer:${reviewer.name}`,
			label: `${reviewer.enabled === false ? "○" : "●"} ${reviewer.name}`,
			description: reviewerBackend(reviewer) === "typesafe"
				? i18n.t("backendTypesafe")
				: i18n.t("backendModel"),
			currentValue: reviewerModelLabelForPanel(reviewer),
		}));
	}
	items.push(actionRow({
		id: ROOT_FIELD.addReviewer,
		label: i18n.t("panelLabelAddReviewer"),
		description: i18n.t("panelDescAddReviewer"),
		currentValue: i18n.t("panelActionHint"),
	}));
	return items;
}

/** reviewer 行右侧显示的模型标签；与审计卡片保持一致。 */
function reviewerModelLabelForPanel(reviewer: FileEditReviewReviewerConfig): string {
	if (reviewerBackend(reviewer) === "typesafe") {
		return `typesafe/${reviewer.typesafeModel ?? DEFAULT_TYPESAFE_MODEL}`;
	}
	return reviewer.model ?? i18n.t("panelValueUnset");
}

/** 面板与宿主之间的接口；配置读写与生效动作都由入口注入。 */
export interface SupervisorPanelHandlers {
	/** 读取面板打开时的配置副本。 */
	getConfig(): FileEditReviewConfig;
	/** 读取当前可用模型，供审查模型候选使用。 */
	getModels(): readonly ModelRef[];
	/** 某一项被改动后调用，由入口负责落盘并重新加载配置。 */
	onChange(config: FileEditReviewConfig): Promise<void> | void;
	/** 添加一个 reviewer；返回新加的配置，取消时返回 undefined。 */
	onAddReviewer(config: FileEditReviewConfig): Promise<FileEditReviewReviewerConfig | undefined>;
}

/** 打开某个 reviewer 的字段页；返回 "back" 或 "removed"。 */
async function openReviewerPanel(
	ctx: ExtensionCommandContext,
	handlers: SupervisorPanelHandlers,
	index: number,
): Promise<"back" | "removed"> {
	/** 这一层的 reviewer 副本；改动即时写回并落盘。 */
	let current: FileEditReviewReviewerConfig = { ...handlers.getConfig().reviewers[index] };
	/** 用户在字段页里选择的动作。 */
	let removing = false;

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(
			new Text(theme.fg("accent", theme.bold(i18n.t("panelReviewerTitle", { name: current.name }))), 1, 1),
		);
		const list = new SettingsList(
			buildReviewerItems(current, handlers.getModels()),
			REVIEWER_ROWS.length,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === REVIEWER_FIELD.remove) {
					removing = true;
					done(undefined);
					return;
				}
				const next = applyReviewerChange(current, id, newValue);
				if (!next) return;
				current = next;
				const config = handlers.getConfig();
				const reviewers = [...config.reviewers];
				reviewers[index] = current;
				// 切 backend 会增删字段页的行，所以重建整个列表而不是只 updateValue。
				list.invalidate();
				void handlers.onChange({ ...config, reviewers });
				tui.requestRender();
			},
			() => done(undefined),
		);
		container.addChild(list);
		return {
			/** 布局交给 Container。 */
			render: (width) => container.render(width),
			/** 无本地缓存。 */
			invalidate: () => container.invalidate(),
			/** 按键交给列表，并触发一次重绘。 */
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (removing) {
		const confirmed = await ctx.ui.confirm(
			i18n.t("deleteTitle"),
			i18n.t("deleteMessage", { name: current.name }),
		);
		if (!confirmed) return openReviewerPanel(ctx, handlers, index);
		const config = handlers.getConfig();
		const reviewers = config.reviewers.filter((_reviewer, position) => position !== index);
		await handlers.onChange({ ...config, reviewers });
		return "removed";
	}
	return "back";
}

/** 打开 /config:tool-supervisor 面板；Esc 关闭，改动已经即时落盘。 */
export async function openSupervisorPanel(
	ctx: ExtensionCommandContext,
	handlers: SupervisorPanelHandlers,
): Promise<void> {
	while (true) {
		const config = handlers.getConfig();
		const selection = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(
				new Text(theme.fg("accent", theme.bold(i18n.t("configTitle"))), 1, 1),
			);
			const items = buildRootItems({ config });
			const list = new SettingsList(
				items,
				Math.max(1, items.length),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === ROOT_FIELD.addReviewer) {
						done(id);
						return;
					}
					if (id.startsWith("reviewer:")) {
						done(id);
						return;
					}
					const next = applyRootChange(config, id, newValue);
					if (!next) return;
					void handlers.onChange(next);
					tui.requestRender();
				},
				() => done(undefined),
			);
			container.addChild(list);
			return {
				/** 布局交给 Container。 */
				render: (width) => container.render(width),
				/** 无本地缓存。 */
				invalidate: () => container.invalidate(),
				/** 按键交给列表，并触发一次重绘。 */
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selection) return;
		if (selection === ROOT_FIELD.addReviewer) {
			const added = await handlers.onAddReviewer(config);
			if (added) {
				// 新加的 reviewer 直接进它的字段页，省掉一次「找那一行」的回车。
				await openReviewerPanel(ctx, handlers, handlers.getConfig().reviewers.length - 1);
			}
			continue;
		}
		if (!selection.startsWith("reviewer:")) continue;
		const name = selection.slice("reviewer:".length);
		const index = handlers.getConfig().reviewers.findIndex((reviewer) => reviewer.name === name);
		if (index < 0) continue;
		const result = await openReviewerPanel(ctx, handlers, index);
		if (result === "removed") continue;
	}
}
