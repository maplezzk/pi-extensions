/**
 * pi-nested-skills 的 TUI 配置面板。
 *
 * 原来用一次 `ctx.ui.input` 让用户手输根目录，看不到当前值也看不出哪项能改。
 * 这里改用 Pi 自带 `SettingsList`：左边字段名、右边当前值、选中项下方给一行说明；
 * 技能根目录是字符串数组，面板上以逗号分隔显示为一行，回车打开预填输入框编辑整串，
 * 提交后按逗号切分回数组。改一项立刻写盘并同步运行期配置，Esc 关闭即可生效。
 */

import {
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  SettingsList,
  Text,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { parseConfig, type NestedSkillsConfig } from "./config.ts";
import { i18n } from "./i18n.ts";

/** 面板字段名，同时用作 `SettingsList` 的行 id。 */
export const PANEL_FIELD = {
  skillRoots: "skillRoots",
} as const;

/** 面板字段名的联合类型。 */
export type PanelFieldId = (typeof PANEL_FIELD)[keyof typeof PANEL_FIELD];

/** 面板覆盖的配置字段名，测试用它核对没有字段漏在面板外。 */
export const PANEL_FIELD_IDS: readonly string[] = [PANEL_FIELD.skillRoots];

/** 根目录数组在面板上的一行文本：逗号加空格分隔，与命令行输入保持一致。 */
const ROOT_DISPLAY_SEPARATOR = ", ";

/** 根目录数组在输入框里按逗号切分。 */
const ROOT_INPUT_SEPARATOR = ",";

/** 面板项：目前只有字符串数组一种取值方式。 */
interface PanelFieldSpec {
  /** 字段名。 */
  id: PanelFieldId;
  /** 字段标签的本地化 key。 */
  labelKey: string;
  /** 说明行的本地化 key。 */
  descriptionKey: string;
}

/** 面板顺序。 */
const PANEL_FIELDS: readonly PanelFieldSpec[] = [
  { id: PANEL_FIELD.skillRoots, labelKey: "configLabelSkillRoots", descriptionKey: "configDescSkillRoots" },
];

/** 根目录数组转面板上的一行文本。 */
export function rootsToText(roots: readonly string[]): string {
  return roots.join(ROOT_DISPLAY_SEPARATOR);
}

/** 面板上的一行文本转根目录数组：按逗号切分、去空白、丢掉空项。 */
export function textToRoots(text: string): string[] {
  return text
    .split(ROOT_INPUT_SEPARATOR)
    .map((root) => root.trim())
    .filter(Boolean);
}

/** 当前配置里某个字段的取值。 */
function readField(config: NestedSkillsConfig, id: PanelFieldId): string {
  switch (id) {
    case PANEL_FIELD.skillRoots:
      return rootsToText(config.skillRoots);
  }
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
export function buildSettingItems(config: NestedSkillsConfig): SettingItem[] {
  return PANEL_FIELDS.map((field) => {
    const label = i18n.t(field.labelKey);
    const description = i18n.t(field.descriptionKey);
    const stored = readField(config, field.id);
    return {
      id: field.id,
      label,
      description,
      currentValue: stored || i18n.t("configValueUnset"),
      // SettingsList 的 submenu 用 done 回传输入；这里编辑整串再切分回数组。
      submenu: (_currentLabel, done) => createTextSubmenu(stored, description, done),
    };
  });
}

/**
 * 把面板返回的文本写回配置；无法识别时返回 undefined，由调用方保持不变。
 *
 * 结果统一过一遍 parseConfig，写盘的值仍满足现有校验规则（只能是字符串数组），
 * 面板与校验不会各走各的。空输入得到空数组，面板显示为「未设置」。
 */
export function applyPanelChange(
  config: NestedSkillsConfig,
  id: string,
  value: string,
): NestedSkillsConfig | undefined {
  const field = PANEL_FIELDS.find((candidate) => candidate.id === id);
  if (!field) return undefined;
  try {
    return parseConfig({ skillRoots: textToRoots(value) });
  } catch {
    // 输入格式非法时保持原值，面板不写入坏配置。
    return undefined;
  }
}

/** 面板与宿主之间的接口；配置读写与生效动作都由入口注入。 */
export interface ConfigPanelHandlers {
  /** 读取当前配置。 */
  getConfig(): NestedSkillsConfig;
  /** 某一项被改动后调用，由入口负责保存、同步运行期配置并重绘。 */
  onChange(config: NestedSkillsConfig): void;
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
