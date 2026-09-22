/**
 * 折叠头的视觉样式。
 *
 * 折叠头不能和正文长一个样：正文是流式叙述，折叠头是能被点开的结构行。三级用
 * 同一套语言区分，靠的是**左侧竖条 + 字重**，不是底色：
 *
 * - 运行级折叠头：粗竖条 `▌` + 加粗文案 —— 最强的一档，「这里收了一整轮」；
 * - 动作组头：细竖条 `│` + 普通字重 + 弱化色 —— 弱一档，工作过程收在这里；
 * - 正文与工具行：不画竖条，保持 Pi 原本的样子。
 *
 * 两级竖条都从第 0 列起画，文案因此落在同一列；但两根竖条本身并不构成一条严格
 * 对齐的连续轨道 —— 半格实心块 `▌` 画在格子左半边、居中的 `│` 画在格子中间，
 * 横向差半格，所以组头块首行留白，不用竖条去接上下两端（接起来才显得歪）。竖条
 * 只回答「收没收起来、收的是整轮还是一步」，粗细就是层级。
 *
 * 底色在这套语言里只出现在一个地方：工具行（成员摘要行与折叠态的组头）。它不表示
 * 层级，而是表示「这条不是 Agent 写的字」—— Pi 原生工具行本来就有底色
 * （`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`），摘要行替掉原生行之后要把
 * 这层语义接回来。底色只在工具行上用：折叠头、正文、活动块都不铺。
 *
 * 底色刻意不用来做层级：它只该出现在 diff 这类「内容本身有色」的地方。用底色区分
 * 层级有两个问题 —— 浅色主题下底色块会让整行对比度反转；而且它逼着每一行都补齐到
 * 整宽，白搭一份截断与补白逻辑。
 *
 * 主题缺色时对应能力退化成原样文本：宁可少一层装饰，也不能因为主题少一个键
 * 把整块渲染打断。缺色只在构造时探测一次，渲染路径上没有 try/catch。
 */

/**
 * 运行级竖条：半格实心块，配加粗文案，是两级竖条里最强的一档。
 *
 * 它是实心块而不是更粗的竖线：`┃`（粗竖线）在多数字体里和 `│` 粗细几乎一样，
 * 「粗一档」就白写了；半格实心块够重，代价是它画在格子左半边、与居中的 `│` 差半格，
 * 所以两级竖条只能做到文案同列，做不到笔画对齐（见文件头）。
 */
export const RUN_GUTTER = "▌";
/** 动作组竖条：细线，弱一档。 */
export const GROUP_GUTTER = "│";
/** 竖条与文案之间的间隔；两级文案因此从同一列起写。 */
export const GUTTER_GAP = " ";
/**
 * 轨道前缀占用的列宽：竖条 1 列 + 间隔 1 列。
 *
 * 给整块内容（例如运行期间的扩展条目）加前缀时要按它把渲染宽度让出来，否则整行会超宽。
 * 值与 `renderGutterPrefix` 的产出绑在一起，测试会核对两者一致；运行级前缀
 * `RUN_GUTTER + GUTTER_GAP` 也是这个宽度，两级文案因此同列。
 */
export const GUTTER_PREFIX_WIDTH = 2;
/** 工具行三档底色的主题键，与 Pi 原生工具行用的是同一组。 */
const BG_TOOL_SUCCESS = "toolSuccessBg";
const BG_TOOL_PENDING = "toolPendingBg";
const BG_TOOL_ERROR = "toolErrorBg";
/** 强调色：箭头等可点击提示。 */
const COLOR_ACCENT = "accent";
/** 主文字色：折叠头的主体信息。 */
const COLOR_PRIMARY = "text";
/** 弱化色：次要信息与动作组竖条。 */
const COLOR_MUTED = "muted";
/** 更弱的颜色：树形分支符这类纯结构字符，只用来勾出层级。 */
const COLOR_DIM = "dim";

/**
 * 着色用到的主题能力。
 *
 * 结构上对应 Pi 的 Theme，但只声明这里真正用到的方法，测试不必伪造整个主题。
 */
export interface ThemePainter {
	fg(color: string, text: string): string;
	bold(text: string): string;
	/** 底色；主题对象上有这个方法，但测试替身与老版本主题可能没有。 */
	bg?(color: string, text: string): string;
}

/** 折叠头的着色能力；主题缺色时对应方法退化成原样文本。 */
export interface HeaderStyler {
	/** 强调：箭头等可点击提示。 */
	accent(text: string): string;
	/** 主体信息（例如「用时 21s」）。 */
	primary(text: string): string;
	/** 次要信息（例如「5 步」）与动作组竖条。 */
	muted(text: string): string;
	/** 结构字符（例如树形分支符 `├─`），比 muted 更弱。 */
	dim(text: string): string;
	/** 加粗：只能靠字重区分层级的地方用它。主题没有这个能力时原样返回。 */
	bold(text: string): string;
	/** 工具行底色：这条调用已经跑完。主题没有这个键时原样返回。 */
	successBg(text: string): string;
	/** 工具行底色：这条调用还在跑。 */
	pendingBg(text: string): string;
	/** 工具行底色：这条调用出错。 */
	errorBg(text: string): string;
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

/** 探测加粗是否可用；语义同前，探测失败时返回 undefined。 */
function probeBold(theme: ThemePainter): ((text: string) => string) | undefined {
	try {
		theme.bold(" ");
	} catch {
		return undefined;
	}
	return (text) => theme.bold(text);
}

/**
 * 探测底色是否可用。
 *
 * 语义同前景色：主题里没有这个键时 `theme.bg` 会抛，所以只能真的调一次。
 * 主题对象上压根没有 `bg` 方法时（测试替身、老版本）也当作不可用。
 */
function probeBackground(
	theme: ThemePainter,
	color: string,
): ((text: string) => string) | undefined {
	const paint = theme.bg;
	if (typeof paint !== "function") {
		return undefined;
	}
	try {
		paint.call(theme, color, " ");
	} catch {
		return undefined;
	}
	return (text) => paint.call(theme, color, text);
}

/** 原样返回文本；缺色时用它兜底。 */
function identity(text: string): string {
	return text;
}

/**
 * 拼轨道前缀 `│ `。
 *
 * 动作组头用它起头；运行期间的扩展条目这类整块内容也用它接上运行时轨道 —— 两条轨道字符必须来自
 * 同一处，否则一处换字形、另一处还留着旧写法，看上去就是两根对不齐的竖条。
 */
export function renderGutterPrefix(styler: HeaderStyler): string {
	return `${styler.muted(GROUP_GUTTER)}${GUTTER_GAP}`;
}

/**
 * 从 Pi 主题造折叠头着色器。
 *
 * 主题缺哪个键，就只少那一层装饰，其余照常；不会因为一个键缺失整行渲染失败。
 */
export function createHeaderStyler(theme: ThemePainter): HeaderStyler {
	return {
		accent: probeForeground(theme, COLOR_ACCENT) ?? identity,
		primary: probeForeground(theme, COLOR_PRIMARY) ?? identity,
		muted: probeForeground(theme, COLOR_MUTED) ?? identity,
		dim: probeForeground(theme, COLOR_DIM) ?? identity,
		bold: probeBold(theme) ?? identity,
		successBg: probeBackground(theme, BG_TOOL_SUCCESS) ?? identity,
		pendingBg: probeBackground(theme, BG_TOOL_PENDING) ?? identity,
		errorBg: probeBackground(theme, BG_TOOL_ERROR) ?? identity,
	};
}
