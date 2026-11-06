/**
 * pi-notifications 的 TUI 配置面板。
 *
 * 原来用 `ctx.ui.select` 开菜单，一行文字里既放当前值又放动作，看不出哪项是状态。
 * 这里改用 Pi 自带 `SettingsList`：左边字段名、右边当前值、选中项下方给一行说明；
 * 布尔项回车原地切换，枚举项回车打开二级列表，自由文本与参数数组回车打开预填输入框。
 * 改一项就立刻写盘并同步运行期配置，Esc 关闭面板即可生效，不需要 /reload。
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
import { parseConfig, type NotificationConfig } from "./config.ts";
import { i18n } from "./i18n.ts";

/** 面板字段名，同时用作 `SettingsList` 的行 id 与配置命令的参数名。 */
export const PANEL_FIELD = {
  enabled: "enabled",
  command: "adapter.command",
  args: "adapter.args",
  timeoutMs: "timeoutMs",
} as const;

/** 面板字段名的联合类型。 */
export type PanelFieldId = (typeof PANEL_FIELD)[keyof typeof PANEL_FIELD];

/** 面板覆盖的配置字段名，测试用它核对没有字段漏在面板外。 */
export const PANEL_FIELD_IDS: readonly string[] = [
  PANEL_FIELD.enabled,
  PANEL_FIELD.command,
  PANEL_FIELD.args,
  PANEL_FIELD.timeoutMs,
];

/** 超时候选值，覆盖常用档位；要填别的值就在输入框里改。 */
const TIMEOUT_VALUES: readonly number[] = [1000, 3000, 5000, 10000, 30000];

/** 二级列表最多同时显示几行，超出的部分由 SelectList 滚动。 */
const CHOICE_MENU_MAX_VISIBLE = 8;

/** 参数数组在面板上的一行文本：逗号加空格分隔，与命令行输入保持一致。 */
const ARG_DISPLAY_SEPARATOR = ", ";

/** 参数数组在输入框里按逗号切分。 */
const ARG_INPUT_SEPARATOR = ",";

/** 布尔字段在面板上显示的两个文案。 */
const TOGGLE_ON = "on";
const TOGGLE_OFF = "off";

/** 二级列表的一项：label 是展示文本，value 是写回配置的值。 */
export interface PanelOption {
  /** 展示文本。 */
  label: string;
  /** 写回配置的值。 */
  value: string;
}

/** 开关在面板上显示的两个本地化文案。 */
function toggleLabels(): { on: string; off: string } {
  return { on: i18n.t("configOn"), off: i18n.t("configOff") };
}

/** 开关候选项：值为内部标记，展示文本才走本地化。 */
function toggleOptions(): PanelOption[] {
  const labels = toggleLabels();
  return [
    { label: labels.on, value: TOGGLE_ON },
    { label: labels.off, value: TOGGLE_OFF },
  ];
}

/** 超时候选项；`SettingsList` 的取值一律以字符串携带。 */
function timeoutOptions(): PanelOption[] {
  return TIMEOUT_VALUES.map((value) => ({ label: String(value), value: String(value) }));
}

/** 面板项：每种取值方式对应不同的字段类型。 */
interface PanelFieldSpec {
  /** 字段名。 */
  id: PanelFieldId;
  /** `toggle` 原地切换，`choice` 开二级列表，`text` 开预填输入框。 */
  kind: "toggle" | "choice" | "text";
  /** 字段标签的本地化 key。 */
  labelKey: string;
  /** 说明行的本地化 key。 */
  descriptionKey: string;
}

/** 面板顺序：总开关最前，命令次之，参数与超时随后。 */
const PANEL_FIELDS: readonly PanelFieldSpec[] = [
  { id: PANEL_FIELD.enabled, kind: "toggle", labelKey: "configLabelEnabled", descriptionKey: "configDescEnabled" },
  { id: PANEL_FIELD.command, kind: "text", labelKey: "configLabelCommand", descriptionKey: "configDescCommand" },
  { id: PANEL_FIELD.args, kind: "text", labelKey: "configLabelArgs", descriptionKey: "configDescArgs" },
  { id: PANEL_FIELD.timeoutMs, kind: "choice", labelKey: "configLabelTimeout", descriptionKey: "configDescTimeout" },
];

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

/** 参数数组转面板上的一行文本。 */
export function argsToText(args: readonly string[]): string {
  return args.join(ARG_DISPLAY_SEPARATOR);
}

/** 面板上的一行文本转参数数组：按逗号切分、去空白、丢掉空项。 */
export function textToArgs(text: string): string[] {
  return text
    .split(ARG_INPUT_SEPARATOR)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

/** 当前配置里某个字段的取值，统一以字符串携带。 */
function readField(config: NotificationConfig, id: PanelFieldId): string {
  switch (id) {
    case PANEL_FIELD.enabled:
      return config.enabled ? TOGGLE_ON : TOGGLE_OFF;
    case PANEL_FIELD.command:
      return config.adapter.command;
    case PANEL_FIELD.args:
      return argsToText(config.adapter.args);
    case PANEL_FIELD.timeoutMs:
      return String(config.timeoutMs);
  }
}

/** 某字段的候选项；文本字段没有候选表。 */
function fieldOptions(id: PanelFieldId): PanelOption[] {
  switch (id) {
    case PANEL_FIELD.enabled:
      return toggleOptions();
    case PANEL_FIELD.timeoutMs:
      return timeoutOptions();
    default:
      return [];
  }
}

/** 把候选表转成 `SelectList` 的条目；列表回传展示文本，右侧显示才可读。 */
function toSelectItems(options: readonly PanelOption[]): SelectItem[] {
  return options.map((option) => ({ value: option.label, label: option.label }));
}

/** 二级选择列表：Enter 选定并回传展示文本，Esc 不改动直接返回。 */
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
  const currentIndex = options.findIndex((option) => option.label === currentLabel);
  if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(undefined);
  return selectList;
}

/** 自由文本二级菜单：输入框预填当前值，Enter 提交、Esc 取消。 */
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
    /** 一行可编辑输入。 */
    render: (width) => input.render(width),
    /** 输入框没有共享缓存。 */
    invalidate: () => input.invalidate(),
    /** 所有按键都归输入框。 */
    handleInput: (data) => input.handleInput(data),
  };
}

/** 把当前配置转成 Pi 设置列表的条目。 */
export function buildSettingItems(config: NotificationConfig): SettingItem[] {
  return PANEL_FIELDS.map((field) => {
    const label = i18n.t(field.labelKey);
    const description = i18n.t(field.descriptionKey);
    const stored = readField(config, field.id);

    if (field.kind === "toggle") {
      const options = fieldOptions(field.id);
      return {
        id: field.id,
        label,
        description,
        currentValue: optionLabelForValue(options, stored),
        values: options.map((option) => option.label),
      };
    }
    if (field.kind === "choice") {
      const options = fieldOptions(field.id);
      return {
        id: field.id,
        label,
        description,
        currentValue: optionLabelForValue(options, stored),
        submenu: (currentLabel, done) => createChoiceSubmenu(options, currentLabel, done),
      };
    }
    return {
      id: field.id,
      label,
      description,
      currentValue: stored || i18n.t("configValueUnset"),
      submenu: (_currentLabel, done) => createTextSubmenu(stored, description, done),
    };
  });
}

/**
 * 把面板返回的展示文本写回配置；无法识别时返回 undefined，由调用方保持不变。
 *
 * 结果统一过一遍 parseConfig，保证写盘的值仍满足现有校验规则，面板与校验不会各走各的。
 */
export function applyPanelChange(
  config: NotificationConfig,
  id: string,
  value: string,
): NotificationConfig | undefined {
  const field = PANEL_FIELDS.find((candidate) => candidate.id === id);
  if (!field) return undefined;

  try {
    if (field.kind === "text") {
      if (field.id === PANEL_FIELD.command) {
        return parseConfig({ ...config, adapter: { ...config.adapter, command: value.trim() } });
      }
      return parseConfig({ ...config, adapter: { ...config.adapter, args: textToArgs(value) } });
    }

    const stored = optionValueFromLabel(fieldOptions(field.id), value);
    if (stored === undefined) return undefined;
    if (field.id === PANEL_FIELD.enabled) {
      return parseConfig({ ...config, enabled: stored === TOGGLE_ON });
    }
    return parseConfig({ ...config, timeoutMs: Number(stored) });
  } catch {
    // 输入非法（例如空命令、非正数超时）时保持原值，面板不写入坏配置。
    return undefined;
  }
}

/** 面板与宿主之间的接口；配置读写与生效动作都由入口注入。 */
export interface ConfigPanelHandlers {
  /** 读取当前配置。 */
  getConfig(): NotificationConfig;
  /** 某一项被改动后调用，由入口负责保存、同步运行期配置并重绘。 */
  onChange(config: NotificationConfig): void;
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
