/**
 * 折叠头的视觉样式。
 *
 * 折叠头不能和正文长一个样：正文是流式叙述，折叠头是能被点开的结构行。三级用
 * 同一套语言区分，一眼就能看出谁收着、谁展开着：
 *
 * - 运行级折叠头：整行铺满底色的横条（band）——「这里收了一整轮」；
 * - 动作组头：只包住文字的小标签（chip）——比横条轻，和展开后的工具行同色系；
 * - 正文与工具行：不套底色，保持 Pi 原本的样子。
 *
 * 主题缺色时对应能力退化成原样文本：宁可少一层装饰，也不能因为主题少一个键
 * 把整块渲染打断。缺色只在构造时探测一次，渲染路径上没有 try/catch。
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

/** 运行级折叠头的底色键：Pi 用它画扩展消息块，视觉上「一条横带」。 */
const COLOR_BAND = "customMessageBg";
/** 动作组头的底色键：与展开后的工具行同色系，视觉上「一枚标签」。 */
const COLOR_CHIP = "toolPendingBg";
/** 强调色：箭头等可点击提示。 */
const COLOR_ACCENT = "accent";
/** 主文字色：折叠头的主体信息。 */
const COLOR_PRIMARY = "text";
/** 弱化色：次要信息与右侧提示。 */
const COLOR_MUTED = "muted";
/** 横条宽度下限：宽度为 0 时不能去截断，直接给空行。 */
const MIN_BAND_WIDTH = 0;
/** 横条被截断时的省略号。 */
const BAND_ELLIPSIS = "…";

/**
 * 着色用到的主题能力。
 *
 * 结构上对应 Pi 的 Theme，但只声明这里真正用到的三个方法，测试不必伪造整个主题。
 */
export interface ThemePainter {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/** 折叠头的着色能力；主题缺色时对应方法退化成原样文本。 */
export interface HeaderStyler {
	/** 强调：箭头、可点击提示。 */
	accent(text: string): string;
	/** 主体信息（例如「用时 21s」）。 */
	primary(text: string): string;
	/** 次要信息与右侧快捷键提示。 */
	muted(text: string): string;
	/** 铺满整行宽度的底色横条；宽度不够时截断，不会撑破布局。 */
	band(text: string, width: number): string;
	/** 只包住文字本身的底色标签。 */
	chip(text: string): string;
}

/**
 * 探测前景色是否可用。
 *
 * `theme.fg` 对主题里不存在的颜色键会抛，所以只能真的调一次：用空白字符试色，
 * 抛了就当这个主题没有这个键。
 */
function probeForeground(
	theme: ThemePainter,
	color: string,
): ((text: string) => string) | undefined {
	try {
		theme.fg(color, " ");
	} catch {
		return undefined;
	}
	return (text) => theme.fg(color, text);
}

/** 探测背景色是否可用；语义同前，探测失败时返回 undefined。 */
function probeBackground(
	theme: ThemePainter,
	color: string,
): ((text: string) => string) | undefined {
	try {
		theme.bg(color, " ");
	} catch {
		return undefined;
	}
	return (text) => theme.bg(color, text);
}

/** 原样返回文本；缺色时用它兜底。 */
function identity(text: string): string {
	return text;
}

/** 按宽度截断（ANSI 安全）并补齐到整宽。 */
function padToWidth(text: string, width: number): string {
	return truncateToWidth(text, Math.max(MIN_BAND_WIDTH, width), BAND_ELLIPSIS, true);
}

/**
 * 从 Pi 主题造折叠头着色器。
 *
 * 主题缺哪个键，就只少那一层装饰，其余照常；不会因为一个键缺失整行渲染失败。
 */
export function createHeaderStyler(theme: ThemePainter): HeaderStyler {
	const accent = probeForeground(theme, COLOR_ACCENT) ?? identity;
	const primary = probeForeground(theme, COLOR_PRIMARY) ?? identity;
	const muted = probeForeground(theme, COLOR_MUTED) ?? identity;
	const bandPaint = probeBackground(theme, COLOR_BAND);
	const chipPaint = probeBackground(theme, COLOR_CHIP);

	return {
		accent,
		primary,
		muted,
		/** 按宽度截断（ANSI 安全）并补齐到整宽，再压底色。 */
		band: (text, width) => {
			const line = padToWidth(text, width);
			return bandPaint ? bandPaint(line) : line;
		},
		/** 把一段文字包成带左右空格的标签并压底色；无底色时至少保留两侧空格。 */
		chip: (text) => {
			const label = ` ${text} `;
			return chipPaint ? chipPaint(label) : label;
		},
	};
}
