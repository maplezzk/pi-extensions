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
 *   （例如「运行命令 ls -la」）——收起态不显示原始工具输出；
 * - 组内有 2 条及以上时收成「探索 · N 步」，展开后逐条显示。
 */

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
	/** 已展开的组号。 */
	expandedGroupIds: Set<number>;
}

/** 内容块的类型标识：正文文本。 */
const CONTENT_TYPE_TEXT = "text";
/** 消息角色标识：assistant。 */
const MESSAGE_ROLE_ASSISTANT = "assistant";

/** 工具行整行不渲染。 */
export const TOOL_ROW_HIDDEN = "hidden";
/** 工具行按 Pi 原本方式渲染。 */
export const TOOL_ROW_NORMAL = "normal";
/** 工具行充当动作组组头，只输出一行组头文案。 */
export const TOOL_ROW_GROUP_HEADER = "group-header";

/** 工具行在当前位置的渲染方式。 */
export type ToolRowMode =
	| typeof TOOL_ROW_HIDDEN
	| typeof TOOL_ROW_NORMAL
	| typeof TOOL_ROW_GROUP_HEADER;

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

/** 创建空的动作组状态。 */
export function createActionGroupState(): ActionGroupState {
	return {
		nextGroupId: 1,
		currentGroupId: 0,
		membershipByToolCallId: new Map<string, ActionGroupMembership>(),
		memberCountByGroupId: new Map<number, number>(),
		expandedGroupIds: new Set<number>(),
	};
}

/** 开始一个新 turn，后续登记的工具调用归入新组。原地修改 state，无返回值。 */
export function beginActionGroupStep(state: ActionGroupState): void {
	state.currentGroupId = state.nextGroupId;
	state.nextGroupId += 1;
	state.memberCountByGroupId.set(state.currentGroupId, 0);
}

/**
 * 把一个工具调用登记到当前组。原地修改 state，无返回值。
 *
 * 重复登记同一个 toolCallId 时保持原归属，避免 Pi 重发事件导致序号错乱；
 * 后一次带上了摘要而先前没带上时，只补摘要。
 */
export function registerActionToolCall(
	state: ActionGroupState,
	toolCallId: string,
	summary?: string,
): void {
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
