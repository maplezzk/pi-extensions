/**
 * 组件原型补丁。
 *
 * Pi 在扩展入口导出 AssistantMessageComponent 与 ToolExecutionComponent，
 * 这里接管两者的 render / updateContent，实现「折叠时只留最终答案」：
 *
 * - assistant 消息：工作过程（带 tool call）整条隐藏；最终答案保留；
 * - 工具行：整行隐藏，由于空渲染会返回 []，连前置空行一起消失；
 * - 折叠头：作为本轮第一条 assistant 消息内容容器的第一个子组件插入，并包一层
 *   MouseRegion，因此全屏模式下可以鼠标点击切换折叠状态。
 *
 * 为什么可以用「带不带 tool call」区分工作过程与最终答案：agent 循环在没有
 * tool call 时结束，所以一次运行里不带 tool call 的 assistant 消息只有最后一条。
 *
 * 折叠头做成子组件而不是 render 里拼接的字符串，是因为 Container 的鼠标分发
 * 按子组件高度计算 y 偏移；用拼接字符串会让偏移错位。
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	TOOL_ROW_GROUP_HEADER,
	TOOL_ROW_HIDDEN,
	type ActionGroupMembership,
} from "./action-groups.js";
import { formatDuration } from "./duration.js";
import { debugLog } from "./debug-logger.js";
import type { HeaderStyler } from "./header-style.js";
import { i18n } from "./i18n.js";
import {
	resolveAssistantMessageRender,
	resolveRunHeader,
	resolveToolRowMode,
	type AssistantMessageKind,
} from "./render-policy.js";
import { installMethodPatch, type PatchablePrototype } from "./prototype-patch.js";
import type { CleanModeConfig, CleanModeState } from "./types.js";

/** 收起态的箭头，提示点击后展开。 */
const COLLAPSED_CHEVRON = "▸";
/** 展开态的箭头，提示点击后收起。 */
const EXPANDED_CHEVRON = "▾";
/** 运行级折叠头左侧缩进。 */
const RUN_HEADER_INDENT = "  ";
/** 运行级折叠头里箭头与正文之间的间距。 */
const RUN_HEADER_GAP = "  ";
/** 右侧快捷提示与正文之间至少留的空格数。 */
const HINT_MIN_GAP = 1;
/** 动作组头缩进：比运行级折叠头低一级，形成树形视觉。 */
const ACTION_GROUP_INDENT = "   ";
/** 折叠头之前的空行，用于与上方消息留出间距；下方间距由内容容器自带的 Spacer 提供。 */
const HEADER_LEADING_BLANK = "";
/** 折叠头子组件在实例上的缓存键。 */
const HEADER_CHILD_KEY: unique symbol = Symbol("piCleanModeHeaderChild");
/** 标记该实例是否已判定过本轮折叠头归属。 */
const RUN_HEADER_OWNERSHIP_RESOLVED_KEY: unique symbol = Symbol("piCleanModeRunHeaderResolved");
/** 标记该实例是否为本轮折叠头的承载者。 */
const RUN_HEADER_OWNER_KEY: unique symbol = Symbol("piCleanModeRunHeaderOwner");

/** assistant 组件对外可见的最小结构。 */
interface AssistantMessageHost {
	/** Pi 在 updateContent 里写入：该消息是否包含 tool call。 */
	hasToolCalls?: boolean;
	/** Pi 保存的最近一条消息对象，折叠头靠它查回所属那一轮的耗时。 */
	lastMessage?: unknown;
	/** 内容容器；折叠头插在它的 children 首位。 */
	contentContainer?: { children: Component[] };
	/** Pi 的 Container 用它做鼠标命中：每个子组件占几行。由本文件的收起态接管。 */
	mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };
	render(width: number): string[];
	updateContent(message: unknown, isStreaming?: boolean): void;
	/** 折叠头子组件的实例级缓存。 */
	[HEADER_CHILD_KEY]?: Component;
	/** 归属是否已判定。 */
	[RUN_HEADER_OWNERSHIP_RESOLVED_KEY]?: boolean;
	/** 是否为本轮折叠头的承载者。 */
	[RUN_HEADER_OWNER_KEY]?: boolean;
}

/** 工具行组件对外可见的最小结构。 */
interface ToolMessageHost {
	/** Pi 在构造时写入的工具调用 id。 */
	toolCallId?: string;
	render(width: number): string[];
	handleMouse(event: TuiMouseEvent): unknown;
}

/** 一个工具行所属动作组的快照，供补丁层做渲染决策。 */
export interface ToolRowGroupInfo {
	/** 该工具调用在组内的归属。 */
	membership: ActionGroupMembership;
	/** 组内成员总数。 */
	groupSize: number;
	/** 组是否已展开。 */
	groupExpanded: boolean;
	/** 组内只有一条时用来当组头文案的动作摘要（例如「运行命令 ls -la」）。 */
	summary?: string;
}

/** assistant 组件的 render 方法签名。 */
type AssistantRenderMethod = (this: AssistantMessageHost, width: number) => string[];
/** assistant 组件的 updateContent 方法签名。 */
type AssistantUpdateMethod = (
	this: AssistantMessageHost,
	message: unknown,
	isStreaming?: boolean,
) => void;
/** 工具行组件的 render 方法签名。 */
type ToolRenderMethod = (this: ToolMessageHost, width: number) => string[];
/** 工具行组件的 handleMouse 方法签名。 */
type ToolMouseHandler = (this: ToolMessageHost, event: TuiMouseEvent) => unknown;

/** 补丁层从扩展入口注入的依赖。 */
export interface ComponentPatchDeps {
	/** 读取当前折叠状态。 */
	getState: () => CleanModeState;
	/** 读取当前配置。 */
	getConfig: () => CleanModeConfig;
	/** 折叠头着色能力：横条、标签、强调色。 */
	styler: HeaderStyler;
	/** 鼠标点击折叠头时切换折叠状态。 */
	onToggle: () => void;
	/** 查询某个工具调用所属的动作组；未登记时返回 undefined。 */
	getToolRowGroup: (toolCallId: string) => ToolRowGroupInfo | undefined;
	/** 切换某个动作组的展开状态。 */
	onToggleActionGroup: (groupId: number) => void;
	/** 认领本轮折叠头归属；只有第一条 assistant 消息会得到 true。 */
	claimRunHeaderHost: (host: object) => boolean;
	/** 该承载者是否就是当前「正在运行」那一轮的承载者。 */
	isCurrentRunHost: (host: object) => boolean;
	/** 当前要展示在轮首的实时活动行；空数组表示不展示。 */
	getActivityLines: () => string[];
	/** 查询某个承载者所属那一轮的耗时。 */
	getRunDuration: (host: object) => number | undefined;
	/** 查询某个承载者所属那一轮的工具调用数。 */
	getRunSteps: (host: object) => number | undefined;
	/** 右侧展示的展开快捷键文案（例如 `f2`）。 */
	expandHint: string;
}

/** 把 Pi 的 hasToolCalls 映射成业务分类；映射规则见本文件顶部说明。 */
function classifyAssistantMessage(hasToolCalls: boolean): AssistantMessageKind {
	return hasToolCalls ? "work" : "final";
}

/**
 * 组装运行级折叠头。「用时」在左，展开快捷键右对齐，整行铺底色成一条横带。
 *
 * 底色是这级折叠头的主要识别信号：正文从不铺底色，所以一眼就能看出「这里收了一整轮」。
 */
function buildRunHeaderLine(
	host: AssistantMessageHost,
	deps: ComponentPatchDeps,
	width: number,
): string {
	const duration = formatDuration(deps.getRunDuration(host) ?? 0);
	const chevron = deps.getState().collapsed ? COLLAPSED_CHEVRON : EXPANDED_CHEVRON;
	const left = [
		RUN_HEADER_INDENT,
		deps.styler.accent(chevron),
		RUN_HEADER_GAP,
		deps.styler.primary(i18n.t("runHeader", { duration })),
		" ",
		deps.styler.muted(i18n.t("runHeaderSteps", { count: String(deps.getRunSteps(host) ?? 0) })),
	].join("");

	const hint = deps.getConfig().showExpandHint ? deps.styler.muted(deps.expandHint) : "";
	const line = hint ? alignRightHint(left, hint, width) : left;
	return deps.styler.band(line, width);
}

/** 把右对齐的提示接在正文后面，至少留一格间距；超宽由横条自己截断。 */
function alignRightHint(left: string, hint: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(hint);
	return `${left}${" ".repeat(Math.max(HINT_MIN_GAP, gap))}${hint}`;
}

/**
 * 创建折叠头子组件。
 *
 * 它占着「整轮最上面」这个槽位，两块内容共用：
 * - 运行中：实时活动行（现在在做什么），耗时还不知道，所以折叠头不显示；
 * - 运行结束：活动行被清空，同一个位置换成「用时 Ns」横条。
 *
 * 两者不会同时出现：耗时在 agent_settled 里才写入，写完活动行立刻被清空。
 * 只有当前正在运行那一轮的承载者才输出活动行，否则同一块活动行会在每个带折叠头的
 * 历史轮次里重复出现。
 */
function createRunHeaderComponent(
	host: AssistantMessageHost,
	deps: ComponentPatchDeps,
): Component {
	const content: Component = {
		/** 轮首槽位：运行中只有活动行，已结束时只有耗时横条。 */
		render: (width: number): string[] => {
			const activity = deps.isCurrentRunHost(host) ? deps.getActivityLines() : [];
			if (activity.length > 0) {
				// 活动行非空就意味着这一轮还在跑，耗时还没写入，不可能同时要画横条。
				return [HEADER_LEADING_BLANK, ...activity];
			}

			const decision = resolveRunHeader({
				config: deps.getConfig(),
				durationMs: deps.getRunDuration(host),
				collapsed: deps.getState().collapsed,
			});
			return decision.visible ? [HEADER_LEADING_BLANK, buildRunHeaderLine(host, deps, width)] : [];
		},
		/** 无缓存状态，渲染时实时读取当前折叠状态与活动行。 */
		invalidate: () => {},
	};

	// 包一层 MouseRegion：左键点击折叠头即切换折叠状态。
	return new MouseRegion(content, (event) => {
		if (event.type !== "click" || event.button !== "left") {
			return undefined;
		}
		deps.onToggle();
		return { handled: true };
	});
}

/** 取出或创建该实例的折叠头子组件。 */
function getOrCreateRunHeader(host: AssistantMessageHost, deps: ComponentPatchDeps): Component {
	host[HEADER_CHILD_KEY] ??= createRunHeaderComponent(host, deps);
	return host[HEADER_CHILD_KEY];
}

/**
 * 收起态下的折叠头渲染。
 *
 * 除了输出两行折叠头，还负责把鼠标高度表写成「只有折叠头」：Container 在 render 里
 * 登记每个子组件的高度，鼠标命中靠这份表把屏幕坐标换算到子组件。收起态只输出折叠头，
 * 高度表也就只能有折叠头 —— 否则会沿用上一帧的旧表（那一帧折叠头还没出现，高度记的
 * 是 0），点击被派发到正文子容器上，表现为「点了没反应」。
 *
 * 这里刻意不跑一遍容器渲染去刷新高度表：那会把每条已收起消息的正文（markdown）每帧
 * 重渲一次再丢掉，长会话下明显卡顿。收起态实际只输出折叠头，直接写这份表等价且是
 * 常数开销。
 */
function renderCollapsedHeader(
	host: AssistantMessageHost,
	width: number,
	deps: ComponentPatchDeps,
): string[] {
	const header = getOrCreateRunHeader(host, deps);
	const headerLines = header.render(width);
	host.mouseLayout = { width, children: [{ component: header, height: headerLines.length }] };
	return headerLines;
}

/**
 * 包装 assistant 消息的 render。
 *
 * 折叠头在展开态由内容容器里的子组件渲染；折叠态下如果本体内容被隐藏，就只
 * 直接输出子组件的行，保证折叠头不会随内容一起消失。
 */
function buildAssistantMessageRender(
	deps: ComponentPatchDeps,
	originalRender: (this: AssistantMessageHost, width: number) => string[],
): (this: AssistantMessageHost, width: number) => string[] {
	return function patchedAssistantMessageRender(this: AssistantMessageHost, width: number) {
		const decision = resolveAssistantMessageRender({
			state: deps.getState(),
			config: deps.getConfig(),
			kind: classifyAssistantMessage(this.hasToolCalls === true),
			isRunHeaderHost: this[RUN_HEADER_OWNER_KEY] === true,
			durationMs: deps.getRunDuration(this),
		});

		if (!decision.hideContent) {
			return originalRender.call(this, width);
		}

		if (!decision.showHeader) {
			return [];
		}

		return renderCollapsedHeader(this, width, deps);
	};
}

/** 内容块类型标识：thinking。 */
const CONTENT_TYPE_THINKING = "thinking";

/** 判断输入是否为可按键读取的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 按配置决定交给 Pi 渲染的消息。
 *
 * 开启 hideThinking 时先把 thinking 内容块整个抽掉，而不是用 Pi 自己的
 * `hideThinkingBlock` 开关：那个开关会把 thinking 渲染成一行占位文本，即使把占位
 * 文案清空也会留下一个空行和它后面的 Spacer（实测确认），而抽掉内容块连这两行
 * 一起消失。返回浅拷贝，原消息对象不动。
 */
function resolveRenderedMessage(message: unknown, deps: ComponentPatchDeps): unknown {
	const { enabled, hideThinking } = deps.getConfig();
	if (!enabled || !hideThinking || !isRecord(message) || !Array.isArray(message.content)) {
		return message;
	}

	const content = message.content.filter(
		(block) => !isRecord(block) || block.type !== CONTENT_TYPE_THINKING,
	);
	return content.length === message.content.length ? message : { ...message, content };
}

/**
 * 包装 assistant 消息的 updateContent。
 *
 * 原始实现会清空并重建内容容器，因此这里在它之后：
 * 1. 首次遇到本实例时问一次「本轮折叠头归谁」，第一条 assistant 消息成为承载者；
 * 2. 承载者把折叠头子组件插到 children 首位，使它在展开态也排在最前面。
 * 非承载者不插折叠头。
 */
function buildAssistantMessageUpdateContent(
	deps: ComponentPatchDeps,
	originalUpdateContent: (
		this: AssistantMessageHost,
		message: unknown,
		isStreaming?: boolean,
	) => void,
): (this: AssistantMessageHost, message: unknown, isStreaming?: boolean) => void {
	return function patchedAssistantMessageUpdateContent(
		this: AssistantMessageHost,
		message: unknown,
		isStreaming?: boolean,
	) {
		// 必须在原始实现之前处理：它会在这次调用里重建正文子组件。
		const rendered = resolveRenderedMessage(message, deps);
		originalUpdateContent.call(this, rendered, isStreaming);
		if (rendered !== message) {
			// 把原始消息留在实例上：Pi 后续任何一次重建（主题、设置变化）仍会走本补丁，
			// 再抽一次 thinking 即可；留着被抽过的副本反而会让重建结果和原始消息不一致。
			this.lastMessage = message;
		}

		if (this[RUN_HEADER_OWNERSHIP_RESOLVED_KEY] !== true) {
			this[RUN_HEADER_OWNERSHIP_RESOLVED_KEY] = true;
			this[RUN_HEADER_OWNER_KEY] = deps.claimRunHeaderHost(this);
		}

		if (this[RUN_HEADER_OWNER_KEY] !== true) {
			return;
		}

		const container = this.contentContainer;
		if (!container) {
			return;
		}

		// 折叠头组件占整轮最上面：它内部再决定画活动行还是耗时横条。
		container.children.unshift(getOrCreateRunHeader(this, deps));
	};
}

/** 取一个工具行的动作组快照；未登记或无 toolCallId 时返回 undefined。 */
function getGroupInfo(
	host: ToolMessageHost,
	deps: ComponentPatchDeps,
): ToolRowGroupInfo | undefined {
	if (typeof host.toolCallId !== "string") {
		return undefined;
	}
	return deps.getToolRowGroup(host.toolCallId);
}

/** 判断该工具行当前是否正在充当动作组组头。 */
function isGroupHeaderRow(host: ToolMessageHost, deps: ComponentPatchDeps): boolean {
	const group = getGroupInfo(host, deps);
	return resolveToolRowMode({
		state: deps.getState(),
		config: deps.getConfig(),
		membership: group?.membership,
		groupSize: group?.groupSize ?? 0,
		groupExpanded: group?.groupExpanded ?? false,
	}) === TOOL_ROW_GROUP_HEADER;
}

/** 组头前的空行，与普通工具行前面的 Spacer 保持一致。 */
const ACTION_GROUP_HEADER_BLANK = "";

/**
 * 组装收起的动作组头。
 *
 * 组内只有一条时直接用这条动作的摘要（「▸ 运行命令 ls -la」），这样才能既收起原始
 * 输出又不丢失「刚才做了什么」；两条以上才汇总成「▸ 探索 · N 步」。逐字包一层底色
 * 标签，让它比正文重、比运行级横条轻。
 */
function buildActionGroupHeaderLines(
	group: ToolRowGroupInfo,
	deps: ComponentPatchDeps,
): string[] {
	const countLabel = i18n.t("actionGroupHeader", { count: String(group.groupSize) });
	const label = group.groupSize > 1 ? countLabel : (group.summary ?? countLabel);
	const chevron = group.groupExpanded ? EXPANDED_CHEVRON : COLLAPSED_CHEVRON;
	const header = `${ACTION_GROUP_INDENT}${deps.styler.accent(chevron)} ${deps.styler.chip(label)}`;
	return [ACTION_GROUP_HEADER_BLANK, header];
}

/** 调试日志作用域：工具行渲染决策。 */
const DEBUG_SCOPE_TOOL_RENDER = "tool render";
/** 未知工具调用 id 与未知组号的占位符。 */
const DEBUG_UNKNOWN = "-";

/** 描述一条工具行的渲染决策，供调试日志使用。 */
function describeToolRow(
	host: ToolMessageHost,
	group: ToolRowGroupInfo | undefined,
	mode: string,
): string {
	const toolCallId = host.toolCallId ?? DEBUG_UNKNOWN;
	const groupId = group?.membership.groupId ?? DEBUG_UNKNOWN;
	return `${toolCallId} ${mode} group=${groupId} size=${group?.groupSize ?? 0}`;
}

/**
 * 包装工具行的 render。
 *
 * 三种去向：运行级折叠时整行隐藏；多条成员的组在收起时只留首行充当组头；
 * 其余情况（含组内只有一条）直接交给 Pi 原本的渲染。
 */
function buildToolMessageRender(
	deps: ComponentPatchDeps,
	originalRender: (this: ToolMessageHost, width: number) => string[],
): (this: ToolMessageHost, width: number) => string[] {
	return function patchedToolMessageRender(this: ToolMessageHost, width: number) {
		const group = getGroupInfo(this, deps);
		const mode = resolveToolRowMode({
			state: deps.getState(),
			config: deps.getConfig(),
			membership: group?.membership,
			groupSize: group?.groupSize ?? 0,
			groupExpanded: group?.groupExpanded ?? false,
		});

		debugLog(DEBUG_SCOPE_TOOL_RENDER, describeToolRow(this, group, mode));

		if (mode === TOOL_ROW_HIDDEN) {
			return [];
		}
		if (mode === TOOL_ROW_GROUP_HEADER && group) {
			const headerLines = buildActionGroupHeaderLines(group, deps);
			if (!group.groupExpanded) {
				return headerLines;
			}
			return [...headerLines, ...originalRender.call(this, width)];
		}
		return originalRender.call(this, width);
	};
}

/**
 * 包装工具行的 handleMouse。
 *
 * 组头行上的左键点击用来展开/收起该动作组，不再交给 Pi 的单行输出展开。
 * 非组头行一律透传，保留 Pi 原有的点击展开行为。
 */
function buildToolMessageHandleMouse(
	deps: ComponentPatchDeps,
	originalHandleMouse: (this: ToolMessageHost, event: TuiMouseEvent) => unknown,
): (this: ToolMessageHost, event: TuiMouseEvent) => unknown {
	return function patchedToolMessageHandleMouse(this: ToolMessageHost, event: TuiMouseEvent) {
		const group = getGroupInfo(this, deps);
		if (group && isGroupHeaderRow(this, deps)) {
			if (event.type === "click" && event.button === "left") {
				deps.onToggleActionGroup(group.membership.groupId);
				return { handled: true };
			}
			return undefined;
		}
		return originalHandleMouse.call(this, event);
	};
}

/**
 * 安装 assistant 消息与工具行的渲染补丁。
 *
 * 返回还原函数，供 reload / shutdown 使用；重复调用是幂等的。
 * 原始方法在调用点按具体类型读出并传入，因此不需要在补丁骨架里做类型断言。
 */
export function installComponentPatches(deps: ComponentPatchDeps): () => void {
	const assistantPrototype: PatchablePrototype = AssistantMessageComponent.prototype;

	const restoreAssistantRender = installMethodPatch<AssistantRenderMethod>({
		prototype: assistantPrototype,
		methodName: "render",
		currentMethod: AssistantMessageComponent.prototype.render,
		buildMethod: (originalRender) => buildAssistantMessageRender(deps, originalRender),
	});
	const restoreAssistantUpdate = installMethodPatch<AssistantUpdateMethod>({
		prototype: assistantPrototype,
		methodName: "updateContent",
		currentMethod: AssistantMessageComponent.prototype.updateContent,
		buildMethod: (originalUpdate) => buildAssistantMessageUpdateContent(deps, originalUpdate),
	});
	const restoreTool = installMethodPatch<ToolRenderMethod>({
		prototype: ToolExecutionComponent.prototype,
		methodName: "render",
		currentMethod: ToolExecutionComponent.prototype.render,
		buildMethod: (originalRender) => buildToolMessageRender(deps, originalRender),
	});
	const restoreToolMouse = installMethodPatch<ToolMouseHandler>({
		prototype: ToolExecutionComponent.prototype,
		methodName: "handleMouse",
		currentMethod: ToolExecutionComponent.prototype.handleMouse,
		buildMethod: (originalHandleMouse) => buildToolMessageHandleMouse(deps, originalHandleMouse),
	});

	return () => {
		restoreToolMouse();
		restoreTool();
		restoreAssistantUpdate();
		restoreAssistantRender();
	};
}
