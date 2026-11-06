/**
 * pi-session-tools 的 TUI 配置面板。
 *
 * 原来 `/config:session-tools` 无参数时只弹一个阈值输入框，看不到强制压缩比例。
 * 这里改用 Pi 自带 `SettingsList`：左边字段名、右边当前值、选中项下方给一行说明。
 * 强制比例是枚举，Enter 打开二级列表；提醒阈值是自由文本，Enter 打开预填当前值的输入框。
 * 改一项立即写文件并同步运行期状态，Esc 关闭。
 */

import {
  type ExtensionCommandContext,
  getSelectListTheme,
  getSettingsListTheme,
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
import {
  formatThreshold,
  parseSquashThresholds,
  type SquashThreshold,
} from "./session-tail-compaction-utils.ts";
import { i18n } from "./i18n.ts";

/**
 * 面板上的配置形状，字段名与配置文件里的 JSON 键一一对应。
 *
 * 只包含本面板负责的两个字段；写入时由入口和配置文件的其余字段合并。
 */
export interface SessionToolsPanelConfig {
  /** 提醒阈值：解析后的结构化值。 */
  squashContextThresholds: SquashThreshold[];
  /** 强制压缩比例；null 表示关闭。 */
  forceSquashContextThreshold: number | null;
}

/** 字段名常量，面板行与 `applyPanelChange` 共用。 */
export const PANEL_FIELD = {
  thresholds: "squashContextThresholds",
  force: "forceSquashContextThreshold",
} as const;

/** 面板字段名的联合类型。 */
export type PanelFieldId = (typeof PANEL_FIELD)[keyof typeof PANEL_FIELD];

/** 面板覆盖的配置字段名，测试用它核对没有字段漏在面板外。 */
export const PANEL_FIELD_IDS: readonly string[] = [
  PANEL_FIELD.thresholds,
  PANEL_FIELD.force,
];

/** 强制比例关闭时面板上的取值。 */
export const FORCE_OFF_VALUE = "off";

/** 常见的强制压缩比例候选；越靠前越常用。 */
const FORCE_RATIO_VALUES: readonly number[] = [0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5];

/** 二级列表最多同时显示几行；超出的部分由 SelectList 滚动。 */
const CHOICE_MENU_MAX_VISIBLE = 8;

/** 一个候选项：label 是展示文本，value 是写回配置的值。 */
export interface PanelOption {
  /** 展示文本。 */
  label: string;
  /** 写回配置的值。 */
  value: string;
}

/** 一个面板行：叫什么、显示什么说明、怎么取值。 */
interface PanelField {
  /** 字段名。 */
  id: PanelFieldId;
  /** `choice` 回车开候选列表，`text` 回车开自由文本输入框。 */
  kind: "choice" | "text";
  /** 行标题的 i18n key。 */
  labelKey: string;
  /** 选中项说明行的 i18n key。 */
  descriptionKey: string;
}

/** 面板行顺序：影响更大的强制压缩在前。 */
const PANEL_FIELDS: readonly PanelField[] = [
  {
    id: PANEL_FIELD.force,
    kind: "choice",
    labelKey: "configLabelForce",
    descriptionKey: "configDescForce",
  },
  {
    id: PANEL_FIELD.thresholds,
    kind: "text",
    labelKey: "configLabelThresholds",
    descriptionKey: "configDescThresholds",
  },
];

/** 比例转百分比展示文本：0.9 → "90%"，0.75 → "75%"。 */
export function formatRatioLabel(ratio: number): string {
  const percent = ratio * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * 强制比例候选项：先「关闭强制」，再常见比例。
 *
 * 当前值不在候选里（例如用命令写入了 0.42）时把它补进去，
 * 否则面板会显示一个选不中的数字，回写也会被当成过期值拒绝。
 */
export function forceOptions(current: number | null): PanelOption[] {
  const options: PanelOption[] = [
    { label: i18n.t("configForceOff"), value: FORCE_OFF_VALUE },
  ];
  for (const ratio of FORCE_RATIO_VALUES) {
    options.push({ label: formatRatioLabel(ratio), value: String(ratio) });
  }
  if (current !== null && !options.some((option) => option.value === String(current))) {
    options.push({ label: formatRatioLabel(current), value: String(current) });
  }
  return options;
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

/** 阈值数组序列化成逗号分隔文本，与 `parseSquashThresholds` 可回环。 */
export function serializeThresholdText(thresholds: readonly SquashThreshold[]): string {
  return thresholds.map(formatThreshold).join(", ");
}

/** 解析逗号分隔的阈值文本；非法输入返回空数组。 */
export function parseThresholdText(text: string): SquashThreshold[] {
  return parseSquashThresholds(text.split(","));
}

/** 取某一行的当前显示值。 */
export function readField(config: SessionToolsPanelConfig, id: PanelFieldId): string {
  switch (id) {
    case PANEL_FIELD.thresholds:
      return serializeThresholdText(config.squashContextThresholds);
    case PANEL_FIELD.force:
      return optionLabelForValue(
        forceOptions(config.forceSquashContextThreshold),
        config.forceSquashContextThreshold === null
          ? FORCE_OFF_VALUE
          : String(config.forceSquashContextThreshold),
      );
  }
}

/** 把当前配置转成 Pi 设置列表的条目。 */
export function buildSettingItems(config: SessionToolsPanelConfig): SettingItem[] {
  return PANEL_FIELDS.map((field) => {
    const label = i18n.t(field.labelKey);
    const description = i18n.t(field.descriptionKey);
    if (field.kind === "choice") {
      const options = forceOptions(config.forceSquashContextThreshold);
      return {
        id: field.id,
        label,
        description,
        currentValue: readField(config, field.id),
        // 二级列表接管 Enter，避免在「关闭强制」和各个比例之间反复循环。
        submenu: (current: string, done) =>
          createChoiceSubmenu(options, current, done),
      };
    }
    // 阈值的当前值参与展示要带空格，但回填输入框时用紧凑写法，便于直接编辑。
    const compact = serializeThresholdText(config.squashContextThresholds).replace(/,\s+/g, ",");
    return {
      id: field.id,
      label,
      description,
      currentValue: readField(config, field.id),
      submenu: (_current: string, done) => createTextSubmenu(compact, description, done),
    };
  });
}

/**
 * 应用一次面板改动并返回新配置。
 *
 * 字段名不认识、强制比例不在候选里、或阈值文本解析不出有效值（空数组）时返回 undefined，
 * 这样过期的面板不会把没人提供过的值写进配置。
 */
export function applyPanelChange(
  config: SessionToolsPanelConfig,
  id: string,
  value: string,
): SessionToolsPanelConfig | undefined {
  if (id === PANEL_FIELD.force) {
    // SettingsList 回传的是展示文本，所以统一按候选表反查存值："关闭强制" → off，"90%" → 0.9。
    const stored = optionValueFromLabel(
      forceOptions(config.forceSquashContextThreshold),
      value,
    );
    if (stored === undefined) return undefined;
    if (stored === FORCE_OFF_VALUE) {
      return { ...config, forceSquashContextThreshold: null };
    }
    const ratio = Number(stored);
    if (!Number.isFinite(ratio)) return undefined;
    return { ...config, forceSquashContextThreshold: ratio };
  }
  if (id === PANEL_FIELD.thresholds) {
    const parsed = parseThresholdText(value);
    if (parsed.length === 0) return undefined;
    return { ...config, squashContextThresholds: parsed };
  }
  return undefined;
}

/** 二级选择列表：Enter 选定并回传展示文本，Esc 不改动直接返回。 */
function createChoiceSubmenu(
  options: readonly PanelOption[],
  currentLabel: string,
  done: (selectedLabel?: string) => void,
): Component {
  // 列表项的 value 与 label 取同一段文本：SettingsList 会把回传值直接显示在右侧，
  // 回传展示文本才能让百分比在选择后仍然可读。
  const items: SelectItem[] = options.map((option) => ({
    value: option.label,
    label: option.label,
  }));
  const selectList = new SelectList(
    items,
    Math.max(1, Math.min(items.length, CHOICE_MENU_MAX_VISIBLE)),
    getSelectListTheme(),
  );
  const currentIndex = options.findIndex(
    (option) => option.label === currentLabel || option.value === currentLabel,
  );
  if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(undefined);
  return selectList;
}

/** 自由文本子菜单：一个预填当前值的输入框。 */
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
    /** 一行可编辑文本。 */
    render: (width) => input.render(width),
    /** 输入框没有共享缓存。 */
    invalidate: () => input.invalidate(),
    /** 所有按键都给输入框。 */
    handleInput: (data) => input.handleInput(data),
  };
}

/** 面板与宿主之间的接口；配置读取与生效动作都由入口注入。 */
export interface ConfigPanelHandlers {
  /** 读取当前配置。 */
  getConfig(): SessionToolsPanelConfig;
  /** 某一项被改动后调用，由入口负责保存并同步运行期状态。 */
  onChange(config: SessionToolsPanelConfig): void;
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
