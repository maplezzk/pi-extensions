import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TOOL_ROW_GROUP_HEADER,
	TOOL_ROW_HIDDEN,
	TOOL_ROW_NORMAL,
	type ActionGroupMembership,
} from "../src/action-groups.ts";
import {
	resolveAssistantMessageRender,
	resolveRunHeader,
	resolveToolRowMode,
	type AssistantRenderInput,
	type ToolRowModeInput,
} from "../src/render-policy.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeState } from "../src/types.ts";

/** 测试统一使用的已知耗时，避免在多处重复字面量。 */
const KNOWN_DURATION_MS = 266_000;

/** 造一个折叠、已结束、耗时已知的运行状态。 */
function collapsedState(): CleanModeState {
	return {
		collapsed: true,
		runSettled: true,
		runDurationMs: KNOWN_DURATION_MS,
		userOverrodeThisRun: true,
	};
}

/** 造一个展开、耗时已知的运行状态。 */
function expandedState(): CleanModeState {
	return {
		collapsed: false,
		runSettled: true,
		runDurationMs: KNOWN_DURATION_MS,
		userOverrodeThisRun: false,
	};
}

/** 造一条 assistant 消息的渲染输入，默认是「非承载者、耗时已知」的工作过程消息。 */
function assistantInput(overrides: Partial<AssistantRenderInput> = {}): AssistantRenderInput {
	return {
		state: expandedState(),
		config: { ...DEFAULT_CLEAN_MODE_CONFIG },
		kind: "work",
		isRunHeaderHost: false,
		durationMs: KNOWN_DURATION_MS,
		...overrides,
	};
}

/** 造一条工具行的渲染输入，默认是「组内首条、组内共 3 条、组已收起」。 */
function toolRowInput(overrides: Partial<ToolRowModeInput> = {}): ToolRowModeInput {
	const membership: ActionGroupMembership = { groupId: 1, index: 0 };
	return {
		state: expandedState(),
		config: { ...DEFAULT_CLEAN_MODE_CONFIG },
		membership,
		groupSize: 3,
		groupExpanded: false,
		...overrides,
	};
}

test("展开时工作过程内容与未分组的工具行都原样渲染", () => {
	const state = expandedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	assert.equal(resolveAssistantMessageRender(assistantInput({ state, config })).hideContent, false);
	assert.equal(
		resolveAssistantMessageRender(assistantInput({ state, config, kind: "final" })).hideContent,
		false,
	);
	assert.equal(
		resolveToolRowMode(toolRowInput({ state, membership: undefined })),
		TOOL_ROW_NORMAL,
	);
});

test("折叠时工作过程内容隐藏，最终答案保留", () => {
	const state = collapsedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	assert.equal(resolveAssistantMessageRender(assistantInput({ state, config })).hideContent, true);
	assert.equal(
		resolveAssistantMessageRender(assistantInput({ state, config, kind: "final" })).hideContent,
		false,
	);
});

test("折叠头只在承载者上显示，工作过程被折叠时仍然输出", () => {
	const state = collapsedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	const owner = resolveAssistantMessageRender(
		assistantInput({ state, config, isRunHeaderHost: true }),
	);
	assert.equal(owner.hideContent, true, "承载者是工作过程消息，内容应隐藏");
	assert.equal(owner.showHeader, true, "内容隐藏时折叠头必须保留，否则就没有任何提示");

	const nonOwner = resolveAssistantMessageRender(assistantInput({ state, config }));
	assert.equal(nonOwner.showHeader, false, "非承载者不应重复显示折叠头");
});

test("耗时为未知或关闭开关时不显示折叠头", () => {
	const state = collapsedState();

	assert.equal(
		resolveAssistantMessageRender(
			assistantInput({ state, isRunHeaderHost: true, durationMs: undefined }),
		).showHeader,
		false,
	);
	assert.equal(
		resolveAssistantMessageRender(
			assistantInput({
				state,
				config: { ...DEFAULT_CLEAN_MODE_CONFIG, showRunHeader: false },
				isRunHeaderHost: true,
			}),
		).showHeader,
		false,
	);
});

test("运行级折叠优先于动作组，工具行整行隐藏", () => {
	assert.equal(resolveToolRowMode(toolRowInput({ state: collapsedState() })), TOOL_ROW_HIDDEN);
});

test("总开关关闭时一律原样渲染", () => {
	const state = collapsedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, enabled: false };

	assert.equal(
		resolveAssistantMessageRender(assistantInput({ state, config })).hideContent,
		false,
	);
	assert.equal(resolveToolRowMode(toolRowInput({ state, config })), TOOL_ROW_NORMAL);
	assert.equal(
		resolveRunHeader({ config, durationMs: KNOWN_DURATION_MS, collapsed: true }).visible,
		false,
	);
});

test("折叠与展开两个方向都显示折叠头", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	const collapsed = resolveRunHeader({ config, durationMs: KNOWN_DURATION_MS, collapsed: true });
	assert.equal(collapsed.visible, true);
	assert.equal(collapsed.collapsed, true);

	const expanded = resolveRunHeader({ config, durationMs: KNOWN_DURATION_MS, collapsed: false });
	assert.equal(expanded.visible, true, "展开态也要显示，否则没有点击收起的目标");
	assert.equal(expanded.collapsed, false);
});

test("耗时未知时不显示折叠头", () => {
	const decision = resolveRunHeader({
		config: { ...DEFAULT_CLEAN_MODE_CONFIG },
		durationMs: undefined,
		collapsed: true,
	});
	assert.equal(decision.visible, false);
});

test("关闭 showRunHeader 后不显示折叠头", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, showRunHeader: false };
	assert.equal(resolveRunHeader({ config, durationMs: KNOWN_DURATION_MS, collapsed: true }).visible, false);
});

test("组内只有一条时也收成一行，不露原始工具输出", () => {
	assert.equal(
		resolveToolRowMode(toolRowInput({ groupSize: 1 })),
		TOOL_ROW_GROUP_HEADER,
	);
});

test("未登记进动作组的工具行照常渲染", () => {
	assert.equal(resolveToolRowMode(toolRowInput({ membership: undefined })), TOOL_ROW_NORMAL);
});

test("多条成员的组收起时只留首行当组头", () => {
	assert.equal(
		resolveToolRowMode(toolRowInput({ membership: { groupId: 1, index: 0 } })),
		TOOL_ROW_GROUP_HEADER,
	);
	assert.equal(
		resolveToolRowMode(toolRowInput({ membership: { groupId: 1, index: 1 } })),
		TOOL_ROW_HIDDEN,
	);
	assert.equal(
		resolveToolRowMode(toolRowInput({ membership: { groupId: 1, index: 2 } })),
		TOOL_ROW_HIDDEN,
	);
});

test("组展开后首行仍是组头，其余成员正常渲染", () => {
	const base = { groupExpanded: true };
	assert.equal(
		resolveToolRowMode(toolRowInput({ ...base, membership: { groupId: 1, index: 0 } })),
		TOOL_ROW_GROUP_HEADER,
		"组头行必须保留，否则展开后没有点击收回的目标",
	);
	assert.equal(
		resolveToolRowMode(toolRowInput({ ...base, membership: { groupId: 1, index: 1 } })),
		TOOL_ROW_NORMAL,
	);
	assert.equal(
		resolveToolRowMode(toolRowInput({ ...base, membership: { groupId: 1, index: 2 } })),
		TOOL_ROW_NORMAL,
	);
});

test("关闭动作组后不再生成组头", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, enableActionGroups: false };
	const input = toolRowInput({ config, membership: { groupId: 1, index: 1 } });
	assert.equal(resolveToolRowMode(input), TOOL_ROW_NORMAL);
});

test("运行中已开始聚合（工具聚合模式），停止后由运行级折叠收成完全聚合", () => {
	const running = { ...expandedState(), runSettled: false };

	assert.equal(
		resolveToolRowMode(toolRowInput({ state: running, membership: { groupId: 1, index: 0 } })),
		TOOL_ROW_GROUP_HEADER,
		"运行中组头就应出现，避免逐条刷屏",
	);
	assert.equal(
		resolveToolRowMode(toolRowInput({ state: running, membership: { groupId: 1, index: 1 } })),
		TOOL_ROW_HIDDEN,
	);

	// 停止后收起整轮，只剩耗时头与最终答案。
	const settled = { ...collapsedState() };
	assert.equal(
		resolveToolRowMode(toolRowInput({ state: settled, membership: { groupId: 1, index: 0 } })),
		TOOL_ROW_HIDDEN,
	);
});
