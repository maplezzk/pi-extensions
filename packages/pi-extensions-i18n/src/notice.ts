/**
 * 用户可见提示的统一呈现：给每条提示加「来源标签」，并按级别上色。
 *
 * 背景：Pi 的 ui.notify 只有 info（暗灰、无前缀）/ warning（黄色 Warning:）/ error（红色 Error:）
 * 三种呈现，多数扩展全部用 info，用户在会话里无法分辨消息来自哪个扩展。
 * 这里给每个扩展一个固定短标签与固定颜色，让提示一眼可辨。
 *
 * 本模块不依赖 Pi 的具体实现，只用结构化类型，便于独立测试。
 */

/** 提示级别，与 Pi 的 ui.notify 类型一致。 */
export type NoticeLevel = "info" | "warning" | "error";

/** 主题色名；取值是 Pi 主题色的子集，避免依赖具体主题实现。 */
export type NoticeColor =
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "dim"
  | "text"
  | "toolTitle";

/** 一个扩展的提示来源：短标签 + 固定颜色。 */
export interface NoticeSource {
  /** 展示在消息前的短标签，例如 "naming"。建议用包名去掉 pi- 前缀。 */
  tag: string;
  /** 该扩展的固定标签颜色，用来在会话里快速定位来源。 */
  color: NoticeColor;
}

/** 渲染提示所需的最小 UI 上下文。 */
export interface NoticeContext {
  /** 运行模式；只有 tui 能安全地显示 ANSI 颜色。 */
  mode?: string;
  ui: {
    /** Pi 的提示出口。 */
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
  /** 提示级别；决定 Pi 侧的前缀与主色。 */
  level: NoticeLevel;
  /** 提示正文（已本地化）。 */
  message: string;
}

/** 只有 TUI 模式能安全地看到 ANSI 颜色。 */
export const NOTICE_COLOR_MODE = "tui";

/** 标签与消息之间的分隔符。 */
const TAG_SEPARATOR = " ";

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
 * 统一的提示出口：加来源标签后交给 Pi 的 notify。
 * 级别仍由调用方指定，保证 warning/error 依然带 Pi 自带的黄色/红色前缀。
 */
export function notifyWithSource(options: NoticeSendOptions): void {
  const { ctx, source, level, message } = options;
  const text = formatNotice({ source, message, mode: ctx.mode, theme: ctx.ui.theme });
  ctx.ui.notify(text, level);
}
