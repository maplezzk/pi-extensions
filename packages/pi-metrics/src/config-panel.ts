/**
 * pi-metrics 的 TUI 配置面板。
 *
 * 原来用 `ctx.ui.select` 链式菜单：每选一项都要重新弹一轮菜单，屏幕上既看不出哪个是
 * 状态、哪个是按钮。这里改用 Pi 自带 `SettingsList`：左边字段名、右边当前值，选中项
 * 下方给一行说明。开关回车原地切换，枚举回车打开二级列表。
 *
 * 改动即时生效：面板每次读配置都走 `getConfig()`（入口注入的读取函数），写完由入口
 * 保存并立刻按新配置重装指标处理器，关掉面板不用 /reload。
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
import { parseConfig, type MetricsConfig, type MetricsDisplay } from "./config.ts";
import { i18n } from "./i18n.ts";

/** 面板上的一项取值方式：开关原地切换，枚举回车开二级列表。 */
const PANEL_KIND = {
  /** 开关：Enter/空格在开与关之间切换。 */
  toggle: "toggle",
  /** 枚举：Enter 打开二级选择列表。 */
  choice: "choice",
} as const;

/** 面板项定义。 */
interface PanelItemSpec {
  /** 配置字段名。 */
  id: PanelFieldId;
  /** 取值方式。 */
  kind: (typeof PANEL_KIND)[keyof typeof PANEL_KIND];
  /** 行标题的文案 key。 */
  labelKey: string;
  /** 说明行的文案 key。 */
  descriptionKey: string;
}

/** 面板覆盖的配置字段名。 */
export type PanelFieldId = "enabled" | "display";

/** 显示时机的候选值。 */
const DISPLAY_VALUES: readonly MetricsDisplay[] = ["on-stop", "live"];

/** 显示时机取值到文案 key 的映射。 */
const DISPLAY_LABEL_KEYS: Record<MetricsDisplay, string> = {
  "on-stop": "configDisplayOnStop",
  live: "configDisplayLive",
};

/** 二级列表最多同时显示几行。 */
const CHOICE_MENU_MAX_VISIBLE = 8;

/** 配置里存的开关值，避免把本地化文案写回配置。 */
const TOGGLE_ON = "on";
const TOGGLE_OFF = "off";

/** 面板项顺序：先总开关，再显示时机。 */
const PANEL_ITEMS: readonly PanelItemSpec[] = [
  {
    id: "enabled",
    kind: PANEL_KIND.toggle,
    labelKey: "configLabelEnabled",
    descriptionKey: "configDescEnabled",
  },
  {
    id: "display",
    kind: PANEL_KIND.choice,
    labelKey: "configLabelDisplay",
    descriptionKey: "configDescDisplay",
  },
];

/** 面板覆盖的配置字段名，测试用它核对没有字段漏在面板外。 */
export const CONFIG_PANEL_IDS: readonly string[] = PANEL_ITEMS.map((item) => item.id);

/** 二级列表的一项：label 是展示文本，value 是写回配置的值。 */
export interface PanelOption {
  /** 展示文本。 */
  label: string;
  /** 写回配置的值。 */
  value: string;
}

/** 取本地化后的开关文案。 */
function toggleLabels(): { on: string; off: string } {
  return { on: i18n.t("configOn"), off: i18n.t("configOff") };
}

/** 开关的候选项。 */
function toggleOptions(): PanelOption[] {
  const labels = toggleLabels();
  return [
    { label: labels.on, value: TOGGLE_ON },
    { label: labels.off, value: TOGGLE_OFF },
  ];
}

/** 显示时机的候选项。 */
function displayOptions(): PanelOption[] {
  return DISPLAY_VALUES.map((value) => ({ label: i18n.t(DISPLAY_LABEL_KEYS[value]), value }));
}

/** 按字段取候选项。 */
function fieldOptions(id: PanelFieldId): PanelOption[] {
  return id === "enabled" ? toggleOptions() : displayOptions();
}

/** 按配置值取展示文本；不在候选表里就直接显示原值。 */
export function optionLabelForValue(options: readonly PanelOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** 按展示文本反查写回值；找不到说明候选表变了，返回 undefined。 */
export function optionValueFromLabel(
  options: readonly PanelOption[],
  label: string,
): string | undefined {
  return options.find((option) => option.label === label)?.value;
}

/**
 * 二级选择列表：Enter 选定并回传展示文本，Esc 不改动直接返回。
 *
 * 列表项的 value 与 label 取同一段文本：SettingsList 会把回传值直接显示在右侧，
 * 回传展示文本才能让「每轮实时一行」这类文案在选中后仍然可读。
 */
function createChoiceSubmenu(
  options: readonly PanelOption[],
  currentLabel: string,
  done: (selectedLabel?: string) => void,
): Component {
  /** 建一份列表快照，能对上当前值就预选中它。 */
  const buildList = (list: readonly PanelOption[]): SelectList => {
    const items: SelectItem[] = list.map((option) => ({ value: option.label, label: option.label }));
    const selectList = new SelectList(
      items,
      Math.max(1, Math.min(items.length, CHOICE_MENU_MAX_VISIBLE)),
      getSelectListTheme(),
    );
    const currentIndex = list.findIndex((option) => option.label === currentLabel);
    if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(undefined);
    return selectList;
  };
  return buildList(options);
}

/** 把当前配置转成 Pi 设置列表的条目。 */
export function toSettingItems(config: MetricsConfig): SettingItem[] {
  const labels = toggleLabels();
  return PANEL_ITEMS.map((item) => {
    const label = i18n.t(item.labelKey);
    const description = i18n.t(item.descriptionKey);
    const options = fieldOptions(item.id);
    if (item.kind === PANEL_KIND.toggle) {
      return {
        id: item.id,
        label,
        description,
        currentValue: config.enabled ? labels.on : labels.off,
        values: [labels.on, labels.off],
      };
    }
    return {
      id: item.id,
      label,
      description,
      currentValue: optionLabelForValue(options, config.display),
      // 二级列表接管 Enter，避免在枚举值之间反复循环而不显示候选。
      submenu: (currentLabel: string, done) => createChoiceSubmenu(options, currentLabel, done),
    };
  });
}

/**
 * 把面板返回的展示文本写回配置；无法识别时返回 undefined，由调用方保持不变。
 *
 * 结果统一过一遍 parseConfig，保证写盘的值仍在校验规则允许的范围内。
 */
export function applyPanelChange(
  config: MetricsConfig,
  id: string,
  value: string,
): MetricsConfig | undefined {
  if (id === "enabled") {
    const labels = toggleLabels();
    if (value !== labels.on && value !== labels.off) return undefined;
    return parseConfig({ ...config, enabled: value === labels.on });
  }
  if (id === "display") {
    const stored = optionValueFromLabel(displayOptions(), value);
    return stored === undefined ? undefined : parseConfig({ ...config, display: stored });
  }
  return undefined;
}

/** 面板与宿主之间的接口；配置读写与实时生效都由入口注入。 */
export interface ConfigPanelHandlers {
  /** 读取当前配置。 */
  getConfig(): MetricsConfig;
  /** 某一项被改动后调用，由入口负责保存并按新配置重装指标处理器。 */
  onChange(config: MetricsConfig): void;
}

/** 打开配置面板；改动即时生效，Esc 关闭。 */
export async function openConfigPanel(
  ctx: ExtensionCommandContext,
  handlers: ConfigPanelHandlers,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(i18n.t("configMenuTitle"))), 1, 1));

    const settingsList = new SettingsList(
      toSettingItems(handlers.getConfig()),
      PANEL_ITEMS.length,
      getSettingsListTheme(),
      (id, newValue) => {
        const next = applyPanelChange(handlers.getConfig(), id, newValue);
        if (next) handlers.onChange(next);
      },
      () => done(undefined),
    );
    container.addChild(settingsList);

    // ctx.ui.custom 要求返回 Component：布局交给 Container，键盘转给设置列表，
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
