/**
 * pi-session-resources 的 TUI 配置面板。
 *
 * 原来只能靠 `/config:session-resources enable|disable` 改配置，屏幕上看不到当前值。
 * 这里改用 Pi 自带 `SettingsList`：左边字段名、右边当前值、选中项下方给一行说明，
 * 布尔项 Enter/空格原地切换。改一项立即写文件并同步运行期开关，Esc 关闭。
 */

import {
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SettingsList,
  Text,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { SessionResourcesConfig } from "./config.ts";
import { i18n } from "./i18n.ts";

/** 面板上可编辑的字段名，与配置结构一一对应。 */
export const PANEL_FIELD = {
  enabled: "enabled",
} as const;

/** 面板字段名的联合类型。 */
export type PanelFieldId = (typeof PANEL_FIELD)[keyof typeof PANEL_FIELD];

/** 一个面板字段：叫什么、显示什么说明；目前只有一个布尔开关。 */
interface PanelField {
  /** 字段名。 */
  id: PanelFieldId;
  /** 行标题的 i18n key。 */
  labelKey: string;
  /** 选中项说明行的 i18n key。 */
  descriptionKey: string;
}

/** 面板字段顺序：总开关在前。 */
const PANEL_FIELDS: readonly PanelField[] = [
  {
    id: PANEL_FIELD.enabled,
    labelKey: "configLabelEnabled",
    descriptionKey: "configDescEnabled",
  },
];

/** 面板覆盖的字段名，测试用它核对没有字段漏在面板外。 */
export const PANEL_FIELD_IDS: readonly string[] = PANEL_FIELDS.map((field) => field.id);

/** 取本地化后的开关文案，配置里永远不存本地化文本。 */
export function panelToggleLabels(): { on: string; off: string } {
  return { on: i18n.t("configOn"), off: i18n.t("configOff") };
}

/** 布尔值转成面板显示文本。 */
function toggleLabel(value: boolean): string {
  const labels = panelToggleLabels();
  return value ? labels.on : labels.off;
}

/** 面板显示文本换算回布尔值；未知文本返回 undefined，表示放弃这次改动。 */
function toggleValueFromLabel(value: string): boolean | undefined {
  const labels = panelToggleLabels();
  if (value === labels.on) return true;
  if (value === labels.off) return false;
  return undefined;
}

/** 当前配置在面板上的取值；开关统一走布尔换算。 */
function readField(config: SessionResourcesConfig, id: PanelFieldId): string {
  switch (id) {
    case PANEL_FIELD.enabled:
      return toggleLabel(config.enabled);
  }
}

/** 把某个字段的新值写回配置；未知字段原样返回。 */
function writeField(
  config: SessionResourcesConfig,
  id: PanelFieldId,
  value: string,
): SessionResourcesConfig {
  switch (id) {
    case PANEL_FIELD.enabled:
      return { ...config, enabled: toggleValueFromLabel(value) ?? config.enabled };
  }
}

/** 把当前配置转成 Pi 设置列表的条目。 */
export function buildSettingItems(config: SessionResourcesConfig): SettingItem[] {
  const labels = panelToggleLabels();
  return PANEL_FIELDS.map((field) => ({
    id: field.id,
    label: i18n.t(field.labelKey),
    description: i18n.t(field.descriptionKey),
    currentValue: readField(config, field.id),
    // 只有开关：Enter/空格在原地切换，不必再开二级列表。
    values: [labels.on, labels.off],
  }));
}

/**
 * 应用一次面板改动并返回新配置。
 *
 * 字段名不认识、或传回来的文本不在候选里时返回 undefined，
 * 这样过期的面板不会把没人提供过的值写进配置。
 */
export function applyPanelChange(
  config: SessionResourcesConfig,
  id: string,
  value: string,
): SessionResourcesConfig | undefined {
  const field = PANEL_FIELDS.find((candidate) => candidate.id === id);
  if (!field) return undefined;
  if (toggleValueFromLabel(value) === undefined) return undefined;
  return writeField(config, field.id, value);
}

/** 面板与宿主之间的接口；配置读写与生效动作都由入口注入。 */
export interface ConfigPanelHandlers {
  /** 读取当前配置。 */
  getConfig(): SessionResourcesConfig;
  /** 某一项被改动后调用，由入口负责保存并同步运行期开关。 */
  onChange(config: SessionResourcesConfig): void;
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
