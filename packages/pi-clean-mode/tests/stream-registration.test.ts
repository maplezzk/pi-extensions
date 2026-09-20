/**
 * 流式登记状态机的行为测试。
 *
 * 这里盯的是「顺序」：开组必须早于登记（否则解说后面那几个调用会落到上一组），
 * 登记必须早于 Pi 渲染那一行工具行（否则用户会先看到一行原样的工具调用、再突然被收进组里）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	beginActionGroupStep,
	createActionGroupState,
	findActionGroupMembership,
	getActionGroupSize,
} from "../src/action-groups.ts";
import {
	applyStreamedMessage,
	beginStreamedMessage,
	createStreamRegistration,
	type StreamedToolCall,
} from "../src/stream-registration.ts";

/** 所有调用都算「运行命令」，分类与摘要不是这组用例的重点。 */
function describe(call: StreamedToolCall): { summary: string; activity: "command" } {
	return { summary: `${call.toolName}:${call.toolCallId}`, activity: "command" };
}

/** 动作组状态：先开好第一个组，模拟 `agent_start`。 */
function createGroups(): ReturnType<typeof createActionGroupState> {
	const groups = createActionGroupState();
	beginActionGroupStep(groups);
	return groups;
}

/** 造一条流式 assistant 消息；`tail` 追加在参数里的内容块后面。 */
function assistantMessage(...content: unknown[]): unknown {
	return { role: "assistant", content };
}

/** 工具调用内容块。 */
function toolCall(id: string): unknown {
	return { type: "toolCall", id, name: "bash", arguments: { command: `echo ${id}` } };
}

/** 正文内容块。 */
function text(value: string): unknown {
	return { type: "text", text: value };
}

/** 把一条消息喂进状态机，返回结果。 */
function feed(
	state: ReturnType<typeof createStreamRegistration>,
	groups: ReturnType<typeof createActionGroupState>,
	message: unknown,
) {
	return applyStreamedMessage({ state, message, actionGroups: groups, describe });
}

test("解说先出现时，先开的组接住后面的工具调用", () => {
	const groups = createGroups();
	const state = createStreamRegistration();

	beginStreamedMessage(state, assistantMessage());
	const outcome = feed(state, groups, assistantMessage(text("我先看一眼"), toolCall("a1")));

	assert.equal(outcome.stepped, true, "带解说的消息应当开新组");
	assert.equal(outcome.registered.length, 1, "同一条消息里的调用应当被登记");
	assert.equal(
		findActionGroupMembership(groups, "a1")?.groupId,
		groups.currentGroupId,
		"调用要落在刚开的新组里",
	);
});

test("工具调用先出现、解说后到时，那几次调用跟着挪到新组", () => {
	const groups = createGroups();
	const firstGroup = groups.currentGroupId;
	const state = createStreamRegistration();

	beginStreamedMessage(state, assistantMessage());
	// 第一帧：只有工具调用，解说还没流出来 —— 先按当前组登记，工具行才能立刻被收起来。
	const first = feed(state, groups, assistantMessage(toolCall("a1")));
	assert.equal(first.stepped, false, "还没有解说，不该开新组");
	assert.equal(findActionGroupMembership(groups, "a1")?.groupId, firstGroup, "先落在上一组");

	// 第二帧：解说出现在工具调用后面 —— 组边界落在解说之后，调用要跟过去。
	const second = feed(state, groups, assistantMessage(toolCall("a1"), text("顺手再确认一下")));
	assert.equal(second.stepped, true, "解说晚到也要开新组");
	assert.equal(second.registered.length, 0, "同一次调用不能重复登记");
	const moved = groups.currentGroupId;
	assert.notEqual(moved, firstGroup, "前置条件：新组号应当变了");
	assert.equal(findActionGroupMembership(groups, "a1")?.groupId, moved, "调用要改挂到新组");
	assert.equal(getActionGroupSize(groups, firstGroup), 0, "上一组的成员数要减回去");
	assert.equal(getActionGroupSize(groups, moved), 1, "新组里只有这一条");
});

test("同一帧反复喂进来只登记一次，也不会反复开组", () => {
	const groups = createGroups();
	const state = createStreamRegistration();

	beginStreamedMessage(state, assistantMessage());
	const message = assistantMessage(text("说明"), toolCall("a1"));
	feed(state, groups, message);
	feed(state, groups, message);
	feed(state, groups, message);

	assert.equal(getActionGroupSize(groups, groups.currentGroupId), 1, "同一次调用只算一个成员");
});

test("开始一条新消息会清掉上一条的待办与登记", () => {
	const groups = createGroups();
	const state = createStreamRegistration();

	beginStreamedMessage(state, assistantMessage());
	feed(state, groups, assistantMessage(toolCall("a1")));
	assert.equal(state.toolCalls.length, 1, "登记列表里应有这一条");

	beginStreamedMessage(state, assistantMessage());
	assert.equal(state.toolCalls.length, 0, "新消息不该带着上一条的登记");
	assert.equal(state.narrationStepPending, true, "新消息重新等着开组");

	// 新消息只有工具调用：不应再开组，直接落进当前组。
	const outcome = feed(state, groups, assistantMessage(toolCall("a2")));
	assert.equal(outcome.stepped, false, "没有解说就不开组");
	assert.equal(findActionGroupMembership(groups, "a2")?.groupId, groups.currentGroupId);
});

test("非 assistant 消息不改动状态机", () => {
	const groups = createGroups();
	const state = createStreamRegistration();

	beginStreamedMessage(state, assistantMessage());
	beginStreamedMessage(state, { role: "user", content: [text("用户消息")] });
	assert.equal(state.narrationStepPending, true, "user 消息不该清掉 assistant 的待办");

	const outcome = feed(state, groups, { role: "toolResult", content: [text("结果")] });
	assert.equal(outcome.stepped, false, "toolResult 不该开组");
	assert.equal(outcome.registered.length, 0, "toolResult 里没有工具调用可登记");
});
