/**
 * 组件原型补丁。
 *
 * Pi 在扩展入口导出 AssistantMessageComponent 与 ToolExecutionComponent，
 * 这里接管两者的 render / updateContent，实现「折叠时只留最终答案」：
 *
 * - assistant 消息：工作过程（带 tool call）整条隐藏；最终答案保留；
 * - 工具行：整行隐藏，由于空渲染会返回 []，连前置空行一起消失；
 * - 折叠头：作为最终答案容器里的第一个子组件插入，并包一层 MouseRegion，
 *   因此全屏模式下可以鼠标点击切换折叠状态。
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
import { MouseRegion, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	TOOL_ROW_GROUP_HEADER,
	TOOL_ROW_HIDDEN,
	type ActionGroupMembership,
} from "./action-groups.js";
import { formatDuration } from "./duration.js";
import { debugLog } from "./debug-logger.js";
import { i18n } from "./i18n.js";
import {
	resolveAssistantMessageHidden,
	resolveRunHeader,
	resolveToolRowMode,
	type AssistantMessageKind,
} from "./render-policy.js";
import { installMethodPatch, type PatchablePrototype } from "./prototype-patch.js";
import type { CleanModeConfig, CleanModeState } from "./types.js";

/** 折叠态的箭头，提示点击后展开。 */
const COLLAPSED_CHEVRON = "›";
/** 展开态的箭头，提示点击后收起。 */
const EXPANDED_CHEVRON = "⌄";
/** 收起的动作组前面的箭头，提示点击后展开。 */
const COLLAPSED_GROUP_CHEVRON = "▸";
/** 折叠头之前的空行，用于与上方消息留出间距；下方间距由内容容器自带的 Spacer 提供。 */
const HEADER_LEADING_BLANK = "";
/** 折叠头子组件在实例上的缓存键。 */
const HEADER_CHILD_KEY: unique symbol = Symbol("piCleanModeHeaderChild");

/** assistant 组件对外可见的最小结构。 */
interface AssistantMessageHost {
	/** Pi 在 updateContent 里写入：该消息是否包含 tool call。 */
	hasToolCalls?: boolean;
	/** 内容容器；折叠头插在它的 children 首位。 */
	contentContainer?: { children: Component[] };
	render(width: number): string[];
	updateContent(message: unknown, isStreaming?: boolean): void;
	/** 折叠头子组件的实例级缓存。 */
	[HEADER_CHILD_KEY]?: Component;
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
	/** 把折叠头文案染成弱化色；主题不可用时返回原文本。 */
	styleHeader: (text: string) => string;
	/** 鼠标点击折叠头时切换折叠状态。 */
	onToggle: () => void;
	/** 查询某个工具调用所属的动作组；未登记时返回 undefined。 */
	getToolRowGroup: (toolCallId: string) => ToolRowGroupInfo | undefined;
	/** 切换某个动作组的展开状态。 */
	onToggleActionGroup: (groupId: number) => void;
}

/** 把 Pi 的 hasToolCalls 映射成业务分类；映射规则见本文件顶部说明。 */
function classifyAssistantMessage(hasToolCalls: boolean): AssistantMessageKind {
	return hasToolCalls ? "work" : "final";
}

/** 组装折叠头那一行，例如 `用时 4m 26s ›`。 */
function buildRunHeaderLine(state: CleanModeState, deps: ComponentPatchDeps): string {
	const durationMs = state.runDurationMs ?? 0;
	const label = i18n.t("runHeader", { duration: formatDuration(durationMs) });
	const chevron = state.collapsed ? COLLAPSED_CHEVRON : EXPANDED_CHEVRON;
	const hint = deps.getConfig().showExpandHint ? ` ${chevron}` : "";
	return deps.styleHeader(`${label}${hint}`);
}

/**
 * 创建折叠头子组件。
 *
 * 可见时输出「空行 + 折叠头」两行：空行与上方消息拉开距离，折叠头下方则接
 * 内容容器原有的 Spacer。不可见时渲染 0 行，因此不占空间也不可点击。
 */
function createRunHeaderComponent(deps: ComponentPatchDeps): Component {
	const content: Component = {
		/** 可见时输出「空行 + 折叠头」，否则输出空行集。 */
		render: (width: number): string[] => {
			const decision = resolveRunHeader(deps.getState(), deps.getConfig());
			if (!decision.visible) {
				return [];
			}
			return [HEADER_LEADING_BLANK, buildRunHeaderLine(deps.getState(), deps)];
		},
		/** 无缓存状态，渲染时实时读取当前折叠状态。 */
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
	host[HEADER_CHILD_KEY] ??= createRunHeaderComponent(deps);
	return host[HEADER_CHILD_KEY];
}

/**
 * 包装 assistant 消息的 render：折叠时工作过程返回空数组。
 *
 * 折叠头不在这里拼接——它以子组件形式存在于内容容器里，由 Container 正常渲染。
 */
function buildAssistantMessageRender(
	deps: ComponentPatchDeps,
	originalRender: (this: AssistantMessageHost, width: number) => string[],
): (this: AssistantMessageHost, width: number) => string[] {
	return function patchedAssistantMessageRender(this: AssistantMessageHost, width: number) {
		const kind = classifyAssistantMessage(this.hasToolCalls === true);
		const hidden = resolveAssistantMessageHidden({
			state: deps.getState(),
			config: deps.getConfig(),
			kind,
		});

		if (hidden) {
			return [];
		}

		return originalRender.call(this, width);
	};
}

/**
 * 包装 assistant 消息的 updateContent。
 *
 * 原始实现会清空并重建内容容器，因此这里在它之后把折叠头插到 children 首位：
 * 最终答案消息始终带折叠头子组件，是否真的显示由子组件按当前状态决定。
 * 工作过程消息不插折叠头。
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
		originalUpdateContent.call(this, message, isStreaming);

		const container = this.contentContainer;
		if (!container || this.hasToolCalls === true) {
			return;
		}

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

/** 组装收起的动作组组头，例如 `▸ 探索 · 4 步`。 */
function buildActionGroupHeaderLines(
	group: ToolRowGroupInfo,
	deps: ComponentPatchDeps,
): string[] {
	const label = i18n.t("actionGroupHeader", { count: String(group.groupSize) });
	const header = deps.styleHeader(`${COLLAPSED_GROUP_CHEVRON} ${label}`);
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
			return buildActionGroupHeaderLines(group, deps);
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
