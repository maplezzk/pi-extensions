/**
 * 流式消息里的动作组登记。
 *
 * 组边界跟着「解说」走（带正文解说的 assistant 消息开新组），但开组与登记都**必须**赶在
 * Pi 渲染那一行工具行之前完成。Pi 收完工具调用块就立刻把工具行加进对话并渲染，而
 * `tool_call` / `tool_execution_start` 要等这条 assistant 消息结束才发（实测差 300ms
 * 上下），只靠后两个事件登记，工具行会先以「未登记」的样子原样画一两帧、再突然收进组里。
 *
 * 两件事的先后也不能反：先开组再登记，否则解说出现在工具调用**后面**时，那几个调用会
 * 落在上一组。这里把顺序、幂等和「解说晚到时把已登记的调用挪过去」都收成一处状态机，
 * 事件回调只负责把消息喂进来。
 */

import {
	beginActionGroupStep,
	extractToolCalls,
	findActionGroupMembership,
	hasNarrationText,
	isAssistantMessage,
	reassignActionToolCall,
	registerActionToolCall,
	type ActionGroupState,
} from "./action-groups.js";
import type { ActivityCounters } from "./activity.js";

/** 一次已经出现的工具调用；与 `action-groups` 的扫描结果同一形状。 */
export interface StreamedToolCall {
	/** 本次调用的唯一 id。 */
	toolCallId: string;
	/** 工具名（`bash`、`edit` …）。 */
	toolName: string;
	/** 调用参数，原样透传。 */
	args: unknown;
}

/**
 * 把一次调用翻译成登记所需的摘要与分类；由调用方提供（它才知道工具名怎么读数）。
 *
 * `provisional` 为真表示这份摘要是占位：流式块的参数是分片拼起来的，块刚出现时只有键、
 * 值还没到，那时只能读出「运行命令」这样的标签。标成占位后，参数到齐时会被真摘要覆盖。
 */
export type StreamedToolCallDescriber = (
	call: StreamedToolCall,
) => { summary?: string; provisional?: boolean; activity: keyof ActivityCounters };

/** 流式登记的会话内状态；一次会话一份，跨 run 复用。 */
export interface StreamRegistration {
	/** 当前这条 assistant 消息是不是还没开新组。 */
	narrationStepPending: boolean;
	/** 当前这条消息里已经登记过的调用，解说晚到时要把它们挪到新组。 */
	toolCalls: StreamedToolCall[];
}

/** 处理一条流式消息的结果，供调用方记账与打日志。 */
export interface StreamedMessageOutcome {
	/** 这次处理是否开了新组。 */
	stepped: boolean;
	/** 这次处理新登记（不是重复看到）的调用；调用方据此累加本轮步数。 */
	registered: StreamedToolCall[];
}

/** 创建空的流式登记状态。 */
export function createStreamRegistration(): StreamRegistration {
	return { narrationStepPending: false, toolCalls: [] };
}

/**
 * 一条 assistant 消息开始流式：把「这条还没开新组」记成待办。
 *
 * 只有 assistant 消息会带正文解说与工具调用，其它角色的消息不碰状态，否则一条
 * user/toolResult 消息会把上一条 assistant 消息的待办清掉。
 */
export function beginStreamedMessage(state: StreamRegistration, message: unknown): void {
	if (!isAssistantMessage(message)) {
		return;
	}
	state.narrationStepPending = true;
	state.toolCalls = [];
}

/** 消化一条流式消息所需的输入。 */
export interface StreamedMessageInput {
	/** 流式登记状态。 */
	state: StreamRegistration;
	/** assistant 消息（可能是流式中间态）。 */
	message: unknown;
	/** 动作组状态；开组与登记都改它。 */
	actionGroups: ActionGroupState;
	/** 把一次调用翻译成摘要与分类。 */
	describe: StreamedToolCallDescriber;
}

/**
 * 消化一次流式更新（或消息结束时的兜底）：先按需开组，再登记已经出现的调用。
 *
 * 幂等：同一条消息反复喂进来只会登记一次、开一次组，所以 `message_update` 每一帧都能
 * 无脑调它，`message_end` 再兜一次不流式的 provider。
 */
export function applyStreamedMessage(input: StreamedMessageInput): StreamedMessageOutcome {
	const { state, message, actionGroups, describe } = input;
	if (!isAssistantMessage(message)) {
		return { stepped: false, registered: [] };
	}

	let stepped = false;
	if (state.narrationStepPending && hasNarrationText(message)) {
		beginActionGroupStep(actionGroups);
		state.narrationStepPending = false;
		stepped = true;
		// 解说出现在工具调用后面时，那几次调用已按上一组登记过：组边界既然落在解说
		// 之后，它们就该跟着走，否则会被算进上一组。
		for (const call of state.toolCalls) {
			const { summary, provisional, activity } = describe(call);
			reassignActionToolCall(actionGroups, {
				toolCallId: call.toolCallId,
				summary,
				provisional,
				activity,
			});
		}
	}

	const registered: StreamedToolCall[] = [];
	for (const call of extractToolCalls(message)) {
		if (findActionGroupMembership(actionGroups, call.toolCallId)) {
			refineStreamedToolCall({ state, call, actionGroups, describe });
			continue;
		}
		const { summary, provisional, activity } = describe(call);
		registerActionToolCall(actionGroups, { toolCallId: call.toolCallId, summary, provisional, activity });
		state.toolCalls.push(call);
		registered.push(call);
	}

	return { stepped, registered };
}

/** 补全一次登记所需的输入。 */
interface StreamedToolCallRefinement {
	state: StreamRegistration;
	call: StreamedToolCall;
	actionGroups: ActionGroupState;
	describe: StreamedToolCallDescriber;
}

/**
 * 参数分片到齐后把摘要补上。
 *
 * 只动「这条消息里自己登记过」的调用：别的来源（`tool_call` / `tool_execution_start`）
 * 登记时参数已经是完整的，不需要也不该被这里的占位参数覆盖。
 */
function refineStreamedToolCall(input: StreamedToolCallRefinement): void {
	const { state, call, actionGroups, describe } = input;
	const index = state.toolCalls.findIndex((item) => item.toolCallId === call.toolCallId);
	if (index < 0) {
		return;
	}

	// 用最新一帧的参数替掉当初的占位；登记层只在「先前是占位」时才换文案。
	state.toolCalls[index] = call;
	const { summary, provisional, activity } = describe(call);
	registerActionToolCall(actionGroups, { toolCallId: call.toolCallId, summary, provisional, activity });
}
