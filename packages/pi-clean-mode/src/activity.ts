/**
 * 实时活动区的纯逻辑。
 *
 * 目标：运行期间用固定行数展示「现在在做什么」，而不是让 transcript 里的行反复增减。
 * 内容全部来自真实事件，不生成推测出来的进度。
 *
 * 屏幕上有两个位置报进度，分工固定，不说同一句话：
 *
 * - 轮首槽位（整轮最上面，`buildRunStatusLines`）：只报运行级状态「在处理 + 跑了多久」，
 *   和运行结束后的「用时」横条是同一个槽位、同一种横条，也是屏幕上唯一一条铺底色的横条；
 * - 活动块（接在当前动作组最后一条可见行的下面，`buildActivityLines`）：依次是思考头部、
 *   正在执行的工具与其输出尾巴，全部是最新状态，不占条、不铺底色。
 *
 * 分类计数（`formatActivityCountersSuffix`）也不单独占一行：它接在当前动作组的组头文案后面
 * （`探索 · 12 步 · 读取 3 · 命令 2`）。单独占一行时，它和组头的步数在数同一件事，
 * 加上顶部横条就变成三处在报进度。
 *
 * 活动块挂在最新那条动作的下面，因为最新状态必须落在列表最底下：挂在组头上方时，
 * 展开的组里它下面还压着整组成员行，看上去就悬在中段。
 *
 * 关键约束：行每 tick 都会重算，但内容常常没变（耗时没走到下一秒、动画帧循环回同一
 * 格），因此行内容必须可比较、不变时要能整体跳过重绘；真正决定「要不要重绘」以及在
 * 哪里渲染的职责在 activity-area.ts 与 component-patches.ts。
 */

import { formatDuration } from "./duration.js";
import { i18n } from "./i18n.js";

/**
 * 思考动画帧：半填充圆按顺时针转，四帧一循环。
 *
 * 每帧都是单格宽、被填满的墨量完全相同，所以图标不会忽大忽小；运动感来自被填充那半边的朝向。
 * 历史选择：盲文单点（⠁⠂⠄⡀⢀⠠⠐⠈）在深色底上像一个孤立的噪点；
 * 六段细弧线（◜◠◝◞◡◟）形状跨度大，在 150ms 一帧下像在闪。
 */
const THINKING_FRAMES = ["◐", "◓", "◑", "◒"] as const;
/** 工作动画帧。 */
const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
/** 静止时思考的标记：一个点，不使用圆圈字形。 */
const STILL_THINKING_GLYPH = "·";
/** 静止时工作的标记。 */
const STILL_WORKING_GLYPH = "›";
/** 活动区单行最大宽度。 */
export const ACTIVITY_MAX_LINE = 110;
/** 输出尾巴的最大宽度。 */
const OUTPUT_TAIL_MAX = 80;
/** 活动区用到的主题色，按用途命名，避免调用处依赖具体色键。 */
const COLOR_DIM = "dim";
const COLOR_DETAIL = "muted";
const COLOR_GLYPH = "accent";
const COLOR_HEADING = "toolTitle";
/** 从工具参数里尝试读取摘要的候选字段，按优先级排列。 */
const TOOL_ARG_KEYS = ["command", "file_path", "path", "pattern", "query", "url"] as const;
/**
 * 运行级横条的文案缩进：与组件补丁里折叠头（「用时 …」）的文案同列。
 *
 * 运行中与运行结束共用这一列，状态切换时文案不会横向跳；细节行再深一级。
 */
const BAND_INDENT = "  ";
/** 细节行（思考、当前动作）的缩进：比横条文案再深一级。 */
const DETAIL_INDENT = "    ";
/** 输出尾巴的缩进：让 `↳` 正好落在细节行文案的起始列。 */
const OUTPUT_INDENT = "      ";
/** 横条与细节行内各段之间的分隔符。 */
const SEGMENT_SEPARATOR = " · ";
/** 思考文案与「思考」标签之间的间距。 */
const THOUGHT_GAP = "  ";
/** 输出尾巴的标记。 */
const OUTPUT_MARKER = "↳ ";
/**
 * 成对出现的强调标记：`**粗体**`、`__粗体__`、反引号代码，各留捕获组 1（标记里的正文）。
 *
 * 拆成三条而不是一条带或的正则，是为了让替换一律用 `$1`；三条各自只有一个捕获组。
 */
const PAIRED_EMPHASIS_PATTERNS = [/\*\*(.+?)\*\*/g, /__(.+?)__/g, /`([^`]+)`/g] as const;
/** 替换模板：只保留第一个捕获组。 */
const CAPTURE_ONE = "$1";

/** 当前正在执行的工具。 */
export interface RunningAction {
	/** 工具调用 id。 */
	toolCallId: string;
	/** 语义动作标签，例如「运行命令」。 */
	label: string;
	/** 参数摘要，例如命令原文或文件路径。 */
	detail?: string;
	/** 最新的输出尾巴。 */
	outputTail?: string;
}

/** 运行期的分类计数。 */
export interface ActivityCounters {
	/** 读取类动作数。 */
	read: number;
	/** 搜索类动作数。 */
	search: number;
	/** 命令类动作数。 */
	command: number;
	/** 其它动作数。 */
	other: number;
}

/** 活动区渲染所需的快照。 */
export interface ActivitySnapshot {
	/** 运行是否进行中。 */
	active: boolean;
	/** 运行开始时间戳（毫秒）。 */
	startedAtMs?: number;
	/** 正在执行的工具；支持并行。 */
	running: RunningAction[];
	/** 模型思考的头部文本。 */
	thought?: string;
	/** 分类计数。 */
	counters: ActivityCounters;
}

/** 活动区渲染所需的输入。 */
export interface ActivityRenderInput {
	snapshot: ActivitySnapshot;
	/** 当前时间戳，用于计算耗时。 */
	nowMs: number;
	/** 动画帧序号。 */
	frame: number;
	/** 是否启用动画；关闭时输出静止标记。 */
	animated: boolean;
	/** 最多渲染几行。 */
	maxRows: number;
	/** 主题取色函数。 */
	paint: ActivityPainter;
}

/** 活动区渲染需要的着色与加粗能力。 */
export interface ActivityPainter {
	/** 按语义色着色。 */
	fg(color: string, text: string): string;
	/** 加粗。 */
	bold(text: string): string;
}

/** 创建空快照：未运行、无计数。 */
export function createActivitySnapshot(): ActivitySnapshot {
	return {
		active: false,
		running: [],
		counters: { read: 0, search: 0, command: 0, other: 0 },
	};
}

/** 取当前动画帧对应的标记。 */
export function activityGlyph(kind: "thinking" | "working", frame: number, animated: boolean): string {
	if (!animated) {
		return kind === "thinking" ? STILL_THINKING_GLYPH : STILL_WORKING_GLYPH;
	}

	const safeFrame = Math.max(0, Math.floor(frame));
	if (kind === "thinking") {
		return THINKING_FRAMES[safeFrame % THINKING_FRAMES.length] ?? STILL_THINKING_GLYPH;
	}
	return WORKING_FRAMES[safeFrame % WORKING_FRAMES.length] ?? STILL_WORKING_GLYPH;
}

/** 把长文本截断到指定宽度，超出用省略号。 */
export function clampActivityText(text: string, max = ACTIVITY_MAX_LINE): string {
	const single = text.replace(/\s*\n\s*/g, " ").trim();
	if (single.length <= max) {
		return single;
	}
	return `${single.slice(0, Math.max(0, max - 1))}…`;
}

/** 取工具名去掉 MCP 前缀后的裸名。 */
function bareToolName(toolName: string): string {
	const parts = toolName.split(/[/.]/);
	return (parts[parts.length - 1] ?? toolName).toLowerCase();
}

/** 把工具名映射成语义动作标签。 */
export function toolActivityLabel(toolName: string): string {
	switch (bareToolName(toolName)) {
		case "read":
		case "ls":
			return i18n.t("activityRead");
		case "grep":
		case "find":
			return i18n.t("activitySearch");
		case "edit":
		case "write":
			return i18n.t("activityEdit");
		case "bash":
		case "powershell":
			return i18n.t("activityCommand");
		default:
			return i18n.t("activityTool");
	}
}

/** 判断工具属于哪个计数分类。 */
export function classifyToolActivity(toolName: string): keyof ActivityCounters {
	switch (bareToolName(toolName)) {
		case "read":
		case "ls":
			return "read";
		case "grep":
		case "find":
			return "search";
		case "bash":
		case "powershell":
			return "command";
		default:
			return "other";
	}
}

/** 从工具参数里取一段可读摘要，例如命令原文或文件路径。 */
export function toolActivityDetail(toolName: string, args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}

	const record = args as Record<string, unknown>;
	for (const key of TOOL_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return clampActivityText(value.trim(), OUTPUT_TAIL_MAX);
		}
	}

	// 参数里没有已知字段时退回工具名，至少让用户知道在调什么。
	return toolName.trim().length > 0 ? clampActivityText(toolName, OUTPUT_TAIL_MAX) : undefined;
}

/** 从工具结果或部分结果里取最后一行可读文本。 */
export function extractOutputTail(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) {
		return undefined;
	}

	const content = (result as Record<string, unknown>).content;
	if (!Array.isArray(content)) {
		return undefined;
	}

	let last: string | undefined;
	for (const block of content) {
		if (typeof block !== "object" || block === null) {
			continue;
		}
		const text = (block as Record<string, unknown>).text;
		if (typeof text === "string" && text.trim().length > 0) {
			last = text;
		}
	}

	if (!last) {
		return undefined;
	}

	const lines = last.trim().split("\n").filter((line) => line.trim().length > 0);
	const tail = lines[lines.length - 1];
	return tail ? clampActivityText(tail, OUTPUT_TAIL_MAX) : undefined;
}

/**
 * 去掉思考原文里成对的 markdown 强调标记，只留标记里的正文。
 *
 * 活动区是一行纯文本，`**加粗**` 原样显示只会变成一串星号。只处理成对的
 * `**…**`、`__…__` 与反引号包裹；散落的单个 `*`、标识符里的下划线不动。
 */
export function stripEmphasisMarkup(text: string): string {
	return PAIRED_EMPHASIS_PATTERNS.reduce(
		(cleaned, pattern) => cleaned.replace(pattern, CAPTURE_ONE),
		text,
	);
}

/** 取模型思考的第一行非空内容。 */
export function extractThoughtHead(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) {
		return undefined;
	}

	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) {
		return undefined;
	}

	for (const block of content) {
		if (typeof block !== "object" || block === null) {
			continue;
		}
		const record = block as Record<string, unknown>;
		if (record.type !== "thinking" || typeof record.thinking !== "string") {
			continue;
		}
		const firstLine = record.thinking.split("\n").find((line) => line.trim().length > 0);
		if (firstLine) {
			const cleaned = stripEmphasisMarkup(firstLine).trim();
			return cleaned.length > 0 ? clampActivityText(cleaned, ACTIVITY_MAX_LINE) : undefined;
		}
	}

	return undefined;
}

/**
 * 参与组头计数的分类桶，顺序即展示顺序（读取 → 搜索 → 命令）。
 *
 * 文案键写在这里而不是拆成几段 if：新增或去掉一个桶只改这张表，拼接逻辑不必跟着动。
 */
const COUNTER_BUCKETS = [
	{ bucket: "read", messageKey: "activityCounterRead" },
	{ bucket: "search", messageKey: "activityCounterSearch" },
	{ bucket: "command", messageKey: "activityCounterCommand" },
] as const satisfies ReadonlyArray<{
	bucket: keyof ActivityCounters;
	messageKey: Parameters<typeof i18n.t>[0];
}>;

/**
 * 把非 0 的分类计数拼成组头后缀，例如 ` · 读取 3 · 命令 2`；没有计数时返回空串。
 *
 * 前缀分隔符也在这里拼，调用处直接接在组头文案后面就行，不必再判空或补分隔符。
 * 计数为 0 的桶不显示 —— 刚开始跑时「读取 0 · 搜索 0 · 命令 0」全是噪音。
 */
export function formatActivityCountersSuffix(counters: ActivityCounters): string {
	const parts = COUNTER_BUCKETS.filter(({ bucket }) => counters[bucket] > 0).map(
		({ bucket, messageKey }) => i18n.t(messageKey, { count: String(counters[bucket]) }),
	);
	return parts.length > 0 ? `${SEGMENT_SEPARATOR}${parts.join(SEGMENT_SEPARATOR)}` : "";
}

/**
 * 组装轮首的运行级状态行：在处理（并行时是并行文案）+ 跑了多久。
 *
 * 这一行由渲染层整行铺上底色，和运行结束后的「用时」横条共用同一列与同一套视觉，
 * 因此它是整轮最上面那个槽位里唯一的内容，越往下的细节都不归它。
 */
function buildRunStatusLine(input: ActivityRenderInput): string {
	const { snapshot, nowMs, frame, animated, paint } = input;
	const glyph = activityGlyph("working", frame, animated);
	const label = snapshot.running.length > 1 ? i18n.t("activityParallel") : i18n.t("activityWorking");

	const parts = [`${paint.fg(COLOR_GLYPH, `${glyph} `)}${paint.bold(paint.fg(COLOR_HEADING, label))}`];
	if (snapshot.startedAtMs !== undefined) {
		parts.push(paint.fg(COLOR_DETAIL, formatDuration(nowMs - snapshot.startedAtMs)));
	}

	return `${BAND_INDENT}${parts.join(SEGMENT_SEPARATOR)}`;
}

/**
 * 组装轮首槽位的状态行：只报「在处理 + 跑了多久」，不报思考、工具和计数。
 *
 * 轮首是整轮最上面那个槽位，它的职责只有运行级时间：和运行结束后的「用时」横条是同一种
 * 东西，状态切换时只换文案，位置与版式都不动。细节行只出现在活动块里，
 * 所以进度贴在新动作旁边，而顶部不会重复一份。
 *
 * 「处理中」这句话归这里独占：活动块里不再重复它，屏幕上只会出现一次。
 */
export function buildRunStatusLines(input: ActivityRenderInput): string[] {
	if (!input.snapshot.active || input.maxRows <= 0) {
		return [];
	}

	return [buildRunStatusLine(input)];
}

/**
 * 组装正在执行的工具行；并行时每个动作各占一行。
 *
 * 块里的动作行逐条列出，具体在跑什么由它负责，带输出尾巴的动作紧跟着一行。
 */
function buildRunningLines(input: ActivityRenderInput): string[] {
	const { snapshot, frame, animated, paint } = input;
	const glyph = paint.fg(COLOR_GLYPH, `${activityGlyph("working", frame, animated)} `);

	return snapshot.running.flatMap((action) => {
		const detail = action.detail ? paint.fg(COLOR_DETAIL, ` ${action.detail}`) : "";
		const lines = [
			`${DETAIL_INDENT}${glyph}${paint.bold(paint.fg(COLOR_HEADING, action.label))}${detail}`,
		];
		if (action.outputTail) {
			lines.push(paint.fg(COLOR_DIM, `${OUTPUT_INDENT}${OUTPUT_MARKER}${action.outputTail}`));
		}
		return lines;
	});
}

/** 组装思考头部那一行。 */
function buildThoughtLine(input: ActivityRenderInput): string[] {
	const { snapshot, frame, animated, paint } = input;
	if (!snapshot.thought) {
		return [];
	}

	const glyph = activityGlyph("thinking", frame, animated);
	return [
		`${DETAIL_INDENT}${paint.fg(COLOR_GLYPH, `${glyph} `)}${paint.bold(paint.fg(COLOR_HEADING, i18n.t("activityThinking")))}${paint.fg(COLOR_DETAIL, `${THOUGHT_GAP}${snapshot.thought}`)}`,
	];
}

/**
 * 组装活动块行。
 *
 * 内容是思考头部、正在执行的工具与其输出尾巴，全部是最新状态：没有铺底色的横条，
 * 也不重复顶部的时间与分类计数。超出 maxRows 时从尾部截断：预算再紧也先保住
 * 「正在跑什么」。
 */
export function buildActivityLines(input: ActivityRenderInput): string[] {
	const { snapshot, maxRows } = input;
	if (!snapshot.active || maxRows <= 0) {
		return [];
	}

	const lines = [...buildThoughtLine(input), ...buildRunningLines(input)];

	return lines.slice(0, maxRows);
}
