import assert from "node:assert/strict";
import { test } from "node:test";
import {
	beginActionGroupStep,
	areAllActionGroupsExpanded,
	createActionGroupState,
	extractToolCalls,
	findActionGroupMembership,
	getActionGroupActivityCounts,
	getActionGroupSize,
	hasNarrationText,
	isAssistantMessage,
	isActionGroupExpanded,
	reassignActionToolCall,
	registerActionToolCall,
	setAllActionGroupsExpanded,
	toggleActionGroup,
} from "../src/action-groups.ts";

/** 一个从未被分配过的组号，用于验证未知组的查询行为。 */
const UNKNOWN_GROUP_ID = 99;

test("新状态没有当前组，任何工具调用都未登记", () => {
	const state = createActionGroupState();
	assert.equal(findActionGroupMembership(state, "c1"), undefined);
	assert.equal(getActionGroupSize(state, 1), 0);
});

test("一个 turn 里的多条工具调用归入同一组并按顺序编号", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "c1" });
	registerActionToolCall(state, { toolCallId: "c2" });
	registerActionToolCall(state, { toolCallId: "c3" });

	assert.deepEqual(findActionGroupMembership(state, "c1"), { groupId: 1, index: 0 });
	assert.deepEqual(findActionGroupMembership(state, "c2"), { groupId: 1, index: 1 });
	assert.deepEqual(findActionGroupMembership(state, "c3"), { groupId: 1, index: 2 });
	assert.equal(getActionGroupSize(state, 1), 3);
});

test("下一个 turn 开新组，两组的编号各自独立", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "a1" });
	registerActionToolCall(state, { toolCallId: "a2" });

	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "b1" });

	assert.deepEqual(findActionGroupMembership(state, "a2"), { groupId: 1, index: 1 });
	assert.deepEqual(findActionGroupMembership(state, "b1"), { groupId: 2, index: 0 });
	assert.equal(getActionGroupSize(state, 1), 2);
	assert.equal(getActionGroupSize(state, 2), 1);
});

test("重复登记同一个工具调用不会改变其序号或成员数", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "c1", activity: "command" });
	registerActionToolCall(state, { toolCallId: "c1", activity: "command" });
	registerActionToolCall(state, { toolCallId: "c2" });

	assert.deepEqual(findActionGroupMembership(state, "c1"), { groupId: 1, index: 0 });
	assert.deepEqual(findActionGroupMembership(state, "c2"), { groupId: 1, index: 1 });
	assert.equal(getActionGroupSize(state, 1), 2);
	assert.deepEqual(
		getActionGroupActivityCounts(state, 1),
		{ command: 1 },
		"重复登记不能把同一次调用数两遍",
	);
});

test("分类计数按组分开，各自只数自己的成员", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "a1", activity: "read" });
	registerActionToolCall(state, { toolCallId: "a2", activity: "read" });
	registerActionToolCall(state, { toolCallId: "a3", activity: "command" });

	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "b1", activity: "command" });

	assert.deepEqual(getActionGroupActivityCounts(state, 1), { read: 2, command: 1 });
	assert.deepEqual(getActionGroupActivityCounts(state, 2), { command: 1 });
	assert.equal(getActionGroupActivityCounts(state, UNKNOWN_GROUP_ID), undefined);
});

test("分类省略时只记成员数，不留下空分类", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "c1" });

	assert.deepEqual(getActionGroupActivityCounts(state, 1), {});
});

test("组默认收起，切换后展开，再切换回收起", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);

	assert.equal(isActionGroupExpanded(state, 1), false);

	toggleActionGroup(state, 1);
	assert.equal(isActionGroupExpanded(state, 1), true);

	toggleActionGroup(state, 1);
	assert.equal(isActionGroupExpanded(state, 1), false);
});

test("展开状态按组隔离", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	beginActionGroupStep(state);

	toggleActionGroup(state, 2);
	assert.equal(isActionGroupExpanded(state, 1), false);
	assert.equal(isActionGroupExpanded(state, 2), true);
});

test("未知组的大小为 0，且不会被误判为已展开", () => {
	const state = createActionGroupState();
	assert.equal(getActionGroupSize(state, UNKNOWN_GROUP_ID), 0);
	assert.equal(isActionGroupExpanded(state, UNKNOWN_GROUP_ID), false);
});

/** 造一条带指定内容块的 assistant 消息。 */
function assistantMessageWith(content: unknown[]): Record<string, unknown> {
	return { role: "assistant", content };
}

test("带正文的 assistant 消息算作有解说", () => {
	assert.equal(hasNarrationText(assistantMessageWith([{ type: "text", text: "核对数据" }])), true);
});

test("只有空白正文或 thinking 时不算解说", () => {
	assert.equal(hasNarrationText(assistantMessageWith([{ type: "text", text: "   " }])), false);
	assert.equal(hasNarrationText(assistantMessageWith([{ type: "thinking", thinking: "想一想" }])), false);
	assert.equal(hasNarrationText(assistantMessageWith([])), false);
});

test("非对象或缺少 content 的输入按无解说处理", () => {
	assert.equal(hasNarrationText(undefined), false);
	assert.equal(hasNarrationText("text"), false);
	assert.equal(hasNarrationText({ role: "assistant" }), false);
});

test("角色判定只认 assistant", () => {
	assert.equal(isAssistantMessage({ role: "assistant" }), true);
	assert.equal(isAssistantMessage({ role: "user" }), false);
	assert.equal(isAssistantMessage(undefined), false);
});

test("批量展开把当前所有组都设为展开", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	beginActionGroupStep(state);

	assert.equal(areAllActionGroupsExpanded(state), false);
	setAllActionGroupsExpanded(state, true);
	assert.equal(areAllActionGroupsExpanded(state), true);
	assert.equal(isActionGroupExpanded(state, 1), true);
	assert.equal(isActionGroupExpanded(state, 2), true);

	setAllActionGroupsExpanded(state, false);
	assert.equal(areAllActionGroupsExpanded(state), false);
});

test("没有任何组时不算全部展开", () => {
	const state = createActionGroupState();
	assert.equal(areAllActionGroupsExpanded(state), false);
});

test("占位摘要让真摘要换掉，真摘要不被后到的占位或重复事件改写", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	registerActionToolCall(state, {
		toolCallId: "c1",
		summary: "运行命令",
		provisional: true,
		activity: "command",
	});
	registerActionToolCall(state, { toolCallId: "c1", summary: "运行命令 ls -la", activity: "command" });

	assert.equal(findActionGroupMembership(state, "c1")?.summary, "运行命令 ls -la", "占位摘要要被换掉");
	assert.equal(getActionGroupSize(state, state.currentGroupId), 1, "换摘要不该加成员");
	assert.equal(
		getActionGroupActivityCounts(state, state.currentGroupId)?.command,
		1,
		"换摘要也不该重复计数",
	);

	registerActionToolCall(state, {
		toolCallId: "c1",
		summary: "运行命令 占位",
		provisional: true,
		activity: "command",
	});
	assert.equal(
		findActionGroupMembership(state, "c1")?.summary,
		"运行命令 ls -la",
		"真摘要不能被后来的占位摘要盖掉",
	);
});

test("从消息内容里扫出工具调用，缺字段的内容块直接跳过", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "text", text: "说明" },
			{ type: "thinking", thinking: "先想一下" },
			{ type: "toolCall", id: "a1", name: "bash", arguments: { command: "ls" } },
			// 缺 id、缺 name、不是对象的块都不能让扫描抛错或造出半个调用。
			{ type: "toolCall", id: "", name: "bash", arguments: {} },
			{ type: "toolCall", id: "a3", arguments: {} },
			{ type: "toolCall", name: "bash" },
			"not a block",
		],
	};

	assert.deepEqual(extractToolCalls(message), [
		{ toolCallId: "a1", toolName: "bash", args: { command: "ls" } },
	]);
	assert.deepEqual(extractToolCalls({ role: "assistant" }), [], "没有 content 时返回空数组");
	assert.deepEqual(extractToolCalls(undefined), [], "非对象输入返回空数组");
});

test("改挂调用到当前组：旧组减一，分类计数跟着走", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "c1", summary: "运行命令 ls", activity: "command" });
	registerActionToolCall(state, { toolCallId: "c2", summary: "读取 a.ts", activity: "read" });
	const previous = state.currentGroupId;
	beginActionGroupStep(state);

	reassignActionToolCall(state, {
		toolCallId: "c2",
		summary: "读取 a.ts",
		activity: "read",
	});

	assert.equal(getActionGroupSize(state, previous), 1, "旧组只剩没挪走的那条");
	assert.equal(getActionGroupSize(state, state.currentGroupId), 1, "新组接到挪过来的一条");
	assert.equal(
		findActionGroupMembership(state, "c2")?.groupId,
		state.currentGroupId,
		"归属要指向新组",
	);
	assert.equal(
		getActionGroupActivityCounts(state, previous)?.read ?? 0,
		0,
		"旧组的读取计数要减一，不能留着幽灵计数",
	);
	assert.equal(getActionGroupActivityCounts(state, state.currentGroupId)?.read, 1, "新组计数加上");
});

test("改挂同组内的调用什么也不发生", () => {
	const state = createActionGroupState();
	beginActionGroupStep(state);
	registerActionToolCall(state, { toolCallId: "c1", summary: "运行命令 ls", activity: "command" });

	reassignActionToolCall(state, { toolCallId: "c1", summary: "运行命令 ls", activity: "command" });

	assert.equal(getActionGroupSize(state, state.currentGroupId), 1, "成员数不能变成 2");
	assert.equal(getActionGroupActivityCounts(state, state.currentGroupId)?.command, 1, "计数不能翻倍");
});
