import assert from "node:assert/strict";
import { test } from "node:test";
import {
	resolveAssistantMessageHidden,
	resolveRunHeader,
	resolveToolMessageRender,
} from "../src/render-policy.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeState } from "../src/types.ts";

/** 造一个折叠、已结束、耗时已知的状态。 */
function collapsedState(): CleanModeState {
	return {
		collapsed: true,
		runSettled: true,
		runDurationMs: 266_000,
		userOverrodeThisRun: true,
	};
}

test("展开时工作过程与工具行都原样渲染", () => {
	const state: CleanModeState = { collapsed: false, runSettled: true, userOverrodeThisRun: false };
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	assert.equal(
		resolveAssistantMessageHidden({ state, config, kind: "work" }),
		false,
	);
	assert.equal(
		resolveAssistantMessageHidden({ state, config, kind: "final" }),
		false,
	);
	assert.deepEqual(resolveToolMessageRender(state, config), { hidden: false });
});

test("折叠时工作过程整条隐藏，最终答案保留", () => {
	const state = collapsedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	assert.equal(resolveAssistantMessageHidden({ state, config, kind: "work" }), true);
	assert.equal(resolveAssistantMessageHidden({ state, config, kind: "final" }), false);
});

test("折叠时工具行整行隐藏", () => {
	const state = collapsedState();
	assert.deepEqual(resolveToolMessageRender(state, { ...DEFAULT_CLEAN_MODE_CONFIG }), {
		hidden: true,
	});
});

test("总开关关闭时一律原样渲染", () => {
	const state = collapsedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, enabled: false };

	assert.equal(resolveAssistantMessageHidden({ state, config, kind: "work" }), false);
	assert.deepEqual(resolveToolMessageRender(state, config), { hidden: false });
	assert.equal(resolveRunHeader(state, config).visible, false);
});

test("折叠与展开两个方向都显示折叠头", () => {
	const state = collapsedState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	const collapsed = resolveRunHeader(state, config);
	assert.equal(collapsed.visible, true);
	assert.equal(collapsed.collapsed, true);

	const expanded = resolveRunHeader({ ...state, collapsed: false }, config);
	assert.equal(expanded.visible, true, "展开态也要显示，否则没有点击收起的目标");
	assert.equal(expanded.collapsed, false);
});

test("耗时未知时不显示折叠头", () => {
	const state = { ...collapsedState(), runDurationMs: undefined };
	const decision = resolveRunHeader(state, { ...DEFAULT_CLEAN_MODE_CONFIG });
	assert.equal(decision.visible, false);
});

test("关闭 showRunHeader 后不显示折叠头", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, showRunHeader: false };
	const decision = resolveRunHeader(collapsedState(), config);
	assert.equal(decision.visible, false);
});
