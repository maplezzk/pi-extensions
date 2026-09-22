/**
 * pi-gen-ui configuration panel.
 *
 * Pi's built-in `SettingsList` draws every row: field name on the left, current value on the
 * right, one description line under the selection. Enter/Space cycles a toggle in place, Enter
 * opens a submenu for enumerations and text fields. Each change is written to disk and applied
 * to the running session immediately, so closing the panel leaves the new configuration live.
 *
 * Long candidate lists (models) put an `Input` above the submenu and re-filter on every
 * keystroke. `SelectList.setFilter` only matches a prefix, so typing `LOW` never finds
 * `llm-proxy/LOW`; `fuzzyFilter` scores word boundaries and treats `/` as a separator instead.
 */

import {
	getSelectListTheme,
	getSettingsListTheme,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	SelectList,
	SettingsList,
	Text,
	fuzzyFilter,
	getKeybindings,
	type Component,
	type SelectItem,
	type SettingItem,
} from "@earendil-works/pi-tui";
import {
	PROVIDER_DEFAULTS,
	normalizeConfig,
	withComposition,
	type CompositionProvider,
	type InteractiveViewMode,
	type JsonRenderConfig,
} from "./config.ts";
import { i18n } from "./i18n.ts";

/** One model Pi can run, as reported by its model registry. */
export interface ModelRef {
	/** Provider id, for example `llm-proxy`. */
	provider: string;
	/** Model id within the provider. */
	id: string;
}

/** Field ids shared by the panel rows and the `/config:gen-ui` arguments. */
export const PANEL_FIELD = {
	enabled: "enabled",
	interactiveView: "interactiveView",
	maxResultLines: "maxResultLines",
	compositionEnabled: "composition.enabled",
	provider: "composition.provider",
	model: "composition.model",
	apiKeyEnv: "composition.apiKeyEnv",
	endpoint: "composition.endpoint",
	timeoutMs: "composition.timeoutMs",
} as const;

/** Union of the panel field ids. */
export type PanelFieldId = (typeof PANEL_FIELD)[keyof typeof PANEL_FIELD];

/** Candidate values offered for each enumeration field. */
const VIEW_MODE_VALUES: readonly InteractiveViewMode[] = ["auto", "always", "never"];
const PROVIDER_VALUES: readonly CompositionProvider[] = ["auto", "typesafe", "gateway"];
const MAX_RESULT_LINES_VALUES: readonly number[] = [20, 40, 60, 100, 200, 500];
const TIMEOUT_VALUES: readonly number[] = [5000, 10000, 30000, 60000, 120000];

/** Localization key holding the display label of one enumeration member. */
const VIEW_MODE_LABEL_KEYS: Record<InteractiveViewMode, string> = {
	auto: "configViewAuto",
	always: "configViewAlways",
	never: "configViewNever",
};

/** Localization key holding the display label of one composition transport. */
const PROVIDER_LABEL_KEYS: Record<CompositionProvider, string> = {
	auto: "configProviderAuto",
	typesafe: "configProviderTypesafe",
	gateway: "configProviderGateway",
};

/** Submenu rows shown at once; longer candidate lists scroll inside `SelectList`. */
const CHOICE_MENU_MAX_VISIBLE = 10;

/** Stored values standing in for the two boolean states. */
const TOGGLE_ON = "on";
const TOGGLE_OFF = "off";

/** One entry of a candidate list: the label is displayed and the value is stored. */
export interface PanelOption {
	/** Text shown in the panel and in the submenu. */
	label: string;
	/** Value written back to the configuration. */
	value: string;
}

/** One panel row: what it is called and which kind of editor it opens. */
interface PanelField {
	/** Field id. */
	id: PanelFieldId;
	/** `toggle` cycles in place, `choice` opens a candidate list, `text` edits free text. */
	kind: "toggle" | "choice" | "text";
	/** Localization key of the row label. */
	labelKey: string;
	/** Localization key of the description line. */
	descriptionKey: string;
	/** Whether the candidate list needs a filter input above it. */
	search?: boolean;
}

/** Localized toggle labels, so the configuration never stores localized text. */
function toggleLabels(): { on: string; off: string } {
	return { on: i18n.t("configOn"), off: i18n.t("configOff") };
}

/** Candidate list for a boolean flag. */
function toggleOptions(): PanelOption[] {
	const labels = toggleLabels();
	return [
		{ label: labels.on, value: TOGGLE_ON },
		{ label: labels.off, value: TOGGLE_OFF },
	];
}

/** Candidate list for the interactive-panel view mode. */
function viewModeOptions(): PanelOption[] {
	return VIEW_MODE_VALUES.map((value) => ({ label: i18n.t(VIEW_MODE_LABEL_KEYS[value]), value }));
}

/** Candidate list for the composition transport. */
function providerOptions(): PanelOption[] {
	return PROVIDER_VALUES.map((value) => ({ label: i18n.t(PROVIDER_LABEL_KEYS[value]), value }));
}

/** Candidate list for a numeric field; `SettingsList` carries every value as a string. */
function numberOptions(values: readonly number[]): PanelOption[] {
	return values.map((value) => ({ label: String(value), value: String(value) }));
}

/**
 * Candidate list for the evaluation model.
 *
 * The two channel defaults come first so the common choice is one Enter away; the rest is
 * whatever Pi has registered, which is what makes the filter input worth having.
 */
function modelOptions(models: readonly ModelRef[]): PanelOption[] {
	const options: PanelOption[] = [{ label: i18n.t("configModelChannelDefault"), value: "" }];
	const seen = new Set<string>([""]);
	/** Append one candidate, ignoring ids already listed. */
	const push = (value: string): void => {
		if (seen.has(value)) return;
		seen.add(value);
		options.push({ label: value, value });
	};
	push(PROVIDER_DEFAULTS.typesafe.model);
	push(PROVIDER_DEFAULTS.gateway.model);
	for (const model of models) push(`${model.provider}/${model.id}`);
	return options;
}

/** Display label for a stored value; an unlisted value is shown as-is. */
export function optionLabelForValue(options: readonly PanelOption[], value: string): string {
	return options.find((option) => option.value === value)?.label ?? value;
}

/** Stored value for a displayed label; `undefined` means the candidate list has changed. */
export function optionValueFromLabel(
	options: readonly PanelOption[],
	label: string,
): string | undefined {
	return options.find((option) => option.label === label)?.value;
}

/** Panel rows in display order: the master switch first, rare transports last. */
const PANEL_FIELDS: readonly PanelField[] = [
	{ id: PANEL_FIELD.enabled, kind: "toggle", labelKey: "configLabelEnabled", descriptionKey: "configDescEnabled" },
	{
		id: PANEL_FIELD.interactiveView,
		kind: "choice",
		labelKey: "configLabelInteractiveView",
		descriptionKey: "configDescInteractiveView",
	},
	{
		id: PANEL_FIELD.maxResultLines,
		kind: "choice",
		labelKey: "configLabelMaxResultLines",
		descriptionKey: "configDescMaxResultLines",
	},
	{
		id: PANEL_FIELD.compositionEnabled,
		kind: "toggle",
		labelKey: "configLabelCompositionEnabled",
		descriptionKey: "configDescCompositionEnabled",
	},
	{ id: PANEL_FIELD.provider, kind: "choice", labelKey: "configLabelProvider", descriptionKey: "configDescProvider" },
	{
		id: PANEL_FIELD.model,
		kind: "choice",
		labelKey: "configLabelModel",
		descriptionKey: "configDescModel",
		search: true,
	},
	{ id: PANEL_FIELD.apiKeyEnv, kind: "text", labelKey: "configLabelApiKeyEnv", descriptionKey: "configDescApiKeyEnv" },
	{ id: PANEL_FIELD.endpoint, kind: "text", labelKey: "configLabelEndpoint", descriptionKey: "configDescEndpoint" },
	{ id: PANEL_FIELD.timeoutMs, kind: "choice", labelKey: "configLabelTimeout", descriptionKey: "configDescTimeout" },
];

/** Field ids the panel covers; tests use it to prove no configuration field is left out. */
export const PANEL_FIELD_IDS: readonly string[] = PANEL_FIELDS.map((field) => field.id);

/** Candidate list of one field; text fields have none. */
function fieldOptions(id: PanelFieldId, models: readonly ModelRef[]): PanelOption[] {
	switch (id) {
		case PANEL_FIELD.enabled:
		case PANEL_FIELD.compositionEnabled:
			return toggleOptions();
		case PANEL_FIELD.interactiveView:
			return viewModeOptions();
		case PANEL_FIELD.maxResultLines:
			return numberOptions(MAX_RESULT_LINES_VALUES);
		case PANEL_FIELD.provider:
			return providerOptions();
		case PANEL_FIELD.model:
			return modelOptions(models);
		case PANEL_FIELD.timeoutMs:
			return numberOptions(TIMEOUT_VALUES);
		default:
			return [];
	}
}

/** Current stored value of one field, as carried through the panel. */
function readField(config: JsonRenderConfig, id: PanelFieldId): string {
	switch (id) {
		case PANEL_FIELD.enabled:
			return config.enabled ? TOGGLE_ON : TOGGLE_OFF;
		case PANEL_FIELD.interactiveView:
			return config.interactiveView;
		case PANEL_FIELD.maxResultLines:
			return String(config.maxResultLines);
		case PANEL_FIELD.compositionEnabled:
			return config.composition.enabled ? TOGGLE_ON : TOGGLE_OFF;
		case PANEL_FIELD.provider:
			return config.composition.provider;
		case PANEL_FIELD.model:
			return config.composition.model;
		case PANEL_FIELD.apiKeyEnv:
			return config.composition.apiKeyEnv;
		case PANEL_FIELD.endpoint:
			return config.composition.endpoint;
		case PANEL_FIELD.timeoutMs:
			return String(config.composition.timeoutMs);
	}
}

/** Rebuild the configuration with a new stored value for one field. */
function writeField(config: JsonRenderConfig, id: PanelFieldId, value: string): JsonRenderConfig {
	switch (id) {
		case PANEL_FIELD.enabled:
			return { ...config, enabled: value === TOGGLE_ON };
		case PANEL_FIELD.interactiveView:
			return { ...config, interactiveView: value as InteractiveViewMode };
		case PANEL_FIELD.maxResultLines:
			return { ...config, maxResultLines: Number(value) };
		case PANEL_FIELD.compositionEnabled:
			return withComposition(config, { enabled: value === TOGGLE_ON });
		case PANEL_FIELD.provider:
			return withComposition(config, { provider: value as CompositionProvider });
		case PANEL_FIELD.model:
			return withComposition(config, { model: value });
		case PANEL_FIELD.apiKeyEnv:
			return withComposition(config, { apiKeyEnv: value });
		case PANEL_FIELD.endpoint:
			return withComposition(config, { endpoint: value });
		case PANEL_FIELD.timeoutMs:
			return withComposition(config, { timeoutMs: Number(value) });
	}
}

/** Turn candidate options into `SelectList` items; the label is what gets returned on select. */
function toSelectItems(options: readonly PanelOption[]): SelectItem[] {
	return options.map((option) => ({ value: option.label, label: option.label }));
}

/**
 * Filter candidate options by a free-text query; an empty query keeps every option.
 *
 * `SelectList`'s own filter only matches a prefix, so typing `low` would never reach
 * `llm-proxy/LOW`. Fuzzy matching also scores word boundaries, which is what makes
 * `provider/model` ids searchable by either half.
 */
export function filterOptions(options: readonly PanelOption[], query: string): PanelOption[] {
	return query.trim() ? fuzzyFilter([...options], query, (option) => option.label) : [...options];
}

/**
 * Candidate submenu.
 *
 * Without `search` this is a plain list. With `search` an `Input` sits above it and the
 * candidate list is rebuilt on every keystroke from `fuzzyFilter`, because `SelectList`'s own
 * filter only matches prefixes.
 */
function createChoiceSubmenu(
	options: readonly PanelOption[],
	currentLabel: string,
	done: (selectedLabel?: string) => void,
	search: boolean,
): Component {
	/** Build one list snapshot, preselecting the current value when it is present. */
	const buildList = (list: readonly PanelOption[], preselect: string | undefined): SelectList => {
		const selectItems = toSelectItems(list);
		const selectList = new SelectList(
			selectItems,
			Math.max(1, Math.min(selectItems.length, CHOICE_MENU_MAX_VISIBLE)),
			getSelectListTheme(),
		);
		const index = list.findIndex((option) => option.label === preselect);
		if (index >= 0) selectList.setSelectedIndex(index);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		return selectList;
	};

	if (!search) return buildList(options, currentLabel);

	const input = new Input({ prompt: `${i18n.t("configSearchPrompt")} ` });
	input.focused = true;
	input.onEscape = () => done(undefined);

	let list = buildList(options, currentLabel);
	let query = "";
	input.onSubmit = () => {
		const selected = list.getSelectedItem();
		if (selected) done(selected.value);
	};

	return {
		/** Filter input on top, then the filtered candidates. */
		render: (width) => [...input.render(width), ...list.render(width)],
		/** Both children keep no shared cache. */
		invalidate: () => {
			input.invalidate();
			list.invalidate();
		},
		/** Arrows drive the list; every other key, Enter included, goes to the filter. */
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

/** Free-text submenu: an `Input` prefilled with the current value. */
function createTextSubmenu(
	value: string,
	placeholder: string,
	done: (value?: string) => void,
): Component {
	const input = new Input({ prompt: `${i18n.t("configInputPrompt")} `, placeholder });
	input.setValue(value);
	input.focused = true;
	input.onSubmit = (submitted) => done(submitted);
	input.onEscape = () => done(undefined);
	return {
		/** One editable line. */
		render: (width) => input.render(width),
		/** No local cache. */
		invalidate: () => input.invalidate(),
		/** All keys belong to the input. */
		handleInput: (data) => input.handleInput(data),
	};
}

/** Build the rows `SettingsList` renders for one configuration snapshot. */
export function buildSettingItems(
	config: JsonRenderConfig,
	models: readonly ModelRef[],
): SettingItem[] {
	return PANEL_FIELDS.map((field) => {
		const label = i18n.t(field.labelKey);
		const description = i18n.t(field.descriptionKey);
		const options = fieldOptions(field.id, models);
		const stored = readField(config, field.id);
		const currentValue =
			field.kind === "text"
				? stored || i18n.t("configValueUnset")
				: optionLabelForValue(options, stored);

		if (field.kind === "toggle") {
			return {
				id: field.id,
				label,
				description,
				currentValue,
				values: options.map((option) => option.label),
			};
		}
		if (field.kind === "choice") {
			return {
				id: field.id,
				label,
				description,
				currentValue,
				// The submenu owns Enter so long lists never cycle through every value in place.
				submenu: (current, done) =>
					createChoiceSubmenu(options, current, done, field.search === true),
			};
		}
		return {
			id: field.id,
			label,
			description,
			currentValue,
			submenu: (_current, done) => createTextSubmenu(stored, description, done),
		};
	});
}

/**
 * Apply one panel change and return the next configuration.
 *
 * Returns `undefined` when the row is unknown or the picked label is no longer in the candidate
 * list, so a stale panel can never write a value nobody offered. The result is normalized, which
 * keeps the stored value inside the same bounds the loader enforces.
 */
export function applyPanelChange(
	config: JsonRenderConfig,
	id: string,
	value: string,
	models: readonly ModelRef[] = [],
): JsonRenderConfig | undefined {
	const field = PANEL_FIELDS.find((candidate) => candidate.id === id);
	if (!field) return undefined;
	if (field.kind === "text") return normalizeConfig(writeField(config, field.id, value));
	const stored = optionValueFromLabel(fieldOptions(field.id, models), value);
	if (stored === undefined) return undefined;
	return normalizeConfig(writeField(config, field.id, stored));
}

/** Panel contract; the entry point injects configuration access and the apply action. */
export interface ConfigPanelHandlers {
	/** Read the live configuration. */
	getConfig(): JsonRenderConfig;
	/** Read the models available to pick from. */
	getModels(): readonly ModelRef[];
	/** Called after every change; persists and applies it to the session. */
	onChange(config: JsonRenderConfig): void;
}

/** Open the panel; changes are applied as they are made and Esc closes it. */
export async function openConfigPanel(
	ctx: ExtensionCommandContext,
	handlers: ConfigPanelHandlers,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(i18n.t("configMenuTitle"))), 1, 1));

		const settingsList = new SettingsList(
			buildSettingItems(handlers.getConfig(), handlers.getModels()),
			PANEL_FIELDS.length,
			getSettingsListTheme(),
			(id, newValue) => {
				const next = applyPanelChange(handlers.getConfig(), id, newValue, handlers.getModels());
				if (next) handlers.onChange(next);
			},
			() => done(undefined),
		);
		container.addChild(settingsList);

		return {
			/** Layout belongs to the container. */
			render: (width) => container.render(width),
			/** No local cache; the container clears its children. */
			invalidate: () => container.invalidate(),
			/** Keys go to the list, then force a repaint so the new value shows up. */
			handleInput: (data) => {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
