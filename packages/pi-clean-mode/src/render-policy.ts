/**
 * 组件的渲染决策。
 *
 * 全部是纯函数，不读组件内部实现，只依赖 CleanModeState 与调用方给出的消息
 * 分类，便于单测覆盖折叠、展开与边界分支。
 *
 * 命名与 types.ts 保持一致：折叠单位是「一次 agent 运行」，统一用 run。
 */

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

/** assistant 消息的渲染结果：是否整条隐藏、是否追加折叠头。 */
export interface AssistantRenderDecision {
	/** 整条消息不渲染（工作过程解说被隐藏）。 */
	hidden: boolean;
	/** 是否在原始输出上方追加折叠头。 */
	showHeader: boolean;
}

/** 工具行的渲染结果。 */
export interface ToolRowRenderDecision {
	/** 整行不渲染（连前置空行一起消失）。 */
	hidden: boolean;
}

/**
 * 判定一条 assistant 消息在当前位置该如何渲染。
 *
 * 折叠时工作过程整条隐藏；最终答案保留，并按状态决定是否加折叠头。
 */
export function resolveAssistantMessageRender(
	input: AssistantRenderInput,
): AssistantRenderDecision {
	const { state, config, kind } = input;

	if (!config.enabled || !state.collapsed) {
		return { hidden: false, showHeader: false };
	}

	if (kind === "work") {
		return { hidden: true, showHeader: false };
	}

	const showHeader = config.showRunHeader && state.runSettled && state.runDurationMs !== undefined;

	return { hidden: false, showHeader };
}

/** 判定工具行在当前位置该如何渲染；折叠时整行隐藏。 */
export function resolveToolMessageRender(
	state: CleanModeState,
	config: CleanModeConfig,
): ToolRowRenderDecision {
	return { hidden: config.enabled && state.collapsed };
}
