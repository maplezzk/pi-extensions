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

/**
 * 判定一条 assistant 消息是否整条隐藏。
 *
 * 折叠时只有工作过程隐藏；最终答案始终保留。
 */
export function resolveAssistantMessageHidden(input: AssistantRenderInput): boolean {
	const { state, config, kind } = input;

	if (!config.enabled || !state.collapsed) {
		return false;
	}

	return kind === "work";
}

/**
 * 判定折叠头是否可见。
 *
 * 耗时未知时不显示，因此执行中的运行没有折叠头，运行结束后才出现。
 * 折叠头在折叠态与展开态都显示，这样两个方向都有可点击的鼠标目标。
 */
export function resolveRunHeader(
	state: CleanModeState,
	config: CleanModeConfig,
): RunHeaderDecision {
	const visible =
		config.enabled && config.showRunHeader && state.runDurationMs !== undefined;

	return { visible, collapsed: state.collapsed };
}

/**
 * 判定一条工具行在当前位置该怎么渲染。
 *
 * 优先级：总开关关闭时一律原样；运行级折叠先隐藏一切；否则组内只有一条时不折叠。
 *
 * 组内首行（index 0）**始终**充当组头，展开态也不例外——否则展开后组头行消失，
 * 就没有可以点击收回的目标了。展开时它额外把自己的内容接在组头后面。
 */
export function resolveToolRowMode(input: ToolRowModeInput): ToolRowMode {
	const { state, config, membership, groupSize, groupExpanded } = input;

	if (!config.enabled) {
		return TOOL_ROW_NORMAL;
	}

	if (state.collapsed) {
		return TOOL_ROW_HIDDEN;
	}

	if (!config.enableActionGroups || !membership || groupSize <= 1) {
		return TOOL_ROW_NORMAL;
	}

	if (membership.index === 0) {
		return TOOL_ROW_GROUP_HEADER;
	}

	return groupExpanded ? TOOL_ROW_NORMAL : TOOL_ROW_HIDDEN;
}
