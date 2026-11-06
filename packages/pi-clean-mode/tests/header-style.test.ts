import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createHeaderStyler,
	GUTTER_GAP,
	GUTTER_PREFIX_WIDTH,
	renderGutterPrefix,
	RUN_GUTTER,
	type ThemePainter,
} from "../src/header-style.ts";

/** 伪造的前景色码前缀，用来断言「确实套了这一层色」。 */
const FG_PREFIX = "\x1b[38;5;99m";
/** 伪造的加粗码，用来断言「确实加了粗」。 */
const BOLD_PREFIX = "\x1b[1m";

/** 造一个会产生真 ANSI 码的主题替身。 */
function ansiTheme(): ThemePainter {
	return {
		fg: (_color, text) => `${FG_PREFIX}${text}\x1b[39m`,
		bold: (text) => `${BOLD_PREFIX}${text}\x1b[22m`,
	};
}

/** 造一个缺色的主题替身：模拟主题里没有这些颜色键（Pi 的 theme.fg 会抛）。 */
function missingColorTheme(): ThemePainter {
	return {
		fg: () => {
			throw new Error("Unknown theme color");
		},
		bold: (text) => text,
	};
}

test("强调色与主次文字各自套上主题色", () => {
	const styler = createHeaderStyler(ansiTheme());

	assert.ok(styler.accent("▶").startsWith(FG_PREFIX), "箭头应使用强调色");
	assert.ok(styler.primary("用时").startsWith(FG_PREFIX), "主体文字应使用主色");
	assert.ok(styler.muted("5 步").startsWith(FG_PREFIX), "次要文字应使用弱化色");
	assert.ok(styler.dim("├─").startsWith(FG_PREFIX), "结构字符应使用最弱的一档");
});

test("加粗是独立一层能力，与颜色互不替代", () => {
	const styler = createHeaderStyler(ansiTheme());

	assert.ok(styler.bold("用时 21s").startsWith(BOLD_PREFIX), "加粗应真的套上粗体码");
	assert.equal(
		styler.bold(styler.primary("用时 21s")),
		styler.bold(styler.primary("用时 21s")),
		"加粗与取色应可嵌套",
	);
});

test("主题缺色时退化成原样文本，没有装饰也不会抛", () => {
	const styler = createHeaderStyler(missingColorTheme());

	assert.equal(styler.accent("▶"), "▶", "缺色时应原样返回");
	assert.equal(styler.primary("用时"), "用时");
	assert.equal(styler.muted("5 步"), "5 步");
	assert.equal(styler.dim("├─"), "├─");
});

test("主题没有加粗能力时原样返回", () => {
	const noBoldTheme: ThemePainter = {
		fg: (_color, text) => text,
		bold: () => {
			throw new Error("Unknown theme capability");
		},
	};

	assert.equal(createHeaderStyler(noBoldTheme).bold("用时"), "用时", "加粗不可用时应原样返回");
});

test("轨道前缀带弱化色，并且宽度的声明值与实际一致", () => {
	const styler = createHeaderStyler(ansiTheme());
	const prefix = renderGutterPrefix(styler);

	assert.ok(prefix.startsWith(FG_PREFIX), "轨道前缀应与组头同用弱化色");
	// 伪造主题在字符后面补了重置码，所以先去掉转义再看明文字符。
	assert.equal(
		prefix.replace(/\u001b\[[0-9;]*m/g, ""),
		"│ ",
		"前缀应为竖条加间隔",
	);
	assert.equal(
		visibleWidth(prefix),
		GUTTER_PREFIX_WIDTH,
		"让出列宽的常量必须与实际渲染宽度一致，否则整行会溢出或少两列",
	);
});

test("运行级竖条与动作组前缀同宽，两级文案才能同列", () => {
	// 文案列靠两边的宽度相同才能对齐；两根竖条的笔画本身对不齐（半格实心块与
	// 居中竖线不同族），能对齐的只有宽度与文案列。
	assert.equal(
		visibleWidth(`${RUN_GUTTER}${GUTTER_GAP}`),
		GUTTER_PREFIX_WIDTH,
		"运行级前缀应与动作组前缀同宽，两级文案才能同列",
	);
	assert.notEqual(RUN_GUTTER.trim(), "", "运行级应真的画出一根竖条");
	assert.notEqual(RUN_GUTTER, "│", "运行级用实心粗块，与动作组的细竖条不同字形");
});

test("主题没有工具底色能力时，三档底色都退化成原样文本", () => {
	const styler = createHeaderStyler(missingColorTheme());

	assert.equal(styler.successBg("行"), "行");
	assert.equal(styler.pendingBg("行"), "行");
	assert.equal(styler.errorBg("行"), "行");
});

test("三档工具底色各取自己的主题键", () => {
	const seen: string[] = [];
	const theme: ThemePainter = {
		fg: (_color, text) => text,
		bold: (text) => text,
		bg: (color, text) => {
			seen.push(color);
			return `[${color}]${text}`;
		},
	};
	const styler = createHeaderStyler(theme);

	assert.equal(styler.successBg("行"), "[toolSuccessBg]行");
	assert.equal(styler.pendingBg("行"), "[toolPendingBg]行");
	assert.equal(styler.errorBg("行"), "[toolErrorBg]行");
	// 构造时每个键各探一次，渲染时不再探测：缺键的代价只在启动时付一次。
	assert.deepEqual(seen.slice(0, 3).sort(), ["toolErrorBg", "toolPendingBg", "toolSuccessBg"]);
});
