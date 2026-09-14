/**
 * 用 Pi 真实导出的组件跑一次补丁冒烟测试。
 *
 * 前面的 prototype-patch 单测用的是假原型，只能证明补丁骨架正确；
 * 这里直接实例化 Pi 的 AssistantMessageComponent 与 ToolExecutionComponent，
 * 证明折叠、保留最终答案、加折叠头、还原四种行为在真实组件上都成立。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { installComponentPatches } from "../src/component-patches.ts";
import { formatDuration } from "../src/duration.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type CleanModeState } from "../src/types.ts";

/** 渲染宽度。 */
const WIDTH = 80;
/** 本次运行的耗时；折叠头文案由它推导，避免两处取值漂移。 */
const RUN_DURATION_MS = 266_000;
/** 折叠头里应当出现的耗时文案。 */
const HEADER_FRAGMENT = formatDuration(RUN_DURATION_MS);
/** 工具调用 id。 */
const TOOL_CALL_ID = "call-1";
/** 最终答案的正文。 */
const FINAL_TEXT = "final answer body";
/** 工作过程的解说正文。 */
const WORK_TEXT = "intermediate narration";
/** 工具行构造用的工作目录。 */
const TOOL_CWD = "/tmp";

// 工具行组件在构造阶段就会取主题色；先初始化主题，测试进程里不开 watcher。
initTheme("dark", false);
/** 折叠且已结束的运行状态。 */
const COLLAPSED_STATE: CleanModeState = {
	collapsed: true,
	runSettled: true,
	runDurationMs: RUN_DURATION_MS,
	userOverrodeThisRun: true,
};
/** 展开状态。 */
const EXPANDED_STATE: CleanModeState = { ...COLLAPSED_STATE, collapsed: false };

/** 造一条带 tool call 的 assistant 消息，即工作过程解说。 */
function workMessage(): Record<string, unknown> {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: WORK_TEXT },
			{ type: "toolCall", id: TOOL_CALL_ID, name: "read", arguments: {} },
		],
		stopReason: "toolUse",
	};
}

/** 造一条不带 tool call 的 assistant 消息，即最终答案。 */
function finalMessage(): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text: FINAL_TEXT }],
		stopReason: "stop",
	};
}

/**
 * 造一个工具行组件；
 * `ui` 只提供 requestRender 以便满足构造要求，不参与本测试的断言。
 */
function toolComponent(): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"read",
		TOOL_CALL_ID,
		{ path: "a.ts" },
		{},
		undefined,
		{ requestRender: () => {} },
		TOOL_CWD,
	);
}

/** 装一次补丁、跑断言、无论成败都还原，避免测试间互相污染。 */
function withPatches(state: CleanModeState, config: CleanModeConfig, run: () => void): void {
	const restore = installComponentPatches({
		getState: () => state,
		getConfig: () => config,
		styleHeader: (text) => text,
	});
	try {
		run();
	} finally {
		restore();
	}
}

/** 以固定宽度渲染组件并取出文本行。 */
function linesOf(component: { render(width: number): string[] }): string[] {
	return component.render(WIDTH);
}

test("折叠时带 tool call 的 assistant 消息渲染为 0 行", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		const component = new AssistantMessageComponent(workMessage());
		assert.deepEqual(linesOf(component), []);
	});
});

test("折叠时不带 tool call 的消息保留正文并带上耗时头", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		const component = new AssistantMessageComponent(finalMessage());
		const rendered = linesOf(component).join("\n");

		assert.ok(rendered.includes(HEADER_FRAGMENT), `折叠头缺少耗时：${rendered}`);
		assert.ok(rendered.includes(FINAL_TEXT), `最终答案正文丢失：${rendered}`);
	});
});

test("展开时带 tool call 的消息照常渲染正文", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		const component = new AssistantMessageComponent(workMessage());
		const rendered = linesOf(component).join("\n");

		assert.ok(rendered.includes(WORK_TEXT), `展开后解说丢失：${rendered}`);
		assert.ok(!rendered.includes(HEADER_FRAGMENT), "展开时不应出现折叠头");
	});
});

test("折叠时工具行渲染为 0 行", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		assert.deepEqual(linesOf(toolComponent()), []);
	});
});

test("关闭 showRunHeader 后最终答案不带耗时头", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, showRunHeader: false };
	withPatches(COLLAPSED_STATE, config, () => {
		const component = new AssistantMessageComponent(finalMessage());
		const rendered = linesOf(component).join("\n");

		assert.ok(rendered.includes(FINAL_TEXT), `最终答案正文丢失：${rendered}`);
		assert.ok(!rendered.includes(HEADER_FRAGMENT), "不应出现折叠头");
	});
});

test("总开关关闭时真实组件完全不受影响", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, enabled: false };
	withPatches(COLLAPSED_STATE, config, () => {
		const work = new AssistantMessageComponent(workMessage());
		const final = new AssistantMessageComponent(finalMessage());

		assert.ok(linesOf(work).join("\n").includes(WORK_TEXT));
		assert.ok(!linesOf(final).join("\n").includes(HEADER_FRAGMENT));
		assert.ok(linesOf(toolComponent()).length > 0);
	});
});

test("还原后真实组件恢复原始渲染", () => {
	const work = new AssistantMessageComponent(workMessage());
	const tool = toolComponent();

	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		assert.deepEqual(linesOf(work), []);
	});

	assert.ok(linesOf(work).join("\n").includes(WORK_TEXT), "还原后解说应当可见");
	assert.ok(linesOf(tool).length > 0, "还原后工具行应当可见");
});
