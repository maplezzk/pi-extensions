/**
 * 组件的渲染决策。
 *
 * 全部是纯函数，不读组件内部实现，只依赖 CleanModeState 与调用方给出的消息
 * 分类，便于单测覆盖折叠、展开与边界分支。
 *
 * 命名与 types.ts 保持一致：折叠单位是「一次 agent 运行」，统一用 run。
 */

import {
	TOOL_ROW_GROUP_HEADER,
	TOOL_ROW_HIDDEN,
	TOOL_ROW_NORMAL,
	TOOL_ROW_SUMMARY,
	type ActionGroupMembership,
	type ToolRowMode,
} from "./action-groups.js";
import type { CleanModeConfig, CleanModeState } from "./types.js";

/** assistant 消息的业务分类：工作过程，或本次运行的最终答案。 */
export type AssistantMessageKind = "work" | "final";

/** 判定一条 assistant 消息如何渲染所需的输入。 */
export interface AssistantRenderInput {
	state: CleanModeState;
	config: CleanModeConfig;
	/** 调用方给出的消息分类；分类规则见组件补丁层。 */
	kind: AssistantMessageKind;
	/** 本体是否承载本轮的轮首折叠头槽位（每轮只有第一条 assistant 消息承载）。 */
	isRunHeaderHost: boolean;
}

/** assistant 消息的渲染结果。 */
export interface AssistantRenderDecision {
	/** 本条消息自身的内容是否隐藏（工作过程在折叠时隐藏）。 */
	hideContent: boolean;
	/** 内容被隐藏时是否仍然输出轮首槽位。 */
	showHeader: boolean;
}

/** 判定工具行渲染方式所需的输入。 */
export interface ToolRowModeInput {
	state: CleanModeState;
	config: CleanModeConfig;
	/** 该工具调用所属的动作组；未登记时为 undefined。 */
	membership?: ActionGroupMembership;
	/** 所属动作组的成员总数。 */
	groupSize: number;
	/** 所属动作组是否已展开。 */
	groupExpanded: boolean;
}

/** 折叠头的可见性与当前方向；不可见时不占任何行。 */
export interface RunHeaderDecision {
	/** 是否渲染折叠头。 */
	visible: boolean;
	/** 当前是否处于折叠态，决定折叠头用哪个箭头。 */
	collapsed: boolean;
}

/** 判定折叠头所需的输入。 */
export interface RunHeaderInput {
	config: CleanModeConfig;
	/** 本条最终答案所属那一轮的耗时；未知时不显示折叠头。 */
	durationMs?: number;
	/** 当前是否处于折叠态。 */
	collapsed: boolean;
}

/**
 * 判定一条 assistant 消息在当前位置该如何渲染。
 *
 * 折叠头挂在每轮第一条 assistant 消息上，因此它总是出现在整轮最前面，展开后也
 * 保持在顶部，形成「耗时 → 过程 → 答案」的树形结构。
 *
 * 承载折叠头的那一条即使自身内容被隐藏（它是工作过程消息），也仍然输出轮首槽位，
 * 否则收起后就什么提示都没有了。
 *
 * 这里**刻意不判耗时**：运行中耗时还没写入（`agent_settled` 才记），而槽位里此时装的
 * 是「处理中 · Ns」状态横条。拿耗时当开关会让槽位连同状态横条一起消失 —— 运行中
 * 收起后屏幕上就只剩被隐藏的正文，也就是整屏空白，看起来像卡死。槽位里到底画状态
 * 横条、耗时横条还是什么都不画，由组件层（`createRunHeaderComponent` 与
 * `resolveRunHeader`）按运行状态决定。
 */
export function resolveAssistantMessageRender(
	input: AssistantRenderInput,
): AssistantRenderDecision {
	const { state, config, kind, isRunHeaderHost } = input;
	const hideContent = config.enabled && state.collapsed && kind === "work";

	if (!config.enabled || !isRunHeaderHost) {
		return { hideContent, showHeader: false };
	}

	return { hideContent, showHeader: true };
}

/**
 * 判定折叠头是否可见。
 *
 * 耗时按「本条最终答案所属那一轮」传入，因此历史轮次的折叠头不会跟着最新一轮变；
 * 耗时未知（例如从会话恢复的历史消息）时不显示。
 * 折叠头在折叠态与展开态都显示，这样两个方向都有可点击的鼠标目标。
 */
export function resolveRunHeader(input: RunHeaderInput): RunHeaderDecision {
	const { config, durationMs, collapsed } = input;
	const visible = config.enabled && config.showRunHeader && durationMs !== undefined;

	return { visible, collapsed };
}

/**
 * 判定一条工具行在当前位置该怎么渲染。
 *
 * 优先级：总开关关闭时一律原样；运行级折叠先隐藏一切；未登记的工具行也原样
 * （不知道它属于哪组，不能自作主张收起来）。
 *
 * 聚合在运行期间就生效（工具聚合模式），停止后再由运行级折叠收成完全聚合。
 * 组内首行（index 0）**始终**充当组头，展开态也不例外——否则展开后组头行消失，
 * 就没有可以点击收回的目标了。**一条也算一组**：只有一条时组头直接用这条动作的
 * 摘要，所以收起态不会把原始工具输出露出来，展开组头就是看这条原文。
 *
 * 其余成员（index >= 1）在组展开后走 `TOOL_ROW_SUMMARY`：一条命令一行，点哪条
 * 才在哪条下面露出原文。直接铺 Pi 的原始输出时，一屏装了不下几条，组里到底跑了
 * 多少条、还剩哪些没看都看不出来。
 */
export function resolveToolRowMode(input: ToolRowModeInput): ToolRowMode {
	const { state, config, membership, groupSize, groupExpanded } = input;

	if (!config.enabled) {
		return TOOL_ROW_NORMAL;
	}

	if (state.collapsed) {
		return TOOL_ROW_HIDDEN;
	}

	if (!config.enableActionGroups || !membership || groupSize <= 0) {
		return TOOL_ROW_NORMAL;
	}

	if (membership.index === 0) {
		return TOOL_ROW_GROUP_HEADER;
	}

	return groupExpanded ? TOOL_ROW_SUMMARY : TOOL_ROW_HIDDEN;
}
