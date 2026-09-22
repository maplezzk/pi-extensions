/**
 * pi-naming 的 TUI 配置面板。
 *
 * 原来用 `ctx.ui.select` 开链式菜单，一行文字里既放当前值又放「按下去会变成什么」，
 * 屏幕上看不出哪项是状态、哪项是按钮。这里改用 Pi 自带 `SettingsList`：
 * 左边字段名、右边当前值、选中项下方给一行说明。开关项原地切换，枚举与数值项回车
 * 打开二级列表，自由文本项回车打开预填当前值的输入框。改一项立即写盘并同步运行期配置，
 * Esc 关闭，全程不需要 /reload。
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
  type Component,
  type SelectItem,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { LANGUAGE_PRESETS, MAX_LENGTH_PRESETS, MAX_TOKENS_PRESETS, PREFERRED_LENGTH_PRESETS, TIMEOUT_PRESETS, TITLE_EFFORT_LEVELS, parseConfig, type NamingConfig } from "./config.ts";
import { i18n } from "./i18n.ts";

/** 面板字段名；与配置里的字段一一对应，测试用它核对没有字段漏在面板外。 */
export const PANEL_FIELD = {
  automaticNaming: "automaticNaming",
  manualNaming: "manualNaming",
  sessionTarget: "targets.session",
  workspaceTarget: "targets.workspace",
  tabTarget: "targets.tab",
  maxLength: "title.maxLength",
  preferredLength: "title.preferredLength",
  language: "title.language",
  instructions: "title.instructions",
  timeoutMs: "title.timeoutMs",
  maxTokens: "title.maxTokens",
  effort: "title.effort",
} as const;

/** 面板字段名的联合类型。 */
export type PanelFieldId = (typeof PANEL_FIELD)[keyof typeof PANEL_FIELD];

/** 二级列表一项：label 是展示文本，value 是写回配置的值。 */
export interface PanelOption {
  /** 展示文本。 */
  label: string;
  /** 写回配置的值。 */
  value: string;
}

/** 面板一行：字段名、取值方式和文案 key。 */
interface PanelField {
  /** 字段名。 */
  id: PanelFieldId;
  /** `toggle` 原地切换，`choice` 回车开候选列表，`text` 回车开输入框。 */
  kind: "toggle" | "choice" | "text";
  /** 行标题的文案 key。 */
  labelKey: string;
  /** 说明行的文案 key。 */
  descriptionKey: string;
  /** 候选列表是否需要上方过滤输入框。 */
  search?: boolean;
}

/** 语言候选列表最多同时显示几行。 */
const CHOICE_MENU_MAX_VISIBLE = 8;

/** 开关两个状态在面板上承载的值，与本地化文案无关。 */
const TOGGLE_ON = "on";
const TOGGLE_OFF = "off";

/** 面板字段顺序：总开关在最前，其余按「命名目标 → 标题偏好」排列。 */
const PANEL_FIELDS: readonly PanelField[] = [
  { id: PANEL_FIELD.automaticNaming, kind: "toggle", labelKey: "panelLabelAutomaticNaming", descriptionKey: "panelDescAutomaticNaming" },
  { id: PANEL_FIELD.manualNaming, kind: "toggle", labelKey: "panelLabelManualNaming", descriptionKey: "panelDescManualNaming" },
  { id: PANEL_FIELD.sessionTarget, kind: "toggle", labelKey: "panelLabelSessionTarget", descriptionKey: "panelDescSessionTarget" },
  { id: PANEL_FIELD.workspaceTarget, kind: "toggle", labelKey: "panelLabelWorkspaceTarget", descriptionKey: "panelDescWorkspaceTarget" },
  { id: PANEL_FIELD.tabTarget, kind: "toggle", labelKey: "panelLabelTabTarget", descriptionKey: "panelDescTabTarget" },
  { id: PANEL_FIELD.maxLength, kind: "choice", labelKey: "panelLabelMaxLength", descriptionKey: "panelDescMaxLength" },
  { id: PANEL_FIELD.preferredLength, kind: "choice", labelKey: "panelLabelPreferredLength", descriptionKey: "panelDescPreferredLength" },
  { id: PANEL_FIELD.language, kind: "choice", labelKey: "panelLabelLanguage", descriptionKey: "panelDescLanguage" },
  { id: PANEL_FIELD.instructions, kind: "text", labelKey: "panelLabelInstructions", descriptionKey: "panelDescInstructions" },
  { id: PANEL_FIELD.timeoutMs, kind: "choice", labelKey: "panelLabelTimeout", descriptionKey: "panelDescTimeout" },
  { id: PANEL_FIELD.maxTokens, kind: "choice", labelKey: "panelLabelMaxTokens", descriptionKey: "panelDescMaxTokens" },
  { id: PANEL_FIELD.effort, kind: "choice", labelKey: "panelLabelEffort", descriptionKey: "panelDescEffort" },
];

/** 面板覆盖的字段名，测试用它证明配置里没有字段被漏下。 */
export const PANEL_FIELD_IDS: readonly string[] = PANEL_FIELDS.map((field) => field.id);

/** 取本地化的开关文案。 */
export function toggleLabels(): { on: string; off: string } {
  return { on: i18n.t("configOn"), off: i18n.t("configOff") };
}

/** 布尔字段的候选列表。 */
function toggleOptions(): PanelOption[] {
  const labels = toggleLabels();
  return [
    { label: labels.on, value: TOGGLE_ON },
    { label: labels.off, value: TOGGLE_OFF },
  ];
}

/** 数值字段的候选列表，labels 与值同文本。 */
function numberOptions(values: readonly string[]): PanelOption[] {
  return values.map((value) => ({ label: value, value }));
}

/** 思考档位的候选列表。 */
function effortOptions(): PanelOption[] {
  return numberOptions(TITLE_EFFORT_LEVELS);
}

/**
 * 语言字段的候选列表。
 *
 * 常见语言放在前面，当前值不在列表里时补进去：语言代码是自由字符串，用户可能填
 * 任意 BCP-47 代码，面板不能因为候选表里没有就把已存值显示成空白。
 */
function languageOptions(current: string): PanelOption[] {
  const values: string[] = [...LANGUAGE_PRESETS];
  if (!values.includes(current)) values.push(current);
  return numberOptions(values);
}

/** 按字段名取候选列表；文本字段没有候选。 */
function fieldOptions(id: PanelFieldId, config: NamingConfig): PanelOption[] {
  switch (id) {
    case PANEL_FIELD.automaticNaming:
    case PANEL_FIELD.manualNaming:
    case PANEL_FIELD.sessionTarget:
    case PANEL_FIELD.workspaceTarget:
    case PANEL_FIELD.tabTarget:
      return toggleOptions();
    case PANEL_FIELD.maxLength:
      return numberOptions(MAX_LENGTH_PRESETS);
    case PANEL_FIELD.preferredLength:
      return numberOptions(PREFERRED_LENGTH_PRESETS);
    case PANEL_FIELD.language:
      return languageOptions(config.title.language);
    case PANEL_FIELD.timeoutMs:
      return numberOptions(TIMEOUT_PRESETS);
    case PANEL_FIELD.maxTokens:
      return numberOptions(MAX_TOKENS_PRESETS);
    case PANEL_FIELD.effort:
      return effortOptions();
    default:
      return [];
  }
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

/** 读取一个字段当前存的值，统一转成面板上承载的字符串。 */
function readField(config: NamingConfig, id: PanelFieldId): string {
  switch (id) {
    case PANEL_FIELD.automaticNaming:
      return config.automaticNaming ? TOGGLE_ON : TOGGLE_OFF;
    case PANEL_FIELD.manualNaming:
      return config.manualNaming ? TOGGLE_ON : TOGGLE_OFF;
    case PANEL_FIELD.sessionTarget:
      return config.targets.session ? TOGGLE_ON : TOGGLE_OFF;
    case PANEL_FIELD.workspaceTarget:
      return config.targets.workspace ? TOGGLE_ON : TOGGLE_OFF;
    case PANEL_FIELD.tabTarget:
      return config.targets.tab ? TOGGLE_ON : TOGGLE_OFF;
    case PANEL_FIELD.maxLength:
      return String(config.title.maxLength);
    case PANEL_FIELD.preferredLength:
      return String(config.title.preferredLength);
    case PANEL_FIELD.language:
      return config.title.language;
    case PANEL_FIELD.instructions:
      return config.title.instructions;
    case PANEL_FIELD.timeoutMs:
      return String(config.title.timeoutMs);
    case PANEL_FIELD.maxTokens:
      return String(config.title.maxTokens);
    case PANEL_FIELD.effort:
      return config.title.effort;
  }
}

/** 用新值重建配置；文本字段原样写入，数值字段转成数字。 */
function writeField(config: NamingConfig, id: PanelFieldId, value: string): NamingConfig {
  const title = { ...config.title };
  switch (id) {
    case PANEL_FIELD.automaticNaming:
      return { ...config, automaticNaming: value === TOGGLE_ON };
    case PANEL_FIELD.manualNaming:
      return { ...config, manualNaming: value === TOGGLE_ON };
    case PANEL_FIELD.sessionTarget:
      return { ...config, targets: { ...config.targets, session: value === TOGGLE_ON } };
    case PANEL_FIELD.workspaceTarget:
      return { ...config, targets: { ...config.targets, workspace: value === TOGGLE_ON } };
    case PANEL_FIELD.tabTarget:
      return { ...config, targets: { ...config.targets, tab: value === TOGGLE_ON } };
    case PANEL_FIELD.maxLength:
      return { ...config, title: { ...title, maxLength: Number(value) } };
    case PANEL_FIELD.preferredLength:
      return { ...config, title: { ...title, preferredLength: Number(value) } };
    case PANEL_FIELD.language:
      return { ...config, title: { ...title, language: value } };
    case PANEL_FIELD.instructions:
      return { ...config, title: { ...title, instructions: value } };
    case PANEL_FIELD.timeoutMs:
      return { ...config, title: { ...title, timeoutMs: Number(value) } };
    case PANEL_FIELD.maxTokens:
      return { ...config, title: { ...title, maxTokens: Number(value) } };
    case PANEL_FIELD.effort:
      return { ...config, title: { ...title, effort: value as NamingConfig["title"]["effort"] } };
  }
}

/** 把候选列表转成 `SelectList` 的条目；展示文本同时是回传值。 */
function toSelectItems(options: readonly PanelOption[]): SelectItem[] {
  return options.map((option) => ({ value: option.label, label: option.label }));
}

/** 按展示文本建二级选择列表：Enter 选定并回传，Esc 不改动直接返回。 */
function createChoiceSubmenu(
  options: readonly PanelOption[],
  currentLabel: string,
  done: (selectedLabel?: string) => void,
): Component {
  const items = toSelectItems(options);
  const selectList = new SelectList(
    items,
    Math.max(1, Math.min(items.length, CHOICE_MENU_MAX_VISIBLE)),
    getSelectListTheme(),
  );
  const index = options.findIndex((option) => option.label === currentLabel);
  if (index >= 0) selectList.setSelectedIndex(index);
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(undefined);
  return selectList;
}

/** 自由文本二级菜单：预填当前值的 `Input`。 */
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
    /** 所有按键都归输入框。 */
    handleInput: (data) => input.handleInput(data),
  };
}

/** 把当前配置转成 Pi 设置列表的条目。 */
export function buildSettingItems(config: NamingConfig): SettingItem[] {
  return PANEL_FIELDS.map((field) => {
    const label = i18n.t(field.labelKey);
    const description = i18n.t(field.descriptionKey);
    const options = fieldOptions(field.id, config);
    const stored = readField(config, field.id);
    if (field.kind === "toggle") {
      return { id: field.id, label, description, currentValue: optionLabelForValue(options, stored), values: options.map((option) => option.label) };
    }
    if (field.kind === "choice") {
      return {
        id: field.id,
        label,
        description,
        currentValue: optionLabelForValue(options, stored),
        // 二级列表接管 Enter，避免在候选之间反复原地循环。
        submenu: (currentValue, done) => createChoiceSubmenu(options, currentValue, done),
      };
    }
    return {
      id: field.id,
      label,
      description,
      currentValue: stored || i18n.t("panelValueUnset"),
      submenu: (_currentValue, done) => createTextSubmenu(stored, description, done),
    };
  });
}

/**
 * 把面板返回的展示文本写回配置；无法识别时返回 undefined，由调用方保持不变。
 *
 * 结果统一过一遍 `parseConfig`，保证写盘的值仍在合法区间内（候选表与校验规则不会各走各的）。
 */
export function applyPanelChange(
  config: NamingConfig,
  id: string,
  value: string,
): NamingConfig | undefined {
  const field = PANEL_FIELDS.find((candidate) => candidate.id === id);
  if (!field) return undefined;
  if (field.kind === "text") {
    try {
      return parseConfig(writeField(config, field.id, value));
    } catch {
      return undefined;
    }
  }
  const stored = optionValueFromLabel(fieldOptions(field.id, config), value);
  if (stored === undefined) return undefined;
  try {
    return parseConfig(writeField(config, field.id, stored));
  } catch {
    return undefined;
  }
}

/** 面板与宿主之间的接口；配置读写与生效动作都由入口注入。 */
export interface ConfigPanelHandlers {
  /** 读取当前配置。 */
  getConfig(): NamingConfig;
  /** 某一项被改动后调用，由入口负责保存并同步运行期配置。 */
  onChange(config: NamingConfig): void;
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
      buildSettingItems(handlers.getConfig()),
      PANEL_FIELDS.length,
      getSettingsListTheme(),
      (id, newValue) => {
        const next = applyPanelChange(handlers.getConfig(), id, newValue);
        if (next) handlers.onChange(next);
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
