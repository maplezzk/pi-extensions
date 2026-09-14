import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TOOL_ROW_GROUP_HEADER,
	TOOL_ROW_HIDDEN,
	TOOL_ROW_NORMAL,
	type ActionGroupMembership,
} from "../src/action-groups.ts";
import {
	resolveAssistantMessageHidden,
	resolveRunHeader,
	resolveToolRowMode,
	type ToolRowModeInput,
} from "../src/render-policy.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeState } from "../src/types.ts";

/** 造一个折叠、已结束、耗时已知的运行状态。 */
function collapsedState(): CleanModeState {
	return {
		collapsed: true,
		runSettled: true,
		runDurationMs: 266_000,
		userOverrodeThisRun: true,
	};
}

/** 造一个展开、耗时已知的运行状态。 */
function expandedState(): CleanModeState {
	return {
		collapsed: false,
		runSettled: true,
		runDurationMs: 266_000,
		userOverrodeThisRun: false,
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

test("展开时工作过程与未分组的工具行都原样渲染", () => {
	const state = expandedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	assert.equal(resolveAssistantMessageHidden({ state, config, kind: "work" }), false);
	assert.equal(resolveAssistantMessageHidden({ state, config, kind: "final" }), false);
	assert.equal(
		resolveToolRowMode(toolRowInput({ state, membership: undefined })),
		TOOL_ROW_NORMAL,
	);
});

test("折叠时工作过程整条隐藏，最终答案保留", () => {
	const state = collapsedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	assert.equal(resolveAssistantMessageHidden({ state, config, kind: "work" }), true);
	assert.equal(resolveAssistantMessageHidden({ state, config, kind: "final" }), false);
});

test("运行级折叠优先于动作组，工具行整行隐藏", () => {
	assert.equal(
		resolveToolRowMode(toolRowInput({ state: collapsedState() })),
		TOOL_ROW_HIDDEN,
	);
});

test("总开关关闭时一律原样渲染", () => {
	const state = collapsedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, enabled: false };

	assert.equal(resolveAssistantMessageHidden({ state, config, kind: "work" }), false);
	assert.equal(resolveToolRowMode(toolRowInput({ state, config })), TOOL_ROW_NORMAL);
	assert.equal(resolveRunHeader(state, config).visible, false);
});

test("折叠与展开两个方向都显示折叠头", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	const collapsed = resolveRunHeader(collapsedState(), config);
	assert.equal(collapsed.visible, true);
	assert.equal(collapsed.collapsed, true);

	const expanded = resolveRunHeader(expandedState(), config);
	assert.equal(expanded.visible, true, "展开态也要显示，否则没有点击收起的目标");
	assert.equal(expanded.collapsed, false);
});

test("耗时未知时不显示折叠头", () => {
	const state = { ...collapsedState(), runDurationMs: undefined };
	assert.equal(resolveRunHeader(state, { ...DEFAULT_CLEAN_MODE_CONFIG }).visible, false);
});

test("关闭 showRunHeader 后不显示折叠头", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, showRunHeader: false };
	assert.equal(resolveRunHeader(collapsedState(), config).visible, false);
});

test("组内只有一条时不做折叠，直接显示该工具行", () => {
	assert.equal(
		resolveToolRowMode(toolRowInput({ groupSize: 1 })),
		TOOL_ROW_NORMAL,
	);
});

test("未登记进动作组的工具行照常渲染", () => {
	assert.equal(
		resolveToolRowMode(toolRowInput({ membership: undefined })),
		TOOL_ROW_NORMAL,
	);
});

test("多条成员的组收起时只留首行当组头", () => {
	assert.equal(resolveToolRowMode(toolRowInput({ membership: { groupId: 1, index: 0 } })), TOOL_ROW_GROUP_HEADER);
	assert.equal(resolveToolRowMode(toolRowInput({ membership: { groupId: 1, index: 1 } })), TOOL_ROW_HIDDEN);
	assert.equal(resolveToolRowMode(toolRowInput({ membership: { groupId: 1, index: 2 } })), TOOL_ROW_HIDDEN);
});

test("组展开后逐条正常渲染", () => {
	const base = { groupExpanded: true };
	assert.equal(
		resolveToolRowMode(toolRowInput({ ...base, membership: { groupId: 1, index: 0 } })),
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
