/**
 * 实时活动区的纯逻辑。
 *
 * 目标：运行期间在编辑器上方用固定行数展示「现在在做什么」，而不是让 transcript
 * 里的行反复增减。内容全部来自真实事件，不生成推测出来的进度。
 *
 * 参考实现（pi-desktop-transcript）的关键约束：`setWidget` 会重绘整屏，
 * 因此行内容必须可比较、内容不变时要能整体跳过重绘；真正调用 setWidget 的
 * 职责在 activity-area.ts。
 */

import { formatDuration } from "./duration.js";
import { i18n } from "./i18n.js";

/** 思考动画帧；刻意比 working 慢半速。 */
const THINKING_FRAMES = ["◌", "◔", "◑", "◕"] as const;
/** 工作动画帧。 */
const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
/** 静止时思考与工作的标记。 */
const STILL_THINKING_GLYPH = "◌";
/** 静止时工作的标记。 */
const STILL_WORKING_GLYPH = "›";
/** 每几帧前进一次思考动画，使其慢于工作动画。 */
const THINKING_FRAME_DIVISOR = 2;
/** 活动区单行最大宽度。 */
export const ACTIVITY_MAX_LINE = 110;
/** 输出尾巴的最大宽度。 */
const OUTPUT_TAIL_MAX = 80;
/** 活动区用到的主题色，按用途命名，避免调用处依赖具体色键。 */
const COLOR_RAIL = "dim";
const COLOR_DETAIL = "muted";
const COLOR_GLYPH = "accent";
const COLOR_HEADING = "toolTitle";
/** 从工具参数里尝试读取摘要的候选字段，按优先级排列。 */
const TOOL_ARG_KEYS = ["command", "file_path", "path", "pattern", "query", "url"] as const;
/** 活动区轨道前缀。 */
const RAIL = "│ ";
/** 输出行的额外缩进。 */
const OUTPUT_INDENT = "  ";

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
		const index = Math.floor(safeFrame / THINKING_FRAME_DIVISOR) % THINKING_FRAMES.length;
		return THINKING_FRAMES[index] ?? STILL_THINKING_GLYPH;
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
			return clampActivityText(firstLine, ACTIVITY_MAX_LINE);
		}
	}

	return undefined;
}

/** 组装计数与耗时那一行。 */
function buildCounterLine(input: ActivityRenderInput): string {
	const { snapshot, nowMs, paint } = input;
	const elapsed = snapshot.startedAtMs === undefined ? "" : formatDuration(nowMs - snapshot.startedAtMs);
	return paint.fg(
		COLOR_DETAIL,
		i18n.t("activityCounters", {
			read: String(snapshot.counters.read),
			search: String(snapshot.counters.search),
			command: String(snapshot.counters.command),
			duration: elapsed,
		}),
	);
}

/** 组装当前动作那一行（含并行情况）。 */
function buildCurrentLines(input: ActivityRenderInput): string[] {
	const { snapshot, frame, animated, paint } = input;
	const glyph = activityGlyph("working", frame, animated);
	const rail = paint.fg(COLOR_RAIL, RAIL);

	if (snapshot.running.length === 0) {
		return [
			`${rail}${paint.fg(COLOR_GLYPH, `${glyph} `)}${paint.bold(paint.fg(COLOR_HEADING, i18n.t("activityWorking")))}`,
		];
	}

	if (snapshot.running.length > 1) {
		const labels = [...new Set(snapshot.running.map((action) => action.label))];
		return [
			`${rail}${paint.fg(COLOR_GLYPH, `${glyph} `)}${paint.bold(paint.fg(COLOR_HEADING, i18n.t("activityParallel")))}${paint.fg(COLOR_DETAIL, ` ${snapshot.running.length} · ${labels.join(" / ")}`)}`,
		];
	}

	const action = snapshot.running[0];
	const detail = action?.detail ? paint.fg(COLOR_DETAIL, ` ${action.detail}`) : "";
	const lines = [
		`${rail}${paint.fg(COLOR_GLYPH, `${glyph} `)}${paint.bold(paint.fg(COLOR_HEADING, action?.label ?? ""))}${detail}`,
	];

	if (action?.outputTail) {
		lines.push(paint.fg(COLOR_RAIL, `${RAIL}${OUTPUT_INDENT}↳ ${action.outputTail}`));
	}

	return lines;
}

/** 组装思考头部那一行。 */
function buildThoughtLine(input: ActivityRenderInput): string[] {
	const { snapshot, frame, animated, paint } = input;
	if (!snapshot.thought) {
		return [];
	}

	const glyph = activityGlyph("thinking", frame, animated);
	const rail = paint.fg(COLOR_RAIL, RAIL);
	return [
		`${rail}${paint.fg(COLOR_GLYPH, `${glyph} `)}${paint.bold(paint.fg(COLOR_HEADING, i18n.t("activityThinking")))}${paint.fg(COLOR_DETAIL, `  ${snapshot.thought}`)}`,
	];
}

/**
 * 组装活动区行。
 *
 * 优先展示正在做什么，其次最新输出、思考头部，最后计数与耗时；
 * 超出 maxRows 时从尾部截断，保证最关键的当前动作一定可见。
 */
export function buildActivityLines(input: ActivityRenderInput): string[] {
	const { snapshot, maxRows } = input;
	if (!snapshot.active || maxRows <= 0) {
		return [];
	}

	const lines = [
		...buildCurrentLines(input),
		...buildThoughtLine(input),
		buildCounterLine(input),
	];

	return lines.slice(0, maxRows);
}
