/**
 * 用户可见提示的统一呈现：把提示画成会话区里的「带底色消息块」，并标出来源扩展。
 *
 * 背景：Pi 的 ui.notify(info) 只是一行暗灰色文字（warning/error 才有黄色/红色前缀），
 * 各扩展全用 info 时用户在会话里既分不清来源，也分不清哪条是提示。
 *
 * 做法：提示改走 Pi 的自定义条目（appendEntry + registerEntryRenderer），
 * 渲染成和用户消息同款的实心底色块（主题色 customMessageBg），左侧标注来源扩展的短标签。
 * 这些条目不进入 LLM 上下文，只影响会话区外观。
 *
 * 本模块只用结构化类型，不直接依赖 Pi 的实现，便于独立测试。
 */
import { Box, Text, type Component } from "@earendil-works/pi-tui";

/** 允许使用的提示级别；同时是运行时校验的唯一真值来源。 */
const NOTICE_LEVELS = ["info", "warning", "error"] as const;

/** 提示级别，与 Pi 的 ui.notify 类型一致。 */
export type NoticeLevel = (typeof NOTICE_LEVELS)[number];

/** 允许使用的主题色名（Pi 主题色的子集）；同时是运行时校验的唯一真值来源。 */
const NOTICE_COLORS = [
  "accent",
  "success",
  "warning",
  "error",
  "muted",
  "dim",
  "text",
  "customMessageText",
  "toolTitle",
] as const;

/** 提示用到的主题色名。 */
export type NoticeColor = (typeof NOTICE_COLORS)[number];

/** 一个扩展的提示来源：短标签 + 固定颜色。 */
export interface NoticeSource {
  /** 展示在消息前的短标签，例如 "naming"。建议用包名去掉 pi- 前缀。 */
  tag: string;
  /** 该扩展的固定标签颜色，用来在会话里快速定位来源。 */
  color: NoticeColor;
}

/** 渲染提示所需的最小 UI 上下文。 */
export interface NoticeContext {
  /** 运行模式；只有 tui 会渲染成带底色的消息块。 */
  mode?: string;
  ui: {
    /** Pi 的提示出口；非 TUI 模式仍走这里。 */
    notify(message: string, type?: NoticeLevel): void;
    /** 主题；缺失时不加颜色。 */
    theme?: { fg(color: NoticeColor, text: string): string };
  };
}

/** 一次提示的渲染输入。 */
export interface NoticeRenderOptions {
  /** 来源标签与颜色。 */
  source: NoticeSource;
  /** 提示正文（已本地化）。 */
  message: string;
  /** 运行模式；非 tui 时输出纯文本。 */
  mode: string | undefined;
  /** 主题；缺失时输出纯文本。 */
  theme: NoticeContext["ui"]["theme"];
}

/** 一次带来源的提示调用。 */
export interface NoticeSendOptions {
  /** 目标 UI 上下文；运行模式与主题从它上面读取。 */
  ctx: NoticeContext;
  /** 来源标签与颜色。 */
  source: NoticeSource;
  /** 提示级别；决定正文颜色（warning 黄、error 红、info 用正文色）。 */
  level: NoticeLevel;
  /** 提示正文（已本地化）。 */
  message: string;
  /** 正文颜色覆盖；例如判定结论行自带语义色（dim/success）时用它。 */
  textColor?: NoticeColor;
}

/** 只有 TUI 模式能安全地看到 ANSI 颜色。 */
export const NOTICE_COLOR_MODE = "tui";

/** 提示条目的类型名；所有扩展共用一种，渲染器只需注册一次。 */
export const NOTICE_ENTRY_TYPE = "pi-extensions-notice";

/** 提示块的底色主题色：和 Pi 的扩展消息同款，视觉效果接近输入框。 */
export const NOTICE_BACKGROUND_COLOR = "customMessageBg";

/** 标签与消息之间的分隔符。 */
const TAG_SEPARATOR = " ";

/** 落进会话的提示条目数据；渲染器只依赖这些字段，重启后也能原样重建。 */
export interface NoticeEntryData {
  /** 来源短标签。 */
  tag: string;
  /** 标签颜色。 */
  color: NoticeColor;
  /** 提示级别；决定正文默认颜色。 */
  level: NoticeLevel;
  /** 提示正文。 */
  message: string;
  /** 正文颜色覆盖。 */
  textColor?: NoticeColor;
}

/** 渲染器拿到的主题：只需要前景色与底色。 */
export interface NoticeEntryTheme {
  /** 前景色。 */
  fg(color: NoticeColor, text: string): string;
  /** 底色。 */
  bg(color: typeof NOTICE_BACKGROUND_COLOR, text: string): string;
}

/** 提示渲染所需的 Pi 能力：写入自定义条目 + 注册条目渲染器。 */
export interface NoticeApi {
  /** 追加一条不进 LLM 上下文的自定义条目。 */
  appendEntry(customType: string, data?: unknown): void;
  /** 注册自定义条目的 TUI 渲染器。 */
  registerEntryRenderer(
    customType: string,
    renderer: (entry: { data?: unknown }, options: unknown, theme: NoticeEntryTheme) => Component,
  ): void;
}

/** 判断一个未知值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 运行时校验主题色名。 */
function isNoticeColor(value: unknown): value is NoticeColor {
  return typeof value === "string" && NOTICE_COLORS.some((color) => color === value);
}

/** 运行时校验提示级别。 */
function isNoticeLevel(value: unknown): value is NoticeLevel {
  return typeof value === "string" && NOTICE_LEVELS.some((level) => level === value);
}

/**
 * 当前会话的提示出口。
 *
 * 这是本模块唯一的可变状态，注入点是扩展入口的 installNoticeRenderer：
 * 提示调用点分散在 15 个包的几十处（含 tps、turn-elapsed 等拿不到 pi 的模块），
 * 逐个传参会把 Pi 的写入能力扩散到所有业务函数里，因此只在入口注入一次。
 * 扩展重载会重新执行入口，这里始终保存最近一次的 Pi 实例。
 */
let noticeApi: NoticeApi | undefined;

/**
 * 注入提示出口并注册条目渲染器。
 * 由 pi-extensions-i18n 的扩展入口调用；依赖它的扩展会自动带上这个入口。
 * 老版本 Pi 没有这两个能力时直接不注入，提示会退回 ui.notify（仍然可见，只是没有底色）。
 */
export function installNoticeRenderer(api: NoticeApi): void {
  if (typeof api.appendEntry !== "function" || typeof api.registerEntryRenderer !== "function") {
    return;
  }
  api.registerEntryRenderer(NOTICE_ENTRY_TYPE, (entry, _options, theme) =>
    renderNoticeEntry(entry, theme));
  noticeApi = api;
}

/** 当前是否已具备把提示画成带底色消息块的能力。 */
export function hasNoticeRenderer(): boolean {
  return noticeApi !== undefined;
}

/** 测试与重载用：清掉已注入的提示出口。 */
export function resetNoticeRenderer(): void {
  noticeApi = undefined;
}

/** 正文默认颜色：warning 黄、error 红、info 用扩展消息正文色。 */
export function noticeBodyColor(level: NoticeLevel, textColor?: NoticeColor): NoticeColor {
  if (textColor !== undefined) return textColor;
  if (level === "warning") return "warning";
  if (level === "error") return "error";
  return "customMessageText";
}

/**
 * 把未知的条目数据收敛成提示条目数据。
 * 逐字段运行时校验；缺失或类型不符时给出可读兜底，不信任外来数据。
 */
function readNoticeEntryData(input: unknown): NoticeEntryData {
  const raw = isRecord(input) && isRecord(input.data) ? input.data : {};
  const tag = typeof raw.tag === "string" && raw.tag !== "" ? raw.tag : "notice";
  const message = typeof raw.message === "string" ? raw.message : "";
  return {
    tag,
    color: isNoticeColor(raw.color) ? raw.color : "muted",
    level: isNoticeLevel(raw.level) ? raw.level : "info",
    message,
    textColor: isNoticeColor(raw.textColor) ? raw.textColor : undefined,
  };
}

/**
 * 把一个提示条目渲染成带底色的消息块。
 *
 * 这里直接构造 pi-tui 的 Box/Text：带底色消息块的排版（整块铺底色、按宽度换行）
 * 由 pi-tui 提供，Pi 自带的扩展消息渲染也是同样写法，属于有意为之的绑定。
 */
export function renderNoticeEntry(
  input: unknown,
  theme: NoticeEntryTheme,
): Component {
  const data = readNoticeEntryData(input);
  const label = theme.fg(data.color, `[${data.tag}]`);
  const body = theme.fg(noticeBodyColor(data.level, data.textColor), data.message);
  const box = new Box(1, 1, (text) => theme.bg(NOTICE_BACKGROUND_COLOR, text));
  box.addChild(new Text(`${label}${TAG_SEPARATOR}${body}`, 0, 0));
  return box;
}

/**
 * 给提示文本加上来源标签与颜色。
 * 非 TUI 模式或没有主题时返回纯文本，避免把 ANSI 序列转发给前端。
 */
export function formatNotice(options: NoticeRenderOptions): string {
  const { source, message, mode, theme } = options;
  const tag = `[${source.tag}]`;
  if (mode !== NOTICE_COLOR_MODE || theme === undefined) return `${tag}${TAG_SEPARATOR}${message}`;
  return `${theme.fg(source.color, tag)}${TAG_SEPARATOR}${message}`;
}

/**
 * 统一的提示出口。
 *
 * TUI：写一条自定义条目，由 registerEntryRenderer 画成带底色的消息块。
 * 其它模式（RPC/print/json）：仍走 ui.notify，行为与改造前一致。
 * 条目写入失败时退回 ui.notify，保证提示不会因为渲染方式而丢失。
 */
export function notifyWithSource(options: NoticeSendOptions): void {
  const { ctx, source, level, message, textColor } = options;
  if (ctx.mode === NOTICE_COLOR_MODE && noticeApi !== undefined) {
    const data: NoticeEntryData = {
      tag: source.tag,
      color: source.color,
      level,
      message,
      textColor,
    };
    try {
      noticeApi.appendEntry(NOTICE_ENTRY_TYPE, data);
      return;
    } catch {
      // 落到下面的 ui.notify：提示照常可见，只是没有底色。
    }
  }
  const text = formatNotice({ source, message, mode: ctx.mode, theme: ctx.ui.theme });
  ctx.ui.notify(text, level);
}
