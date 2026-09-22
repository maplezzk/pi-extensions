/**
 * 模型发现 provider 的 TUI 配置面板。
 *
 * 原来用 `ctx.ui.select` 摆一串「id — baseUrl（api）」文本，看不出哪行是状态、按下去会发生什么。
 * 这里改用 Pi 自带 `SettingsList`：左边字段名、右边当前值、选中项下方一行说明。
 * 面板分两层：第一层列出所有带 discoverModels 标记的 provider，回车进入某个 provider 的第二层，
 * 第二层就是这个 provider 的字段（发现开关、baseUrl、api、apiKey、显示名）和动作（立即发现、删除）。
 *
 * 枚举项回车开二级列表，自由文本回车开预填当前值的 Input 子菜单；改一项先写回内存配置，
 * 由调用方负责落盘与运行期生效，不需要 /reload。
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
} from "@earendil-works/pi-tui";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

/** `models.json` 里 api 类型的候选值。 */
export const API_CHOICES = [
	"openai-completions",
	"anthropic-messages",
	"openai-responses",
	"google-generative-ai",
] as const;

/** 某个 provider 在面板上的可编辑字段名。 */
export const PROVIDER_FIELD = {
	/** 是否参与模型发现；关闭时只去掉 discoverModels 标记，provider 本身保留。 */
	enabled: "enabled",
	/** 显示名。 */
	name: "name",
	/** API 地址。 */
	baseUrl: "baseUrl",
	/** api 类型。 */
	api: "api",
	/** API Key；支持 $ENV_VAR 插值。 */
	apiKey: "apiKey",
	/** 动作：立刻请求 {baseUrl}/models 刷新模型。 */
	rediscover: "rediscover",
	/** 动作：从 models.json 删除该 provider。 */
	remove: "remove",
} as const;

/** provider 面板字段名联合类型。 */
export type ProviderFieldId = (typeof PROVIDER_FIELD)[keyof typeof PROVIDER_FIELD];

/** 面板顶层：新增 provider 的入口字段名。 */
export const ROOT_FIELD = {
	/** 添加 provider。 */
	add: "add",
} as const;

/**
 * 面板覆盖的全部字段名（顶层 + provider 层），测试用它核对没有漏掉可编辑字段。
 * provider 层字段名带 `provider.` 前缀，与顶层区分开。
 */
export const PANEL_FIELD_IDS: readonly string[] = [
	ROOT_FIELD.add,
	...Object.values(PROVIDER_FIELD).map((field) => `provider.${field}`),
];

/** 面板里一个 provider 的读形态。 */
export interface PanelProvider {
	/** provider id，也是 models.json 里的键。 */
	id: string;
	/** baseUrl。 */
	baseUrl: string;
	/** api 类型。 */
	api: string;
	/** apiKey；空串表示未设置。 */
	apiKey: string;
	/** 显示名；空串表示未设置（回落为 id）。 */
	name: string;
	/** 是否带 discoverModels 标记。 */
	enabled: boolean;
}

/** 开关在面板上显示的两个文案。 */
function toggleLabels(): { on: string; off: string } {
	return { on: i18n.t("panelOn"), off: i18n.t("panelOff") };
}

/** 下拉列表的一项：label 是展示文本，value 是写回配置的值。 */
interface PanelOption {
	/** 展示文本。 */
	label: string;
	/** 写回配置的值。 */
	value: string;
}

/** 二级列表最多同时显示几行；超出的部分由 SelectList 滚动。 */
const CHOICE_MENU_MAX_VISIBLE = 10;

/** provider 面板的行顺序：开关在最前，动作用特殊后缀区分。 */
const PROVIDER_ROWS: readonly {
	/** 字段名。 */
	id: ProviderFieldId;
	/** 取值方式：开关原地切换，枚举开列表，文本开输入框，动作直接执行。 */
	kind: "toggle" | "choice" | "text" | "action";
	/** 标题文案 key。 */
	labelKey: string;
	/** 说明文案 key。 */
	descriptionKey: string;
}[] = [
	{ id: PROVIDER_FIELD.enabled, kind: "toggle", labelKey: "panelLabelEnabled", descriptionKey: "panelDescEnabled" },
	{ id: PROVIDER_FIELD.name, kind: "text", labelKey: "panelLabelName", descriptionKey: "panelDescName" },
	{ id: PROVIDER_FIELD.baseUrl, kind: "text", labelKey: "panelLabelBaseUrl", descriptionKey: "panelDescBaseUrl" },
	{ id: PROVIDER_FIELD.api, kind: "choice", labelKey: "panelLabelApi", descriptionKey: "panelDescApi" },
	{ id: PROVIDER_FIELD.apiKey, kind: "text", labelKey: "panelLabelApiKey", descriptionKey: "panelDescApiKey" },
	{ id: PROVIDER_FIELD.rediscover, kind: "action", labelKey: "panelLabelRediscover", descriptionKey: "panelDescRediscover" },
	{ id: PROVIDER_FIELD.remove, kind: "action", labelKey: "panelLabelRemove", descriptionKey: "panelDescRemove" },
];

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

/** 开关候选项。 */
function toggleOptions(): PanelOption[] {
	const labels = toggleLabels();
	return [
		{ label: labels.on, value: "on" },
		{ label: labels.off, value: "off" },
	];
}

/** api 类型候选项。 */
function apiOptions(): PanelOption[] {
	return API_CHOICES.map((value) => ({ label: value, value }));
}

/** 某个字段的候选表；文本和动作字段没有候选项。 */
function fieldOptions(id: ProviderFieldId): PanelOption[] {
	if (id === PROVIDER_FIELD.enabled) return toggleOptions();
	if (id === PROVIDER_FIELD.api) return apiOptions();
	return [];
}

/** 读取一个字段当前值的机器形态。 */
function readProviderField(provider: PanelProvider, id: ProviderFieldId): string {
	switch (id) {
		case PROVIDER_FIELD.enabled:
			return provider.enabled ? "on" : "off";
		case PROVIDER_FIELD.name:
			return provider.name;
		case PROVIDER_FIELD.baseUrl:
			return provider.baseUrl;
		case PROVIDER_FIELD.api:
			return provider.api;
		case PROVIDER_FIELD.apiKey:
			return provider.apiKey;
		default:
			return "";
	}
}

/** 面板上显示的当前值；文本字段留空时显示「未设置」。 */
function displayProviderValue(provider: PanelProvider, id: ProviderFieldId): string {
	const stored = readProviderField(provider, id);
	if (id === PROVIDER_FIELD.enabled) {
		const labels = toggleLabels();
		return stored === "on" ? labels.on : labels.off;
	}
	if (id === PROVIDER_FIELD.api) return optionLabelForValue(apiOptions(), stored);
	if (id === PROVIDER_FIELD.apiKey || id === PROVIDER_FIELD.name) {
		return stored || i18n.t("panelValueUnset");
	}
	return stored;
}

/**
 * 把面板回传的展示文本写回 provider。
 *
 * 返回 undefined 表示这一项不该由面板改（未知字段，或候选表里没有这个标签），
 * 调用方保持原值。动作字段（rediscover/remove）不走这里，由面板单独处理。
 */
export function applyProviderChange(
	provider: PanelProvider,
	id: string,
	value: string,
): PanelProvider | undefined {
	const labels = toggleLabels();
	switch (id) {
		case PROVIDER_FIELD.enabled: {
			if (value !== labels.on && value !== labels.off) return undefined;
			return { ...provider, enabled: value === labels.on };
		}
		case PROVIDER_FIELD.name:
			return { ...provider, name: value.trim() };
		case PROVIDER_FIELD.baseUrl:
			return { ...provider, baseUrl: value.trim() };
		case PROVIDER_FIELD.api: {
			const api = optionValueFromLabel(apiOptions(), value);
			return api === undefined ? undefined : { ...provider, api };
		}
		case PROVIDER_FIELD.apiKey:
			return { ...provider, apiKey: value.trim() };
		default:
			return undefined;
	}
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
): Component {
	const items: SelectItem[] = options.map((option) => ({ value: option.label, label: option.label }));
	const list = new SelectList(
		items,
		Math.max(1, Math.min(items.length, CHOICE_MENU_MAX_VISIBLE)),
		getSelectListTheme(),
	);
	const currentIndex = options.findIndex((option) => option.label === currentLabel);
	if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done(undefined);
	return {
		/** 直接渲染候选列表。 */
		render: (width) => list.render(width),
		/** 无本地缓存。 */
		invalidate: () => list.invalidate(),
		/** 按键全部交给列表。 */
		handleInput: (data) => list.handleInput(data),
	};
}

/** provider 面板行的动作钩子：由入口注入，负责真正执行发现或删除。 */
export interface ProviderRowActions {
	/** 立刻重新发现该 provider 的模型。 */
	rediscover(provider: PanelProvider): Promise<void>;
	/** 删除该 provider；返回 true 表示已删除，面板回到顶层。 */
	remove(provider: PanelProvider): Promise<boolean>;
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

/** 构造 provider 层的设置行。 */
export function buildProviderItems(provider: PanelProvider): SettingItem[] {
	return PROVIDER_ROWS.map((row) => {
		const label = i18n.t(row.labelKey);
		const description = i18n.t(row.descriptionKey);
		const currentValue = displayProviderValue(provider, row.id);
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
			return {
				id: row.id,
				label,
				description,
				currentValue,
				// 二级列表接管 Enter，避免在少量候选之间反复循环。
				submenu: (current, done) =>
					createChoiceSubmenu(apiOptions(), current, done),
			};
		}
		if (row.kind === "text") {
			return {
				id: row.id,
				label,
				description,
				currentValue,
				submenu: (_current, done) =>
					createTextSubmenu(readProviderField(provider, row.id), description, done),
			};
		}
		return actionRow({ id: row.id, label, description, currentValue: i18n.t("panelActionHint") });
	});
}

/** 构造顶层的设置行：一个 provider 一行，外加「添加 provider」。 */
export function buildRootItems(providers: readonly PanelProvider[]): SettingItem[] {
	const items: SettingItem[] = providers.map((provider) => actionRow({
		id: `provider:${provider.id}`,
		label: `${provider.enabled ? "●" : "○"} ${provider.id}`,
		description: `${provider.baseUrl || "?"} · ${provider.api || "?"}`,
		currentValue: provider.name || provider.id,
	}));
	items.push(actionRow({
		id: ROOT_FIELD.add,
		label: i18n.t("panelLabelAdd"),
		description: i18n.t("panelDescAdd"),
		currentValue: i18n.t("panelActionHint"),
	}));
	return items;
}

/** 面板与宿主之间的接口；provider 列表、写回动作都由入口提供。 */
export interface PanelState {
	/** 当前所有带发现标记的 provider；每次现读，因为增删会改变列表。 */
	getProviders(): PanelProvider[];
	/** provider 配置被改动后调用；由调用方负责落盘与注册。 */
	onProviderChange(provider: PanelProvider): void;
	/** provider 被删除后调用。 */
	onProviderRemoved(id: string): void;
	/** 新增 provider；由调用方负责落盘与首次发现。 */
	onProviderAdd(provider: PanelProvider): void;
	/** 行动作。 */
	actions: ProviderRowActions;
}

/** 顶层列表：选中 provider 进第二层，选中「添加」走新增流程。 */
async function openProviderPanel(
	ctx: ExtensionCommandContext,
	state: PanelState,
	provider: PanelProvider,
): Promise<"back" | "removed"> {
	/** 当前这一层的 provider 副本；改动即时写回内存。 */
	let current: PanelProvider = { ...provider };
	/** 用户在子菜单里选择的动作结果。 */
	let pending: { kind: "rediscover" } | { kind: "remove" } | undefined;

	const settingsList = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(
			new Text(theme.fg("accent", theme.bold(i18n.t("panelProviderTitle", { id: current.id }))), 1, 1),
		);
		const list = new SettingsList(
			buildProviderItems(current),
			PROVIDER_ROWS.length,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === PROVIDER_FIELD.rediscover) {
					pending = { kind: "rediscover" };
					done(undefined);
					return;
				}
				if (id === PROVIDER_FIELD.remove) {
					pending = { kind: "remove" };
					done(undefined);
					return;
				}
				const next = applyProviderChange(current, id, newValue);
				if (!next) return;
				current = next;
				state.onProviderChange(current);
				list.updateValue(id, displayProviderValue(current, id as ProviderFieldId));
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

	if (pending?.kind === "rediscover") {
		await state.actions.rediscover(current);
		return openProviderPanel(ctx, state, current);
	}
	if (pending?.kind === "remove") {
		const confirmed = await ctx.ui.confirm(
			i18n.t("panelConfirmRemove", { id: current.id }),
			i18n.t("panelRemoveMessage"),
		);
		if (confirmed && (await state.actions.remove(current))) {
			state.onProviderRemoved(current.id);
			return "removed";
		}
		return openProviderPanel(ctx, state, current);
	}
	return "back";
}

/** 新增 provider 的表单结果。 */
interface NewProviderInput {
	/** provider id。 */
	id: string;
	/** baseUrl。 */
	baseUrl: string;
	/** api 类型。 */
	api: string;
	/** apiKey。 */
	apiKey: string;
	/** 显示名。 */
	name: string;
}

/** 提示并校验一个值；返回 undefined 表示用户取消或校验失败（失败已提示）。 */
async function askValidated(
	ctx: ExtensionCommandContext,
	options: {
		/** 输入框标题。 */
		title: string;
		/** 预填值。 */
		initial?: string;
		/** 校验函数；通过返回 undefined，失败返回错误文案 key 的参数。 */
		validate(value: string): { key: string; params?: Record<string, string> } | undefined;
	},
): Promise<string | undefined> {
	const value = (await ctx.ui.input(options.title, options.initial))?.trim();
	if (value === undefined) return undefined;
	if (!value) return undefined;
	const failure = options.validate(value);
	if (failure) {
		ctx.ui.notify(i18n.t(failure.key, failure.params), "error");
		return undefined;
	}
	return value;
}

/** 逐项问出新增 provider 需要的字段；任一项取消就整体放弃。 */
async function collectNewProvider(
	ctx: ExtensionCommandContext,
	existingIds: ReadonlySet<string>,
): Promise<NewProviderInput | undefined> {
	const id = await askValidated(ctx, {
		title: i18n.t("providerId"),
		validate: (value) => {
			if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) return { key: "invalidId" };
			if (existingIds.has(value)) return { key: "exists", params: { id: value } };
			return undefined;
		},
	});
	if (!id) return undefined;
	const baseUrl = await askValidated(ctx, {
		title: i18n.t("baseUrl"),
		validate: (value) => (/^https?:\/\//.test(value) ? undefined : { key: "invalidUrl" }),
	});
	if (!baseUrl) return undefined;
	const api = await ctx.ui.select(i18n.t("api"), [...API_CHOICES]);
	if (!api) return undefined;
	const apiKey = (await ctx.ui.input(i18n.t("apiKey")))?.trim() ?? "";
	const name = (await ctx.ui.input(i18n.t("displayName", { id })))?.trim() ?? "";
	return { id, baseUrl, api, apiKey, name };
}

/** 打开 /config:model-discovery 面板；Esc 关闭，改动已经即时写回。 */
export async function openDiscoveryPanel(
	ctx: ExtensionCommandContext,
	state: PanelState,
): Promise<void> {
	while (true) {
		const providers = state.getProviders();
		const selection = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(
				new Text(theme.fg("accent", theme.bold(i18n.t("panelTitle", { count: providers.length }))), 1, 1),
			);
			const items = buildRootItems(providers);
			const list = new SettingsList(
				items,
				Math.max(1, items.length),
				getSettingsListTheme(),
				(id) => done(id),
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
		if (selection === ROOT_FIELD.add) {
			const existingIds = new Set(state.getProviders().map((provider) => provider.id));
			const input = await collectNewProvider(ctx, existingIds);
			if (!input) continue;
			const provider: PanelProvider = {
				id: input.id,
				baseUrl: input.baseUrl,
				api: input.api,
				apiKey: input.apiKey,
				name: input.name,
				enabled: true,
			};
			state.onProviderAdd(provider);
			continue;
		}
		if (!selection.startsWith("provider:")) continue;
		const id = selection.slice("provider:".length);
		const provider = state.getProviders().find((candidate) => candidate.id === id);
		if (!provider) continue;
		const result = await openProviderPanel(ctx, state, provider);
		if (result === "removed") continue;
	}
}
