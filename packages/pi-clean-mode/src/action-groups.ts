/**
 * L2 动作组：把一个 turn 里的全部工具调用合成一组。
 *
 * 分组依据是 Pi 自己的 `turn` 语义——一个 turn 等于一次 assistant 回复加它触发的
 * 工具调用，因此 turn_start 开一个新组，该组的工具调用在 tool_call 事件里登记。
 *
 * 登记不能只靠 `tool_call`：前面的扩展（例如 pi-safety-guards 拦下命令时）一旦返回
 * block，Pi 的 runner 会立刻停止分发，后面的扩展就看不到这次调用。看不到就登记不上，
 * 那一行会掉出分组、以原始形式显示。所以 `tool_execution_start` 也要登记一次——
 * 它在每次工具调用前都会发出（连被拦下的也会），且登记是幂等的。
 *
 * 渲染策略（与 L1 运行级折叠叠加）：
 * - L1 折叠时整轮工作过程都隐藏，动作组不参与；
 * - 组内只有 1 条时也收成一行，文案直接用这条动作自己的摘要
 *   （例如「运行命令 ls -la」）——收起态不显示原始工具输出，
 *   展开时直接露出这条工具的原文（组头本身就是它的摘要）；
 * - 组内有 2 条及以上时收成汇总组头（`运行命令 · N 步`，没有过半分类时用通用词
 *   `探索 · N 步`），展开后逐条列出：一条命令一行摘要，点某一行才在该行下面
 *   展开这条工具的原文，其余成员继续保持一行。
 */

import type { ActivityCounters } from "./activity.js";

/** 某个工具调用在动作组里的归属。 */
export interface ActionGroupMembership {
	/** 所属组号。 */
	groupId: number;
	/** 组内序号，0 表示这一条渲染组头。 */
	index: number;
	/** 该动作的一行摘要（例如「运行命令 ls -la」）；组内只有它一条时当组头文案。 */
	summary?: string;
}

/** 动作组的累计状态；组号只增不减，历史组的归属与展开状态得以保留。 */
export interface ActionGroupState {
	/** 下一个可用组号。 */
	nextGroupId: number;
	/** 当前 turn 的组号。 */
	currentGroupId: number;
	/** toolCallId -> 归属信息。 */
	membershipByToolCallId: Map<string, ActionGroupMembership>;
	/** 组号 -> 成员数。 */
	memberCountByGroupId: Map<number, number>;
	/**
	 * 组号 -> 该组各类动作的出现次数。
	 *
	 * 组头主词按它选（组内过半的那一类），所以计数按组分开存，而不是只留本轮总计；
	 * 历史组也要靠它才能说出「刚才那一组在干什么」。
	 */
	activityCountByGroupId: Map<number, Partial<ActivityCounters>>;
	/** 已展开的组号。 */
	expandedGroupIds: Set<number>;
}

/** 内容块的类型标识：正文文本。 */
const CONTENT_TYPE_TEXT = "text";
/** 内容块里工具调用的类型名，与 Pi 会话格式一致。 */
const CONTENT_TYPE_TOOL_CALL = "toolCall";
/** 消息角色标识：assistant。 */
const MESSAGE_ROLE_ASSISTANT = "assistant";

/** 工具行整行不渲染。 */
export const TOOL_ROW_HIDDEN = "hidden";
/** 工具行按 Pi 原本方式渲染。 */
export const TOOL_ROW_NORMAL = "normal";
/** 工具行充当动作组组头，只输出一行组头文案。 */
export const TOOL_ROW_GROUP_HEADER = "group-header";
/**
 * 工具行是展开的组里的一名成员：只输出一行命令摘要，点它才露出原文。
 *
 * 展开的组不再把每条工具的原始输出一次性铺开：一组几十条调用时那是一屏又一屏的正文，
 * 「刚才跑了哪几条」反而看不出来。一条命令一行，要看哪条的原文再点哪条。
 */
export const TOOL_ROW_SUMMARY = "summary";

/** 工具行在当前位置的渲染方式。 */
export type ToolRowMode =
	| typeof TOOL_ROW_HIDDEN
	| typeof TOOL_ROW_NORMAL
	| typeof TOOL_ROW_GROUP_HEADER
	| typeof TOOL_ROW_SUMMARY;

/** 判断单个内容块是否为非空正文文本块。 */
function isNonEmptyTextBlock(block: unknown): boolean {
	if (!isRecord(block) || block.type !== CONTENT_TYPE_TEXT) {
		return false;
	}
	return typeof block.text === "string" && block.text.trim().length > 0;
}

/**
 * 判断一条消息是否带可见的解说文本。
 *
 * 只算 `text` 内容块；thinking 不计入，因为它在 Pi 里是单独渲染的。
 */
export function hasNarrationText(message: unknown): boolean {
	if (!isRecord(message)) {
		return false;
	}

	const content = message.content;
	if (!Array.isArray(content)) {
		return false;
	}

	return content.some(isNonEmptyTextBlock);
}

/** 判断输入是否为可按键读取的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 判断一条消息是否为 assistant 消息。 */
export function isAssistantMessage(message: unknown): boolean {
	return isRecord(message) && message.role === MESSAGE_ROLE_ASSISTANT;
}

/** 从消息里扫出的一次工具调用；登记动作组只需要这三样。 */
export interface StreamedToolCall {
	/** 本次调用的唯一 id。 */
	toolCallId: string;
	/** 工具名（`bash`、`edit` …），用来算动作摘要与分类。 */
	toolName: string;
	/** 调用参数，原样透传。 */
	args: unknown;
}

/**
 * 扫出 assistant 消息里已经出现的工具调用。
 *
 * 必须在消息还在流式时就能扫到。Pi 一旦把工具调用块收完，就会立刻把那一行工具行加进
 * 对话并渲染它，而 `tool_call` / `tool_execution_start` 要等这条 assistant 消息**结束**
 * 才发（实测差 300ms 上下）。等到那时候再登记，那一行已经以「未登记」的样子原样画了
 * 一两帧，登记之后又突然收进组里——屏幕上就是工具行先措不及防地跳出来、再突然消失。
 * 内容块形状见 Pi 会话格式：`{ type: "toolCall", id, name, arguments }`。
 */
export function extractToolCalls(message: unknown): StreamedToolCall[] {
	if (!isRecord(message)) {
		return [];
	}

	const content = message.content;
	if (!Array.isArray(content)) {
		return [];
	}

	const calls: StreamedToolCall[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== CONTENT_TYPE_TOOL_CALL) {
			continue;
		}
		const { id, name } = block;
		if (typeof id !== "string" || id.length === 0) {
			continue;
		}
		if (typeof name !== "string" || name.length === 0) {
			continue;
		}
		calls.push({ toolCallId: id, toolName: name, args: block.arguments });
	}

	return calls;
}

/** 创建空的动作组状态。 */
export function createActionGroupState(): ActionGroupState {
	return {
		nextGroupId: 1,
		currentGroupId: 0,
		membershipByToolCallId: new Map<string, ActionGroupMembership>(),
		memberCountByGroupId: new Map<number, number>(),
		activityCountByGroupId: new Map<number, Partial<ActivityCounters>>(),
		expandedGroupIds: new Set<number>(),
	};
}

/** 开始一个新 turn，后续登记的工具调用归入新组。原地修改 state，无返回值。 */
export function beginActionGroupStep(state: ActionGroupState): void {
	state.currentGroupId = state.nextGroupId;
	state.nextGroupId += 1;
	state.memberCountByGroupId.set(state.currentGroupId, 0);
	state.activityCountByGroupId.set(state.currentGroupId, {});
}

/** 登记一次工具调用需要的字段。 */
export interface ActionToolCallInput {
	/** 本次调用的唯一 id。 */
	toolCallId: string;
	/** 该动作的一行摘要（例如「运行命令 ls -la」）。 */
	summary?: string;
	/** 本次调用的分类，用于选组头主词。 */
	activity?: keyof ActivityCounters;
}

/**
 * 把一个工具调用登记到当前组。原地修改 state，无返回值。
 *
 * 重复登记同一个 toolCallId 时保持原归属，避免 Pi 重发事件导致序号错乱；
 * 后一次带上了摘要而先前没带上时，只补摘要。分类计数只在新登记时累加，
 * 重复登记不能把同一次调用数两遍。
 */
export function registerActionToolCall(state: ActionGroupState, input: ActionToolCallInput): void {
	const { toolCallId, summary, activity } = input;
	const existing = state.membershipByToolCallId.get(toolCallId);
	if (existing) {
		if (summary !== undefined && existing.summary === undefined) {
			existing.summary = summary;
		}
		return;
	}

	const groupId = state.currentGroupId;
	const index = state.memberCountByGroupId.get(groupId) ?? 0;
	state.membershipByToolCallId.set(toolCallId, { groupId, index, ...(summary === undefined ? {} : { summary }) });
	state.memberCountByGroupId.set(groupId, index + 1);

	if (activity !== undefined) {
		const counts = state.activityCountByGroupId.get(groupId) ?? {};
		counts[activity] = (counts[activity] ?? 0) + 1;
		state.activityCountByGroupId.set(groupId, counts);
	}
}

/**
 * 把一次工具调用改挂到当前组。
 *
 * 解说出现在工具调用**后面**时会晚于那次调用开始流式，组边界就落在它后面（`message_end`
 * 侧才开新组）；这几次调用得跟着挪过去，否则它们会被算进上一组。
 * 只适用于「刚登记、还在原组尾部」的调用：挪的是同一流式消息里登记的那几条，
 * 因此旧组剩下的成员序号仍然连续。已在当前组或无登记时什么也不做。
 */
export function reassignActionToolCall(state: ActionGroupState, input: ActionToolCallInput): void {
	const { toolCallId, summary, activity } = input;
	const existing = state.membershipByToolCallId.get(toolCallId);
	if (!existing || existing.groupId === state.currentGroupId) {
		return;
	}

	const previousSize = state.memberCountByGroupId.get(existing.groupId) ?? 0;
	if (previousSize > 0) {
		state.memberCountByGroupId.set(existing.groupId, previousSize - 1);
	}
	if (activity !== undefined) {
		const counts = state.activityCountByGroupId.get(existing.groupId);
		if (counts !== undefined) {
			counts[activity] = Math.max(0, (counts[activity] ?? 0) - 1);
		}
	}

	state.membershipByToolCallId.delete(toolCallId);
	registerActionToolCall(state, input);
}

/** 取某个组的分类计数；未知组返回 undefined。 */
export function getActionGroupActivityCounts(
	state: ActionGroupState,
	groupId: number,
): Partial<ActivityCounters> | undefined {
	return state.activityCountByGroupId.get(groupId);
}

/** 查询某个工具调用的组归属；未登记时返回 undefined。 */
export function findActionGroupMembership(
	state: ActionGroupState,
	toolCallId: string,
): ActionGroupMembership | undefined {
	return state.membershipByToolCallId.get(toolCallId);
}

/** 取某个组的成员数；未知组返回 0。 */
export function getActionGroupSize(state: ActionGroupState, groupId: number): number {
	return state.memberCountByGroupId.get(groupId) ?? 0;
}

/** 判断某个组是否已展开。 */
export function isActionGroupExpanded(state: ActionGroupState, groupId: number): boolean {
	return state.expandedGroupIds.has(groupId);
}

/**
 * 切换某个组的展开状态。原地修改 state，无返回值；读取展开状态用
 * `isActionGroupExpanded`，与其它命令式接口保持一致。
 */
export function toggleActionGroup(state: ActionGroupState, groupId: number): void {
	if (state.expandedGroupIds.has(groupId)) {
		state.expandedGroupIds.delete(groupId);
	} else {
		state.expandedGroupIds.add(groupId);
	}
}

/** 判断当前所有已创建的组是否都已展开；没有组时返回 false。 */
export function areAllActionGroupsExpanded(state: ActionGroupState): boolean {
	if (state.memberCountByGroupId.size === 0) {
		return false;
	}
	for (const groupId of state.memberCountByGroupId.keys()) {
		if (!state.expandedGroupIds.has(groupId)) {
			return false;
		}
	}
	return true;
}

/** 把当前所有已创建的组统一设为展开或收起。原地修改 state，无返回值。 */
export function setAllActionGroupsExpanded(state: ActionGroupState, expanded: boolean): void {
	for (const groupId of state.memberCountByGroupId.keys()) {
		if (expanded) {
			state.expandedGroupIds.add(groupId);
		} else {
			state.expandedGroupIds.delete(groupId);
		}
	}
}
