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
import { MouseRegion, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderTreePrefix } from "./activity.js";
import {
	TOOL_ROW_GROUP_HEADER,
	TOOL_ROW_HIDDEN,
	TOOL_ROW_SUMMARY,
	type ActionGroupMembership,
} from "./action-groups.js";
import { formatDuration } from "./duration.js";
import { debugLog } from "./debug-logger.js";
import type { HeaderStyler } from "./header-style.js";
import { GROUP_GUTTER, GUTTER_GAP, RUN_GUTTER } from "./header-style.js";
import { i18n } from "./i18n.js";
import {
	resolveAssistantMessageRender,
	resolveRunHeader,
	resolveToolRowMode,
	type AssistantMessageKind,
} from "./render-policy.js";
import { installMethodPatch, type PatchablePrototype } from "./prototype-patch.js";
import type { CleanModeConfig, CleanModeState } from "./types.js";

/** 收起态的箭头：实心右三角，提示点击后展开。 */
const COLLAPSED_CHEVRON = "▶";
/** 展开态的箭头：实心下三角，提示点击后收起。 */
const EXPANDED_CHEVRON = "▼";
/** 折叠头文案与箭头之间的间距。 */
const ARROW_GAP = " ";
/** 文本被截断时的省略号。 */
const TRUNCATION_ELLIPSIS = "…";
/** 折叠头之前的空行，用于与上方消息留出间距；下方间距由内容容器自带的 Spacer 提供。 */
const HEADER_LEADING_BLANK = "";
/** 折叠头子组件在实例上的缓存键。 */
const HEADER_CHILD_KEY: unique symbol = Symbol("piCleanModeHeaderChild");
/** 标记该实例是否已判定过本轮折叠头归属。 */
const RUN_HEADER_OWNERSHIP_RESOLVED_KEY: unique symbol = Symbol("piCleanModeRunHeaderResolved");
/** 标记该实例是否为本轮折叠头的承载者。 */
const RUN_HEADER_OWNER_KEY: unique symbol = Symbol("piCleanModeRunHeaderOwner");
/** 工具行箭头所在的行号（相对整个组件），由渲染记录、鼠标命中使用。 */
const TOOL_ROW_ARROW_ROW_KEY: unique symbol = Symbol("piCleanModeToolRowArrowRow");
/**
 * 组头块占的行数（前导空行 + 组头行）；0 表示这一行没有组头。
 *
 * 鼠标命中先看它：组头块里的点击是「收起/展开整组」，不能当成员行处理。
 */
const TOOL_ROW_HEADER_HEIGHT_KEY: unique symbol = Symbol("piCleanModeToolRowHeaderHeight");
/**
 * 本行命令摘要所在行号；没有摘要行（组头、未登记的行）时为 undefined。
 *
 * 整行可点：点摘要行就是「看这一条的原文」，展开后再点同一行收回单行。
 */
const TOOL_ROW_SUMMARY_ROW_KEY: unique symbol = Symbol("piCleanModeToolRowSummaryRow");
/**
 * 这一行是否已展开原文（只对展开的组里的成员行有意义）。
 *
 * 与 Pi 自己的 `expanded` 分开存：后者是「这条工具的输出要不要铺全」，
 * 前者是「这一条的命令原文要不要露出来」，点两处得到的效果不同。
 */
const TOOL_ROW_REVEALED_KEY: unique symbol = Symbol("piCleanModeToolRowRevealed");
/**
 * 工具行正文（Pi 自己那几行）相对组件顶部的行偏移。
 *
 * 我们会在工具行前面拼上组头与摘要行，容器登记的高度表却是按 Pi 原本的正文
 * 算的，所以鼠标透传前要先减掉这个偏移，否则点哪都差几行。
 */
const TOOL_ROW_BODY_OFFSET_KEY: unique symbol = Symbol("piCleanModeToolRowBodyOffset");
/** 没有组头、也没有摘要行时的正文偏移。 */
const NO_BODY_OFFSET = 0;
/** 一条命令摘要行占的行数。 */
const SUMMARY_ROW_HEIGHT = 1;

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
	/** Pi 在构造时写入的工具名；动作摘要缺失时用它兜底。 */
	toolName?: string;
	/** Pi 记录的工具输出展开状态；工具行箭头靠它决定朝向。 */
	expanded?: boolean;
	/** Pi 的展开开关；点工具行箭头时调它。 */
	setExpanded?(expanded: boolean): void;
	/** 箭头所在行号；渲染时写入，鼠标命中时读取。 */
	[TOOL_ROW_ARROW_ROW_KEY]?: number;
	/** 组头块占的行数；渲染时写入，鼠标命中时读取。 */
	[TOOL_ROW_HEADER_HEIGHT_KEY]?: number;
	/** 命令摘要行号；渲染时写入，鼠标命中时读取。 */
	[TOOL_ROW_SUMMARY_ROW_KEY]?: number;
	/** 这条命令的原文是否已展开。 */
	[TOOL_ROW_REVEALED_KEY]?: boolean;
	/** 工具行正文的行偏移；渲染时写入，鼠标透传前用它换算坐标。 */
	[TOOL_ROW_BODY_OFFSET_KEY]?: number;
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
	/** 请求重绘：成员行的「看原文」状态是行内状态，改完得让屏幕重画。 */
	requestRender: () => void;
	/** 认领本轮折叠头归属；只有第一条 assistant 消息会得到 true。 */
	claimRunHeaderHost: (host: object) => boolean;
	/** 该承载者是否就是当前「正在运行」那一轮的承载者。 */
	isCurrentRunHost: (host: object) => boolean;
	/**
	 * 当前组的活动块：思考行与正在跑的动作行，行首带 `├─` / `└─` 竖折，不铺底色；
	 * 空数组表示不展示。接在当前组最后一条可见行的下面。
	 */
	getActivityLines: () => string[];
	/**
	 * 活动块里去掉动作名后的形态：思考行与输出尾巴，竖折前缀已按剩下的行重拼。
	 *
	 * 组内只有一条时组头就是这条动作的摘要（`运行命令 npm test ▶`），活动块再列一次
	 * 就变成同一句话出现两次 —— 那种情况用这个形态，动作名让给组头说。
	 */
	getActivityDetailLines: () => string[];
	/**
	 * 轮首槽位要展示的状态行：只含「在处理 + 跑了多久」，最多一行。
	 *
	 * 轮首只承担「整轮一共跑了多久」；思考、正在跑什么、分类计数都属于最新动作那一头，
	 * 两块内容分开取，顶部就不会再出现一份细节。
	 */
	getRunStatusLines: () => string[];
	/**
	 * 某个动作组是不是当前 turn 的组。
	 *
	 * 活动块接在当前组的最后一条可见行下面（而不是挂在整轮最上面），所以它总是紧跟在
	 * 最新动作旁边；靠组号区分当前组，历史组不会再显示一遍活动行。
	 * 分类计数也挂在活动块上，所以这个判断同时保证了「计数只报当前组」。
	 */
	isCurrentActionGroup: (groupId: number) => boolean;
	/**
	 * 取某个动作组的组头主词（如「运行命令」）；组内没有过半分类时返回 undefined，
	 * 组头退回通用词「探索 · N 步」。历史组也带自己的分类，所以不依赖「当前组」判断。
	 */
	getGroupActivityLabel: (groupId: number) => string | undefined;
	/** 查询某个承载者所属那一轮的耗时。 */
	getRunDuration: (host: object) => number | undefined;
	/** 查询某个承载者所属那一轮的工具调用数。 */
	getRunSteps: (host: object) => number | undefined;
}

/** 把 Pi 的 hasToolCalls 映射成业务分类；映射规则见本文件顶部说明。 */
function classifyAssistantMessage(hasToolCalls: boolean): AssistantMessageKind {
	return hasToolCalls ? "work" : "final";
}

/**
 * 组装运行级折叠头。「用时」在左，箭头紧随其后。
 *
 * 行首是粗竖条 `▌`（加粗 + 主文字色），整条左侧轨道最强的一档：正文从不画竖条，
 * 所以一眼就能看出「这里收了一整轮」。
 */
function buildRunHeaderLine(
	host: AssistantMessageHost,
	deps: ComponentPatchDeps,
): string {
	const duration = formatDuration(deps.getRunDuration(host) ?? 0);
	const chevron = deps.getState().collapsed ? COLLAPSED_CHEVRON : EXPANDED_CHEVRON;
	// 箭头紧跟在文案右边：先看到「这一轮用了多久」，紧接着就知道这行能点开。
	return [
		deps.styler.bold(deps.styler.primary(RUN_GUTTER)),
		GUTTER_GAP,
		deps.styler.bold(deps.styler.primary(i18n.t("runHeader", { duration }))),
		" ",
		deps.styler.muted(i18n.t("runHeaderSteps", { count: String(deps.getRunSteps(host) ?? 0) })),
		ARROW_GAP,
		deps.styler.accent(chevron),
	].join("");
}

/**
 * 创建轮首子组件。
 *
 * 它占着「整轮最上面」这个槽位，两块内容共用：
 * - 运行中：轮首状态行（在处理 + 耗时）—— 收起态也照常输出，它是「还在跑」的唯一凭据；
 * - 运行结束：活动行被清空，同一个位置换成「用时 Ns」横条。
 *
 * 两者不会同时出现：耗时在 agent_settled 里才写入，写完活动行立刻被清空。
 * 只有当前那一轮的承载者才输出状态行，否则同一块活动行会在每个带折叠头的
 * 历史轮次里重复出现；耗时横条按承载者自己那一轮的耗时画，所以历史轮次也保留。
 * 槽位本身是否输出由 `resolveAssistantMessageRender` 决定，它不依赖耗时。
 */
function createRunHeaderComponent(
	host: AssistantMessageHost,
	deps: ComponentPatchDeps,
): Component {
	const content: Component = {
		/** 轮首槽位：运行中只画整轮时间，已结束时只画耗时头。 */
		render: (width: number): string[] => {
			// 轮首只回答「整轮一共跑了多久」：运行中是状态行（在处理 + 耗时），
			// 结束后是「用时 N 步」。活动块不在顶部，它接在最新动作的下面。
			const status = deps.isCurrentRunHost(host) ? deps.getRunStatusLines() : [];
			if (status.length > 0) {
				// 状态行非空就意味着这一轮还在跑，耗时还没写入，不可能同时要画耗时头。
				// 状态行与耗时头同列同款（都是 `▌ + 文案`），所以这里不用再包装一层。
				return [HEADER_LEADING_BLANK, ...status];
			}

			const decision = resolveRunHeader({
				config: deps.getConfig(),
				durationMs: deps.getRunDuration(host),
				collapsed: deps.getState().collapsed,
			});
			return decision.visible ? [HEADER_LEADING_BLANK, buildRunHeaderLine(host, deps)] : [];
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
 * 槽位里的内容可能为空（历史轮次既没有耗时也没有运行状态），此时输出 0 行、高度记 0，
 * 既不会留下可点的幽灵热区，也不丢「正文隐藏」这个语义。
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

/** 超过这个成员数才用「探索 · N 步」汇总文案；只有一条时直接用该动作的摘要。 */
const MIN_GROUP_SIZE_FOR_SUMMARY = 2;

/**
 * 多条组的组头文案：组内有一类动作过半就用它命名（`运行命令 · 12 步`）。
 *
 * 没有过半的分类时退回通用词（`探索 · 7 步`）：一类只多出一条却说成「读取文件 · 8 步」
 * 是误导，不如不报。
 */
function buildSummaryLabel(group: ToolRowGroupInfo, deps: ComponentPatchDeps): string {
	const count = String(group.groupSize);
	const activity = deps.getGroupActivityLabel(group.membership.groupId);
	return activity === undefined
		? i18n.t("actionGroupHeader", { count })
		: i18n.t("actionGroupSteps", { label: activity, count });
}

/**
 * 组装收起的动作组头。
 *
 * 组内只有一条时直接用这条动作的摘要（「运行命令 ls -la」），这样才能既收起原始
 * 输出又不丢失「刚才做了什么」；两条以上才汇总成「主词 · N 步」。
 *
 * 行首是细竖条 `│`（弱化色），与运行级粗竖条同列，构成一条连续的左侧轨道；
 * 层级在这里靠竖直的粗细与色档区分，而不是底色块。
 *
 * 分类计数不在这里：它跟着活动块走作为尾注，免得组头、活动块、轮首三处都在报进度。
 */
function buildActionGroupHeaderRow(group: ToolRowGroupInfo, deps: ComponentPatchDeps): string {
	const showsStepCount = group.groupSize >= MIN_GROUP_SIZE_FOR_SUMMARY;
	const label = showsStepCount
		? buildSummaryLabel(group, deps)
		: (group.summary ?? i18n.t("actionGroupHeader", { count: String(group.groupSize) }));
	const chevron = group.groupExpanded ? EXPANDED_CHEVRON : COLLAPSED_CHEVRON;
	return [
		deps.styler.muted(GROUP_GUTTER),
		GUTTER_GAP,
		label,
		ARROW_GAP,
		deps.styler.accent(chevron),
	].join("");
}

/**
 * 组装收起的动作组头（前导空行 + 组头行）。
 */
function buildActionGroupHeaderLines(
	group: ToolRowGroupInfo,
	deps: ComponentPatchDeps,
): string[] {
	return [ACTION_GROUP_HEADER_BLANK, buildActionGroupHeaderRow(group, deps)];
}

/** 组装成员命令摘要行所需的输入。 */
interface ToolRowRenderInput {
	/** 该成员行的组件实例（读它的原文展开状态）。 */
	host: ToolMessageHost;
	/** 该成员所属的动作组。 */
	group: ToolRowGroupInfo;
	/** 补丁层依赖。 */
	deps: ComponentPatchDeps;
	/** 当前渲染宽度。 */
	width: number;
	/** Pi 原本的 render；铺成员原文时调它。 */
	originalRender: (this: ToolMessageHost, width: number) => string[];
}

/**
 * 组装展开的组里一条成员命令的摘要行：`  ├─ 读取 src/index.ts ▶`。
 *
 * 组展开后成员不再直接铺原始输出，而是一条命令一行——一屏能看完整组跑过哪些命令，
 * 要看哪条的原文再点哪条；否则一屏装不下几条，组里跑了多少、还剩哪些没看都看不出来。
 *
 * 分支符与活动块的思考行共用（`renderTreePrefix`），两者才是同一棵树里的兄弟项：
 * 思考行接在列表最后，所以它在时末位成员用 `├─`、思考行自己用 `└─` 收口。
 */
function buildToolSummaryLine({ host, group, deps, width }: ToolRowRenderInput): string {
	const isLast =
		isLastVisibleRow(group) && resolveActivityTail(group, deps, width).length === 0;
	const revealed = host[TOOL_ROW_REVEALED_KEY] === true;
	const arrow = revealed ? EXPANDED_CHEVRON : COLLAPSED_CHEVRON;
	const prefix = renderTreePrefix(isLast, (branch) => deps.styler.dim(branch));
	const summary = group.summary ?? host.toolName ?? "";
	// 先把摘要截到「行宽减去前缀与箭头」，否则长命令会把箭头挤出屏幕。
	const textWidth = Math.max(
		0,
		width - visibleWidth(prefix) - visibleWidth(ARROW_GAP) - visibleWidth(arrow),
	);
	const text = truncateToWidth(summary, textWidth, TRUNCATION_ELLIPSIS);
	const line = `${prefix}${text}${ARROW_GAP}${deps.styler.accent(arrow)}`;
	// 宽度小到连前缀都放不下时，宁可丢掉箭头也不能撑破布局。
	return visibleWidth(line) > width ? truncateToWidth(line, width, TRUNCATION_ELLIPSIS) : line;
}

/**
 * 这一行是不是它所在组的「最后一条可见行」。
 *
 * 展开的组里最后一条可见行是末位成员（组头在最上面，不算尾），收起时成员行整行隐藏，
 * 组头是该组唯一可见的行。活动块只接在这个位置上，最新状态才总是落在列表最底下。
 */
function isLastVisibleRow(group: ToolRowGroupInfo): boolean {
	const lastVisibleIndex = group.groupExpanded ? group.groupSize - 1 : 0;
	return group.membership.index === lastVisibleIndex;
}

/**
 * 取当前组要接在末位可见行下面的活动块（按实际宽度截断）。
 *
 * 组收起时组头只写了汇总文案（`探索 · 12 步`），没说清具体在跑什么，活动块带上动作名；
 * 组展开时命令已经逐条列在列表上，动作名不再重复第二遍（只留思考与输出尾巴）。
 *
 * 历史组、没有内容时返回空数组。
 */
function resolveActivityTail(
	group: ToolRowGroupInfo,
	deps: ComponentPatchDeps,
	width: number,
): string[] {
	if (!deps.isCurrentActionGroup(group.membership.groupId)) {
		return [];
	}

	const showsActionName = !group.groupExpanded && group.groupSize >= MIN_GROUP_SIZE_FOR_SUMMARY;
	const lines = showsActionName ? deps.getActivityLines() : deps.getActivityDetailLines();
	return clampLinesToWidth(lines, width);
}

/**
 * 把行截到实际渲染宽度。
 *
 * 活动行的长度由内容决定（文本片段自己只限制了 110 列），窄一点的终端上会超宽：
 * 主屏模式下 pi-tui 遇到超宽行直接抛错停机，全屏模式下则被硬切掉。
 */
function clampLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) =>
		visibleWidth(line) > width ? truncateToWidth(line, width, TRUNCATION_ELLIPSIS) : line,
	);
}

/** `appendActivityTail` 需要的输入。 */
interface ActivityTailInput {
	/** 当前工具行所属的组；未登记时为 undefined。 */
	group: ToolRowGroupInfo | undefined;
	/** 补丁层依赖，用于取活动行。 */
	deps: ComponentPatchDeps;
	/** 当前的渲染宽度，用于把活动行截到终端宽度内。 */
	width: number;
}

/**
 * 把活动块接到当前组「最后一条可见行」的下面。
 *
 * 活动块代表最新状态，必须贴在列表最底部（最新那条动作的下方）。插在组头上方时，
 * 展开的组里它下面还压着整组成员行，看上去就悬在中段。
 *
 * 组收起时成员行整行隐藏，组头是该组唯一可见的行，活动块就接在它下面；
 * 非当前组、或这一行不是最后一条可见行时原样返回。
 *
 * 块里全是普通行（思考、动作、输出尾巴），行首带 `├─` / `└─` 竖折，不铺底色：
 * 屏幕上只有轮首那条运行级横条。展开的组里成员行也用同一套竖折，所以思考行是与
 * 命令行平级的兄弟项，而不是挂在中间那条正文底下。
 */
function appendActivityTail(lines: string[], { group, deps, width }: ActivityTailInput): string[] {
	if (!group || !isLastVisibleRow(group)) {
		return lines;
	}

	const activity = resolveActivityTail(group, deps, width);
	return activity.length === 0 ? lines : [...lines, ...activity];
}

/**
 * 工具行右侧「可点击展开」箭头的插入逻辑。
 *
 * 工具行是 Pi 自己的渲染结果（一行铺底色到整宽）。箭头要落在文案右边、且不改变
 * 行宽，所以做法是「把尾部填充空格里的第二个换成箭头」，而不是截掉再拼接。
 */

/** 箭头与文案之间留的间距格数。 */
const TOOL_ROW_ARROW_GAP_SPACES = 1;
/** 箭头上了强调色后立即恢复默认前景色，避免颜色渗到后面的填充空格。 */
const RESET_FOREGROUND = "\u001b[39m";
/** 匹配行内 ANSI CSI 转义序列（宽度计为 0）；带 sticky 标志，从 lastIndex 处原地匹配。 */
const ANSI_CSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/y;

/** 一行里最后一个可见字符之后的位置，以及它后面的空格数。 */
interface LineEndScan {
	/** 可见文字的结束下标（不含末尾空格）。 */
	textEnd: number;
	/** 可见文字之后的空格数（不含 ANSI 转义）。 */
	trailingSpaces: number;
}

/** 扫描一行的结束位置；ANSI 转义不计数。 */
function scanLineEnd(line: string): LineEndScan {
	let index = 0;
	let textEnd = 0;
	let trailingSpaces = 0;

	while (index < line.length) {
		ANSI_CSI_PATTERN.lastIndex = index;
		const escape = ANSI_CSI_PATTERN.exec(line)?.[0];
		if (escape) {
			index += escape.length;
			continue;
		}
		if (line[index] === " ") {
			trailingSpaces += 1;
			index += 1;
			continue;
		}
		index += 1;
		textEnd = index;
		trailingSpaces = 0;
	}

	return { textEnd, trailingSpaces };
}

/**
 * 把箭头插到可见文字的右边；尾部空格不够时原样返回。
 *
 * 箭头的显示宽度可能不是 1 格，所以按宽度取同样数量的尾部空格替换，行宽才不会变。
 */
function insertToolRowArrow(line: string, arrow: string, styler: HeaderStyler): string {
	const { textEnd, trailingSpaces } = scanLineEnd(line);
	const arrowWidth = visibleWidth(arrow);
	if (trailingSpaces < TOOL_ROW_ARROW_GAP_SPACES + arrowWidth) {
		return line;
	}

	// 尾部空格的下标：前 GAP 个当间距，接着 arrowWidth 个拿去放箭头。
	const spaceIndexes: number[] = [];
	for (let index = textEnd; index < line.length; index += 1) {
		if (line[index] === " ") {
			spaceIndexes.push(index);
		}
	}
	// 被箭头替换掉的空格；箭头本身占同样宽度，所以行宽不变。
	const replaced = new Set(
		spaceIndexes.slice(
			TOOL_ROW_ARROW_GAP_SPACES,
			TOOL_ROW_ARROW_GAP_SPACES + arrowWidth,
		),
	);
	// 箭头插在间距空格之后。
	const insertAt = (spaceIndexes[TOOL_ROW_ARROW_GAP_SPACES - 1] ?? textEnd) + 1;
	const arrowText = `${styler.accent(arrow)}${RESET_FOREGROUND}`;

	let out = "";
	for (let index = 0; index < line.length; index += 1) {
		if (index === insertAt) {
			out += arrowText;
		}
		if (!replaced.has(index)) {
			out += line[index];
		}
	}
	return out;
}

/** 给工具行加箭头所需的上下文。 */
interface ToolRowArrowContext {
	/** 折叠头着色能力，箭头要上强调色。 */
	styler: HeaderStyler;
	/** 工具行正文相对组件顶部的行偏移；展开的组会把「空行 + 组头」拼在前面。 */
	bodyOffset: number;
}

/**
 * 给工具行的首行加上「可点击展开」箭头，并记下该行行号供鼠标命中使用。
 *
 * 行号要加上 `bodyOffset` 再存：鼠标事件的 `y` 是相对整个组件的，而这里的行号是
 * 相对 Pi 自己那几行。展开的组会在前面多拼「空行 + 组头」，不补偏移就永远对不上，
 * 点箭头会被当成点组头、把整组收起来。
 */
function withToolRowArrow(
	host: ToolMessageHost,
	lines: string[],
	context: ToolRowArrowContext,
): string[] {
	const rowIndex = lines.findIndex((line) => scanLineEnd(line).textEnd > 0);
	if (rowIndex === -1) {
		host[TOOL_ROW_ARROW_ROW_KEY] = undefined;
		return lines;
	}

	const arrow = host.expanded ? EXPANDED_CHEVRON : COLLAPSED_CHEVRON;
	const patched = [...lines];
	patched[rowIndex] = insertToolRowArrow(lines[rowIndex] ?? "", arrow, context.styler);
	host[TOOL_ROW_ARROW_ROW_KEY] = rowIndex + context.bodyOffset;
	return patched;
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
 * 四种去向：运行级折叠时整行隐藏；组头行（组内第一条，收起态只有它可见）；
 * 展开组里的成员行（一条命令一行，点了才铺原文）；其余情况直接交给 Pi 原本的渲染。
 * 当前组的最后一条可见行还要在末尾接上活动块（思考行与输出尾巴，与命令行平级）。
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
			clearToolRowHitAreas(this);
			return [];
		}

		if (mode === TOOL_ROW_GROUP_HEADER && group) {
			return renderGroupHeaderRow({ host: this, group, deps, width, originalRender });
		}

		if (mode === TOOL_ROW_SUMMARY && group) {
			return renderSummaryRow({ host: this, group, deps, width, originalRender });
		}

		clearToolRowHitAreas(this);
		const rendered = withToolRowArrow(this, originalRender.call(this, width), {
			styler: deps.styler,
			bodyOffset: NO_BODY_OFFSET,
		});
		return appendActivityTail(rendered, { group, deps, width });
	};
}

/** 这一行没有自己的命中区：箭头、组头块与摘要行全部按不存在处理。 */
function clearToolRowHitAreas(host: ToolMessageHost): void {
	host[TOOL_ROW_ARROW_ROW_KEY] = undefined;
	host[TOOL_ROW_HEADER_HEIGHT_KEY] = NO_BODY_OFFSET;
	host[TOOL_ROW_SUMMARY_ROW_KEY] = undefined;
	host[TOOL_ROW_BODY_OFFSET_KEY] = NO_BODY_OFFSET;
}

/**
 * 渲染组头行。
 *
 * 三种形态：
 * - 组收起：只留组头，成员行整行隐藏，活动块接在组头下面；
 * - 多条成员且展开：组头只做汇总（`运行命令 · 12 步`），成员各占一行摘要，
 *   首条成员的摘要行也由这个组件画；
 * - 单条成员且展开：组头本身就是这条动作的摘要，直接在它下面铺这条工具的原文。
 */
function renderGroupHeaderRow(input: ToolRowRenderInput): string[] {
	const { host, group, deps, width, originalRender } = input;
	if (!group.groupExpanded) {
		// 收起时成员行整行隐藏，没有正文可点，命中区归零避免鼠标透传算错行。
		const headerLines = buildActionGroupHeaderLines(group, deps);
		clearToolRowHitAreas(host);
		host[TOOL_ROW_HEADER_HEIGHT_KEY] = headerLines.length;
		return appendActivityTail(headerLines, { group, deps, width });
	}

	const headerLines = buildActionGroupHeaderLines(group, deps);
	host[TOOL_ROW_HEADER_HEIGHT_KEY] = headerLines.length;

	if (group.groupSize >= MIN_GROUP_SIZE_FOR_SUMMARY) {
		const summaryLine = buildToolSummaryLine(input);
		// 首条成员自己的摘要行就在组头下面，所以它的组头块要再高一行。
		host[TOOL_ROW_SUMMARY_ROW_KEY] = headerLines.length;
		host[TOOL_ROW_ARROW_ROW_KEY] = undefined;
		host[TOOL_ROW_BODY_OFFSET_KEY] = headerLines.length + SUMMARY_ROW_HEIGHT;
		return appendActivityTail([...headerLines, summaryLine], { group, deps, width });
	}

	// 单条成员：组头即这条动作的摘要，展开动作组就是看这条的原文。
	const bodyOffset = headerLines.length;
	host[TOOL_ROW_SUMMARY_ROW_KEY] = undefined;
	host[TOOL_ROW_BODY_OFFSET_KEY] = bodyOffset;
	const body = withToolRowArrow(host, originalRender.call(host, width), {
		styler: deps.styler,
		bodyOffset,
	});
	return appendActivityTail([...headerLines, ...body], { group, deps, width });
}

/**
 * 渲染展开的组里一条成员命令：默认只输出一行摘要，这条已看过原文就再铺上原文。
 *
 * 原文用 Pi 自己那一行（它自己的展开状态照旧），我们只在前面补一行摘要并把命中区
 * 记下来：摘要是「看/收起原文」的开关，原文里的点击仍归 Pi。
 */
function renderSummaryRow(input: ToolRowRenderInput): string[] {
	const { host, group, deps, width, originalRender } = input;
	const summaryLine = buildToolSummaryLine(input);
	host[TOOL_ROW_HEADER_HEIGHT_KEY] = NO_BODY_OFFSET;
	host[TOOL_ROW_SUMMARY_ROW_KEY] = 0;

	if (host[TOOL_ROW_REVEALED_KEY] !== true) {
		host[TOOL_ROW_ARROW_ROW_KEY] = undefined;
		host[TOOL_ROW_BODY_OFFSET_KEY] = NO_BODY_OFFSET;
		return appendActivityTail([summaryLine], { group, deps, width });
	}

	const bodyOffset = SUMMARY_ROW_HEIGHT;
	host[TOOL_ROW_BODY_OFFSET_KEY] = bodyOffset;
	const body = withToolRowArrow(host, originalRender.call(host, width), {
		styler: deps.styler,
		bodyOffset,
	});
	return appendActivityTail([summaryLine, ...body], { group, deps, width });
}

/**
 * 包装工具行的 handleMouse。
 *
 * 四种命中区，其余透传给 Pi：
 * - 组头块（前导空行 + 组头行）：展开/收起整个组；
 * - 成员命令的摘要行：整行可点，展开/收起这条命令的原文；
 * - 工具行箭头所在那一行：切换 Pi 自己的输出展开；
 * - 已铺开的原文：坐标减掉组头与摘要行的高度再透传，否则点哪都差几行。
 */
function buildToolMessageHandleMouse(
	deps: ComponentPatchDeps,
	originalHandleMouse: (this: ToolMessageHost, event: TuiMouseEvent) => unknown,
): (this: ToolMessageHost, event: TuiMouseEvent) => unknown {
	return function patchedToolMessageHandleMouse(this: ToolMessageHost, event: TuiMouseEvent) {
		const isLeftClick = event.type === "click" && event.button === "left";

		// 组头块优先：展开的组里，首条成员的摘要行在组头下面，两者同属一个组件。
		const headerHeight = this[TOOL_ROW_HEADER_HEIGHT_KEY] ?? NO_BODY_OFFSET;
		if (isLeftClick && headerHeight > NO_BODY_OFFSET && event.y < headerHeight) {
			return toggleActionGroupAt(this, deps, isLeftClick);
		}

		const summaryRow = this[TOOL_ROW_SUMMARY_ROW_KEY];
		if (summaryRow !== undefined) {
			const revealed = this[TOOL_ROW_REVEALED_KEY] === true;
			// 原文没铺开时整块都是摘要行（行高只有 1）；铺开后只有第 0 行是开关。
			const onSummary = revealed ? event.y === summaryRow : event.y >= summaryRow;
			if (isLeftClick && onSummary) {
				setToolRowRevealed(this, !revealed, deps);
				return { handled: true };
			}
		}

		const arrowRow = this[TOOL_ROW_ARROW_ROW_KEY];
		if (isLeftClick && arrowRow !== undefined && event.y === arrowRow && this.setExpanded) {
			this.setExpanded(!this.expanded);
			return { handled: true };
		}

		const bodyOffset = this[TOOL_ROW_BODY_OFFSET_KEY] ?? NO_BODY_OFFSET;
		if (bodyOffset > NO_BODY_OFFSET) {
			return originalHandleMouse.call(this, {
				...event,
				y: event.y - bodyOffset,
				height: Math.max(event.height - bodyOffset, 1),
			});
		}

		if (getGroupInfo(this, deps) && isGroupHeaderRow(this, deps)) {
			return toggleActionGroupAt(this, deps, isLeftClick);
		}
		return originalHandleMouse.call(this, event);
	};
}

/** 切换一条成员命令的原文展开状态并请求重绘。 */
function setToolRowRevealed(host: ToolMessageHost, revealed: boolean, deps: ComponentPatchDeps): void {
	host[TOOL_ROW_REVEALED_KEY] = revealed;
	deps.requestRender();
}

/**
 * 点组头时切换该动作组；不是左键或查不到组时返回 undefined（不接管这次事件）。
 */
function toggleActionGroupAt(
	host: ToolMessageHost,
	deps: ComponentPatchDeps,
	isLeftClick: boolean,
): unknown {
	if (!isLeftClick) {
		return undefined;
	}
	const group = getGroupInfo(host, deps);
	if (!group) {
		return undefined;
	}
	deps.onToggleActionGroup(group.membership.groupId);
	return { handled: true };
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
