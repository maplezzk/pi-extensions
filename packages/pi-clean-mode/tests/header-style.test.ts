import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createHeaderStyler, type ThemePainter } from "../src/header-style.ts";

/** 伪造的前景色码前缀，用来断言「确实套了这一层色」。 */
const FG_PREFIX = "\x1b[38;5;99m";
/** 伪造的背景色码前缀。 */
const BG_PREFIX = "\x1b[48;5;99m";

/** 造一个会产生真 ANSI 码的主题替身：visibleWidth 这类工具才能正确计算宽度。 */
function ansiTheme(): ThemePainter {
	return {
		fg: (_color, text) => `${FG_PREFIX}${text}\x1b[39m`,
		bg: (_color, text) => `${BG_PREFIX}${text}\x1b[49m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
}

/** 造一个缺色的主题替身：模拟主题里没有这些颜色键（Pi 的 theme.fg/bg 会抛）。 */
function missingColorTheme(): ThemePainter {
	return {
		fg: () => {
			throw new Error("Unknown theme color");
		},
		bg: () => {
			throw new Error("Unknown theme background color");
		},
		bold: (text) => text,
	};
}

test("横条铺满整行宽度并压上底色", () => {
	const styler = createHeaderStyler(ansiTheme());
	const line = styler.band("用时 21s", 20);

	assert.equal(visibleWidth(line), 20, "横条宽度应与给定宽度一致");
	assert.ok(line.startsWith(BG_PREFIX), `横条应带底色：${JSON.stringify(line)}`);
});

test("横条超宽时截断，不会撑破布局", () => {
	const styler = createHeaderStyler(ansiTheme());
	const line = styler.band("x".repeat(80), 20);

	assert.equal(visibleWidth(line), 20, "超宽横条应被截断到给定宽度");
	assert.ok(line.includes("…"), "截断处应有省略号");
});

test("宽度为 0 时不炸，返回空行", () => {
	const styler = createHeaderStyler(ansiTheme());
	assert.equal(visibleWidth(styler.band("用时", 0)), 0);
});

test("标签两侧留出空格并压上底色", () => {
	const styler = createHeaderStyler(ansiTheme());
	const chip = styler.chip("探索 · 3 步");

	assert.equal(visibleWidth(chip), visibleWidth("探索 · 3 步") + 2, "标签应左右各留一格");
	assert.ok(chip.includes(BG_PREFIX), `标签应带底色：${JSON.stringify(chip)}`);
});

test("强调色与主次文字各自套上主题色", () => {
	const styler = createHeaderStyler(ansiTheme());

	assert.ok(styler.accent("▸").startsWith(FG_PREFIX), "箭头应使用强调色");
	assert.ok(styler.primary("用时").startsWith(FG_PREFIX), "主体文字应使用主色");
	assert.ok(styler.muted("f2").startsWith(FG_PREFIX), "次要文字应使用弱化色");
});

test("主题缺色时退化成纯文本，排版仍然成立", () => {
	const styler = createHeaderStyler(missingColorTheme());

	assert.equal(styler.accent("▸"), "▸", "缺色时应原样返回");
	assert.equal(styler.primary("用时"), "用时");
	assert.equal(styler.muted("f2"), "f2");
	assert.equal(visibleWidth(styler.band("用时 21s", 12)), 12, "没有底色也要补齐到整宽");
	assert.equal(styler.chip("探索").trim(), "探索", "没有底色也保留两侧空格");
});
