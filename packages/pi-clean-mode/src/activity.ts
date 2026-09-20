/**
 * 实时活动区的纯逻辑。
 *
 * 目标：运行期间用固定行数展示「现在在做什么」，而不是让 transcript 里的行反复增减。
 * 内容全部来自真实事件，不生成推测出来的进度。
 *
 * 屏幕上有两个位置报进度，分工固定，不说同一句话：
 *
 * - 轮首槽位（整轮最上面，`buildRunStatusLines`）：只报运行级状态「在处理 + 跑了多久」，
 *   和运行结束后的「用时」头是同一个槽位、同一种版式（粗竖条 `▌` + 加粗文案）；
 * - 活动块（接在当前动作组最后一条可见行的下面，`buildActivityLines`）：依次是思考头部、
 *   正在执行的工具与其输出尾巴，最后接一行本轮分类计数尾注。每行前面还带一段
 *   `├─` / `└─` 竖折（`renderActivityRows`）把自己挂在组头下面；只靠缩进时，看不出
 *   这些行到底属于上面哪一条。
 *
 * 分类计数（`activityCountersNote`）作为活动块最后一行的尾注，而不是接在组头文案后面：
 * 组头、活动块、轮首三处都在报进度时，屏幕上同一件事会被数三遍。它接在**已过滤**的
 * 最后一行上，所以单条组去掉动作行之后也不会跟着消失，也不占行数预算。
 *
 * 活动块挂在最新那条动作的下面，因为最新状态必须落在列表最底下：挂在组头上方时，
 * 展开的组里它下面还压着整组成员行，看上去就悬在中段。
 *
 * 关键约束：行每 tick 都会重算，但内容常常没变（耗时没走到下一秒、动画帧循环回同一
 * 格），因此行内容必须可比较、不变时要能整体跳过重绘；真正决定「要不要重绘」以及在
 * 哪里渲染的职责在 activity-area.ts 与 component-patches.ts。
 */

import { formatDuration } from "./duration.js";
import { GUTTER_GAP, RUN_GUTTER } from "./header-style.js";
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
 * 运行级状态行的缩进：与组件补丁里折叠头（「用时 …」）的粗竖条同列。
 *
 * 运行中与运行结束共用这一列，状态切换时文案不会横向跳；细节行再深一级。
 * 竖条从 `header-style` 取，两处一旦各写一个就会漂移。
 */
const BAND_INDENT = `${RUN_GUTTER}${GUTTER_GAP}`;
/**
 * 活动块树形前缀的缩进：不缩，竖折直接顶在第 0 列。
 *
 * 组头的细竖条 `│` 与运行级的粗竖条 `▌` 也都在第 0 列，三级连成一条从顶到底的
 * 左侧轨道；再缩一级就会让树形行与组头错开一列，轨道断成两段。
 * 展开的动作组里「每条命令一行」也用这一列，思考行才是和命令平级的兄弟项。
 */
export const TREE_INDENT = "";
/** 子项前的分支符：它后面还有别的子项时用这个。 */
export const BRANCH_MIDDLE = "├─";
/** 最后一个子项的分支符：整块到这里收口。 */
export const BRANCH_LAST = "└─";
/** 子项续行的宽度占位：与分支符 `├─ ` 同宽，正文才对得齐。 */
export const BRANCH_CONTINUATION_PADDING = "  ";
/** 续行所属的子项后面还有子项时，用竖线把它和后续子项贯通起来。 */
const BRANCH_CONTINUATION = "│";
/** 运行状态行与细节行内各段之间的分隔符；也是计数尾注接在行尾时的连接符。 */
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

/** 分类桶对应的 i18n key。 */
const ACTIVITY_CLASS_LABELS = {
	read: "activityRead",
	search: "activitySearch",
	command: "activityCommand",
	other: "activityTool",
} as const;

/** 能当组头主词的分类；顺序决定平手时先取谁。 */
const DOMINANT_ACTIVITY_CLASSES = ["command", "read", "search"] as const;

/** 能当组头主词的分类。 */
export type DominantActivityClass = (typeof DOMINANT_ACTIVITY_CLASSES)[number];

/** 取分类桶对应的动作标签（如 `运行命令`）。 */
export function activityClassLabel(bucket: keyof ActivityCounters): string {
	return i18n.t(ACTIVITY_CLASS_LABELS[bucket]);
}

/**
 * 取一组动作里的主导分类：某一类**严格过半**才算主导，否则返回 undefined。
 *
 * 分母是组内全部成员（含 `other`），`other` 自己不当主词 —— 「调用工具」什么也说不出。
 * 用「过半」而不是「最多的一类」，是因为 3 条读取 + 2 条命令说成「读取文件 · 5 步」会误导；
 * 一半对一半时没有哪一类说得清这一组在做什么，交给调用方退回通用词。
 */
export function dominantActivityClass(counts: Partial<ActivityCounters> | undefined): DominantActivityClass | undefined {
	if (!counts) {
		return undefined;
	}

	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	if (total <= 0) {
		return undefined;
	}

	return DOMINANT_ACTIVITY_CLASSES.find((bucket) => (counts[bucket] ?? 0) * 2 > total);
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
 * 把非 0 的分类计数拼成一行尾注，例如 `读取 3 · 命令 2`；没有计数时返回空串。
 *
 * 计数为 0 的桶不显示 —— 刚开始跑时「读取 0 · 搜索 0 · 命令 0」全是噪音。
 * 自己带分隔符但**不带前导分隔符**：拼接在末尾那一行时有统一的拼接口。
 */
export function formatActivityCountersNote(counters: ActivityCounters): string {
	return COUNTER_BUCKETS.filter(({ bucket }) => counters[bucket] > 0)
		.map(({ bucket, messageKey }) => i18n.t(messageKey, { count: String(counters[bucket]) }))
		.join(SEGMENT_SEPARATOR);
}

/**
 * 尾注要不要出现。
 *
 * 只有一次动作时不出现：组头已经把那次动作的名字写在上面了，再补一句「命令 1」是废话。
 * 这里用计数总和当门槛而不是真实的组大小：计数是本轮累计值，也跨组。
 */
const MIN_ACTIONS_FOR_COUNTER_NOTE = 2;

/** 按门槛算出的尾注文案；不该出现时为空串。 */
export function activityCountersNote(counters: ActivityCounters): string {
	const total = counters.read + counters.search + counters.command + counters.other;
	return total < MIN_ACTIONS_FOR_COUNTER_NOTE ? "" : formatActivityCountersNote(counters);
}

/**
 * 把尾注接在活动块的一个子项行后面；尾注为空、块为空时原样返回。
 *
 * 优先接最后一个子项行（动作行、思考行），不接输出尾巴：尾巴是命令自己打出来的那行，
 * 把本轮计数接到它后面，读起来就像这条命令的汇总。补位空行同样不能挂 —— 那会在屏幕上
 * 留下一个只带分隔符的孤行；块里只剩续行时才退回最后一条非空行。
 * 在已渲染的行上拼接而不是另加一行：行数预算让给「正在跑什么」，删掉动作行之后也还在。
 */
export function appendActivityCountersNote(
	rows: ActivityRow[],
	lines: string[],
	note: string,
): string[] {
	if (note === "") {
		return lines;
	}

	const target = lastItemRowIndex(rows) ?? lastNonEmptyLineIndex(lines);
	if (target === undefined) {
		return lines;
	}

	return lines.map((line, index) =>
		index === target ? `${line}${SEGMENT_SEPARATOR}${note}` : line,
	);
}

/** 最后一个子项行（动作名或思考头部）的行号；块里只有续行时返回 undefined。 */
function lastItemRowIndex(rows: ActivityRow[]): number | undefined {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		if (rows[index]?.kind === "item") {
			return index;
		}
	}
	return undefined;
}

/** 最后一条非空行；用来兜底「块里没有子项行」这种形态。 */
function lastNonEmptyLineIndex(lines: string[]): number | undefined {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index] !== "") {
			return index;
		}
	}
	return undefined;
}

/**
 * 组装轮首的运行级状态行：在处理（并行时是并行文案）+ 跑了多久。
 *
 * 这一行由渲染层画在轮首，和运行结束后的「用时」头共用同一列与同一套版式
 * （粗竖条 `▌` + 加粗文案），因此它是整轮最上面那个槽位里唯一的内容，
 * 越往下的细节都不归它。
 *
 * 行首不画转动图标：这一行的耗时本身就每秒在变，「还在跑」已经说清楚了；再加一个
 * 每 150ms 转一下的图标，只会在顶部多一处跳动，和活动块里那个真正表示「这条命令在跑」
 * 的图标抢注意力。运行结束后换成 `▌ 用时 42s`，两者版式一致，切换时不跳列。
 *
 * 行首也不加 `[clean]` 来源前缀：折叠头每轮都画、位置固定，前缀只会把文案右推到
 * 与细节行不同的列上。粗竖条本身就是「这是 clean-mode 画的」的标记。
 */
function buildRunStatusLine(input: ActivityRenderInput): string {
	const { snapshot, nowMs, paint } = input;
	const label = snapshot.running.length > 1 ? i18n.t("activityParallel") : i18n.t("activityWorking");

	const parts = [paint.bold(paint.fg(COLOR_HEADING, label))];
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
 * 行与「哪些行是动作名」一起返回：组头已经写出这条动作时（单条组），渲染层要把动作名
 * 那几行去掉，只留输出尾巴，靠的就是 `actionRows`。
 */
function buildRunningRows(input: ActivityRenderInput): { rows: ActivityRow[]; actionRows: number[] } {
	const { snapshot, frame, animated, paint } = input;
	const glyph = paint.fg(COLOR_GLYPH, `${activityGlyph("working", frame, animated)} `);
	const rows: ActivityRow[] = [];
	const actionRows: number[] = [];

	for (const action of snapshot.running) {
		const detail = action.detail ? paint.fg(COLOR_DETAIL, ` ${action.detail}`) : "";
		actionRows.push(rows.length);
		rows.push({ kind: "item", text: `${glyph}${paint.bold(paint.fg(COLOR_HEADING, action.label))}${detail}` });
		if (action.outputTail) {
			rows.push({ kind: "tail", text: paint.fg(COLOR_DIM, `${OUTPUT_MARKER}${action.outputTail}`) });
		}
	}

	return { rows, actionRows };
}

/** 组装思考头部那一行。 */
function buildThoughtRows(input: ActivityRenderInput): ActivityRow[] {
	const { snapshot, frame, animated, paint } = input;
	if (!snapshot.thought) {
		return [];
	}

	const glyph = activityGlyph("thinking", frame, animated);
	return [
		{
			kind: "item",
			text: `${paint.fg(COLOR_GLYPH, `${glyph} `)}${paint.bold(paint.fg(COLOR_HEADING, i18n.t("activityThinking")))}${paint.fg(COLOR_DETAIL, `${THOUGHT_GAP}${snapshot.thought}`)}`,
		},
	];
}

/**
 * 活动块里一行的类型：子项（思考、正在执行的动作）、子项的续行（输出尾巴）、补位空行。
 */
export type ActivityRowKind = "item" | "tail" | "blank";

/**
 * 活动块里的一行。
 *
 * 只放正文、不放缩进与树形前缀：前缀要等「哪几行最终留在屏幕上」定下来才能拼 ——
 * 单条组的动作行会被去掉，去掉之后原本的第二项就成了最后一项，分支符得从 `├─` 换成 `└─`。
 * 所以渲染推迟到 `renderActivityRows`，去掉行之后再拼一次。
 */
export interface ActivityRow {
	kind: ActivityRowKind;
	/** 已着色的正文，不含缩进与树形前缀。 */
	text: string;
}

/**
 * 活动块：块里的全部行，以及哪几行在报「正在跑什么」。
 *
 * 分开报是为了同一句话只说一遍：组头已经写出这条动作时（组内只有一条，组头就是那条动作
 * 的摘要），渲染层按 `actionRows` 把动作名去掉，只留思考与输出尾巴；多条成员的组头是
 * 汇总文案（`探索 · 12 步`），没写出具体动作，就得把动作行都留下。
 */
export interface ActivityLines {
	/** 块里的全部行，按渲染顺序；不带树形前缀。 */
	rows: ActivityRow[];
	/** `rows` 里属于动作名的行号（并行时多条）。 */
	actionRows: number[];
}

/** 补位空行：行数只增不减时用来占位，渲染成真正的空行。 */
export function blankActivityRow(): ActivityRow {
	return { kind: "blank", text: "" };
}

/** 这一项的分支符：后面还有别的子项时用 `├─`，否则用 `└─` 收口。 */
export function treeBranch(isLast: boolean): string {
	return isLast ? BRANCH_LAST : BRANCH_MIDDLE;
}

/**
 * 拼一条树形行：`  ├─ 正文`。
 *
 * 展开的动作组里「每条命令一行」与活动块里的思考行共用它，缩进与分支符才不会各写
 * 一套；两套写法一旦漂移，命令行和思考行就不再是同一棵树里的兄弟项。
 */
export function renderTreeRow(
	text: string,
	options: { isLast: boolean; paintBranch: (branch: string) => string },
): string {
	return `${renderTreePrefix(options.isLast, options.paintBranch)}${text}`;
}

/** 树形行的前缀（`  ├─ ` / `  └─ `）：正文从这一列之后开始。 */
export function renderTreePrefix(
	isLast: boolean,
	paintBranch: (branch: string) => string,
): string {
	return `${TREE_INDENT}${paintBranch(treeBranch(isLast))} `;
}

/** 从 `index` 往后还有没有别的子项；续行与补位空行都不算。 */
function hasItemAfter(rows: ActivityRow[], index: number): boolean {
	return rows.slice(index + 1).some((row) => row.kind === "item");
}

/** 续行所属的子项行号：往前找最近的子项；找不到（它所属的子项已被去掉）返回 -1。 */
function ownerItemIndex(rows: ActivityRow[], index: number): number {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		if (rows[cursor]?.kind === "item") {
			return cursor;
		}
	}
	return -1;
}

/**
 * 把结构化行拼成最终文本：子项带 `├─` / `└─`，续行补上贯通的竖线。
 *
 * 「最后一个子项」只看后面还有没有别的子项，补位空行不参与，所以截断、去动作行之后
 * 重算都自动得到正确的收口。空行原样渲染成空串：补位不该在屏幕上留下一串前缀。
 */
export function renderActivityRows(rows: ActivityRow[], paint: ActivityPainter): string[] {
	return rows.map((row, index) => {
		if (row.kind === "blank") {
			return "";
		}

		if (row.kind === "item") {
			return renderTreeRow(row.text, {
				isLast: !hasItemAfter(rows, index),
				paintBranch: (branch) => paint.fg(COLOR_DIM, branch),
			});
		}

		const owner = ownerItemIndex(rows, index);
		const mark = owner >= 0 && hasItemAfter(rows, owner) ? BRANCH_CONTINUATION : " ";
		return `${TREE_INDENT}${paint.fg(COLOR_DIM, mark)}${BRANCH_CONTINUATION_PADDING}${row.text}`;
	});
}

/**
 * 组装活动块。
 *
 * 内容是思考头部、正在执行的工具与其输出尾巴，全部是最新状态：不占额外的行，
 * 也不重复顶部的时间与分类计数（计数由 `appendActivityCountersNote` 接在最后一行尾部）。
 * 超出 maxRows 时从尾部截断：预算再紧也先保住「正在跑什么」；被截掉的动作行也不再算动作行。
 */
export function buildActivityLines(input: ActivityRenderInput): ActivityLines {
	const { snapshot, maxRows } = input;
	if (!snapshot.active || maxRows <= 0) {
		return { rows: [], actionRows: [] };
	}

	const thought = buildThoughtRows(input);
	const running = buildRunningRows(input);
	const rows = [...thought, ...running.rows].slice(0, maxRows);

	return {
		rows,
		actionRows: running.actionRows
			.map((row) => row + thought.length)
			.filter((row) => row < rows.length),
	};
}

/** 活动块里去掉动作名后的行：思考头部与输出尾巴；组头已经写出这条动作时用这个形态。 */
export function withoutActionRows({ rows, actionRows }: ActivityLines): ActivityRow[] {
	const actionRowSet = new Set(actionRows);
	return rows.filter((_row, row) => !actionRowSet.has(row));
}
