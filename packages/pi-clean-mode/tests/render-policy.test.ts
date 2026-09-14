import assert from "node:assert/strict";
import { test } from "node:test";
import {
	resolveAssistantMessageRender,
	resolveToolMessageRender,
} from "../src/render-policy.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeState } from "../src/types.ts";

/** 造一个折叠态、已结束、耗时已知的状态。 */
function collapsedSettledState(): CleanModeState {
	return {
		collapsed: true,
		runSettled: true,
		runDurationMs: 266_000,
		userOverrodeThisRun: true,
	};
}

test("展开时 assistant 消息与工具行都原样渲染", () => {
	const state: CleanModeState = { collapsed: false, runSettled: true, userOverrodeThisRun: false };
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	assert.deepEqual(
		resolveAssistantMessageRender({ state, config, kind: "work" }),
		{ hidden: false, showHeader: false },
	);
	assert.deepEqual(resolveAssistantMessageRender({ state, config, kind: "final" }), {
		hidden: false,
		showHeader: false,
	});
	assert.deepEqual(resolveToolMessageRender(state, config), { hidden: false });
});

test("折叠时工作过程整条隐藏，最终答案保留", () => {
	const state = collapsedSettledState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG };

	assert.deepEqual(
		resolveAssistantMessageRender({ state, config, kind: "work" }),
		{ hidden: true, showHeader: false },
	);
	assert.deepEqual(resolveAssistantMessageRender({ state, config, kind: "final" }), {
		hidden: false,
		showHeader: true,
	});
});

test("折叠时工具行整行隐藏", () => {
	const state = collapsedSettledState();
	assert.deepEqual(resolveToolMessageRender(state, { ...DEFAULT_CLEAN_MODE_CONFIG }), {
		hidden: true,
	});
});

test("本次运行尚未结束时最终答案也不加折叠头", () => {
	const state = { ...collapsedSettledState(), runSettled: false };
	const decision = resolveAssistantMessageRender({
		state,
		config: { ...DEFAULT_CLEAN_MODE_CONFIG },
		kind: "final",
	});
	assert.deepEqual(decision, { hidden: false, showHeader: false });
});

test("关闭 showRunHeader 后最终答案只显示正文", () => {
	const state = collapsedSettledState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, showRunHeader: false };
	const decision = resolveAssistantMessageRender({ state, config, kind: "final" });
	assert.deepEqual(decision, { hidden: false, showHeader: false });
});

test("耗时未知时不加折叠头", () => {
	const state = { ...collapsedSettledState(), runDurationMs: undefined };
	const decision = resolveAssistantMessageRender({
		state,
		config: { ...DEFAULT_CLEAN_MODE_CONFIG },
		kind: "final",
	});
	assert.deepEqual(decision, { hidden: false, showHeader: false });
});

test("总开关关闭时一律原样渲染", () => {
	const state = collapsedSettledState();
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, enabled: false };

	assert.deepEqual(
		resolveAssistantMessageRender({ state, config, kind: "work" }),
		{ hidden: false, showHeader: false },
	);
	assert.deepEqual(resolveToolMessageRender(state, config), { hidden: false });
});
