/**
 * 用 Pi 真实导出的组件跑补丁冒烟测试。
 *
 * 前面的 prototype-patch 单测用的是假原型，只能证明补丁骨架正确；
 * 这里直接实例化 Pi 的 AssistantMessageComponent 与 ToolExecutionComponent，
 * 证明折叠、保留最终答案、折叠头、鼠标点击与还原在真实组件上都成立。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	beginActionGroupStep,
	createActionGroupState,
	findActionGroupMembership,
	getActionGroupSize,
	isActionGroupExpanded,
	registerActionToolCall,
	toggleActionGroup,
	type ActionGroupState,
} from "../src/action-groups.ts";
import { installComponentPatches } from "../src/component-patches.ts";
import { formatDuration } from "../src/duration.ts";
import { i18n } from "../src/i18n.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type CleanModeState } from "../src/types.ts";

/** 渲染宽度。 */
const WIDTH = 80;
/** 本次运行的耗时；折叠头文案由它推导，避免两处取值漂移。 */
const RUN_DURATION_MS = 266_000;
/** 折叠头里应当出现的耗时文案。 */
const HEADER_FRAGMENT = formatDuration(RUN_DURATION_MS);
/** 三条成员的组头文案；由 i18n 推导，避免与实现里的文案漂移。 */
const GROUP_HEADER_FRAGMENT = i18n.t("actionGroupHeader", { count: "3" });
/** 工具调用 id。 */
const TOOL_CALL_ID = "call-1";
/** 最终答案的正文。 */
const FINAL_TEXT = "final answer body";
/** 工作过程的解说正文。 */
const WORK_TEXT = "intermediate narration";
/** 工具行构造用的工作目录。 */
const TOOL_CWD = "/tmp";
/** 折叠头的行号；折叠头子组件输出「空行 + 折叠头」，所以落在第 1 行。 */
const HEADER_ROW = 1;
/** 折叠头上方空行的行号；它与折叠头属于同一个点击块。 */
const HEADER_BLANK_ROW = 0;
/** 折叠且已结束的运行状态。 */
const COLLAPSED_STATE: CleanModeState = {
	collapsed: true,
	runSettled: true,
	runDurationMs: RUN_DURATION_MS,
	userOverrodeThisRun: true,
};
/** 展开状态。 */
const EXPANDED_STATE: CleanModeState = { ...COLLAPSED_STATE, collapsed: false };

// 工具行组件在构造阶段就会取主题色；先初始化主题，测试进程里不开 watcher。
initTheme("dark", false);

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
function toolComponent(toolCallId: string = TOOL_CALL_ID): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"read",
		toolCallId,
		{ path: "a.ts" },
		{},
		undefined,
		{ requestRender: () => {} },
		TOOL_CWD,
	);
}

/** 造一个落在指定行号的左键 click 事件。 */
function clickAt(row: number, height: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 1,
		y: row,
		screenX: 1,
		screenY: row + 1,
		width: WIDTH,
		height,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

/** 安装补丁后交给用例的解手：可直接操作动作组状态并读取计数回调。 */
interface PatchHarness {
	/** 动作组状态，用例可直接开组、登记工具调用与切换展开。 */
	actionGroups: ActionGroupState;
	/** 运行级折叠被切换的次数。 */
	runToggles: () => number;
	/** 动作组被切换的次数。 */
	groupToggles: () => number;
}

/** 装一次补丁、跑断言、无论成败都还原，避免测试间互相污染。 */
function withPatches(
	state: CleanModeState,
	config: CleanModeConfig,
	run: (harness: PatchHarness) => void,
): void {
	const actionGroups = createActionGroupState();
	let runToggleCount = 0;
	let groupToggleCount = 0;
	const restore = installComponentPatches({
		getState: () => state,
		getConfig: () => config,
		styleHeader: (text) => text,
		onToggle: () => {
			// 只计数，用于断言鼠标点击是否真的触发了运行级切换。
			runToggleCount += 1;
		},
		getToolRowGroup: (toolCallId) => {
			const membership = findActionGroupMembership(actionGroups, toolCallId);
			if (!membership) {
				return undefined;
			}
			return {
				membership,
				groupSize: getActionGroupSize(actionGroups, membership.groupId),
				groupExpanded: isActionGroupExpanded(actionGroups, membership.groupId),
			};
		},
		onToggleActionGroup: (groupId) => {
			toggleActionGroup(actionGroups, groupId);
			groupToggleCount += 1;
		},
	});
	try {
		run({
			actionGroups,
			runToggles: () => runToggleCount,
			groupToggles: () => groupToggleCount,
		});
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
		assert.ok(!rendered.includes(HEADER_FRAGMENT), "工作过程消息不应有折叠头");
	});
});

test("展开态的最终答案仍然显示折叠头以便点击收起", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		const component = new AssistantMessageComponent(finalMessage());
		const rendered = linesOf(component).join("\n");

		assert.ok(rendered.includes(HEADER_FRAGMENT), `展开态缺少折叠头：${rendered}`);
		assert.ok(rendered.includes(FINAL_TEXT), `最终答案正文丢失：${rendered}`);
	});
});

test("折叠时工具行渲染为 0 行", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		assert.deepEqual(linesOf(toolComponent()), []);
	});
});

test("鼠标点击折叠头块会触发切换，点击正文不会", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const component = new AssistantMessageComponent(finalMessage());
		const height = linesOf(component).length;

		component.handleMouse(clickAt(HEADER_ROW, height));
		assert.equal(harness.runToggles(), 1, "点击折叠头应触发一次切换");

		component.handleMouse(clickAt(HEADER_BLANK_ROW, height));
		assert.equal(harness.runToggles(), 2, "折叠头上方的空行属于同一点击块，也应切换");

		component.handleMouse(clickAt(height - 1, height));
		assert.equal(harness.runToggles(), 2, "点击正文不应触发切换");
	});
});

test("折叠头不可见时不占用行也就不响应点击", () => {
	const config = { ...DEFAULT_CLEAN_MODE_CONFIG, showRunHeader: false };
	withPatches(COLLAPSED_STATE, config, (harness) => {
		const component = new AssistantMessageComponent(finalMessage());
		const height = linesOf(component).length;

		component.handleMouse(clickAt(HEADER_ROW, height));
		assert.equal(harness.runToggles(), 0, "没有折叠头时点击第 1 行不应切换");
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

/** 造一个已登记 n 条工具调用的动作组，并返回这些工具调用 id。 */
function seedActionGroup(actionGroups: ActionGroupState, count: number): string[] {
	beginActionGroupStep(actionGroups);
	const ids: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const id = `group-${actionGroups.currentGroupId}-${index}`;
		registerActionToolCall(actionGroups, id);
		ids.push(id);
	}
	return ids;
}

test("组内只有一条时直接显示该工具行本身", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const [onlyId] = seedActionGroup(harness.actionGroups, 1);
		const rendered = linesOf(toolComponent(onlyId)).join("\n");

		assert.ok(!rendered.includes(GROUP_HEADER_FRAGMENT), `单条组不应出现组头：${rendered}`);
		assert.ok(rendered.includes("read"), `应显示工具行本身：${rendered}`);
	});
});

test("多条成员的组收起时只渲染一条组头", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);

		const headLines = linesOf(toolComponent(ids[0]));
		assert.equal(headLines.length, 2, "组头应为空行加组头一行");
		const rendered = headLines.join("\n");
		assert.ok(
			rendered.includes(GROUP_HEADER_FRAGMENT),
			`组头应包含计数：${rendered}`,
		);

		assert.deepEqual(linesOf(toolComponent(ids[1])), [], "组内非首行收起时应隐藏");
		assert.deepEqual(linesOf(toolComponent(ids[2])), [], "组内非首行收起时应隐藏");
	});
});

test("组展开后成员逐条渲染，组头行依然保留", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		toggleActionGroup(harness.actionGroups, 1);

		const headRendered = linesOf(toolComponent(ids[0])).join("\n");
		assert.ok(
			headRendered.includes(GROUP_HEADER_FRAGMENT),
			`展开后组头行应保留，否则无法点击收回：${headRendered}`,
		);
		assert.ok(headRendered.includes("read"), `组头行应同时带上自己的内容：${headRendered}`);

		for (const id of ids.slice(1)) {
			const rendered = linesOf(toolComponent(id)).join("\n");
			assert.ok(!rendered.includes(GROUP_HEADER_FRAGMENT), `非首行不应有组头：${rendered}`);
			assert.ok(rendered.length > 0, "展开后每个成员都应有内容");
		}
	});
});

test("组展开后点击组头仍能收起该组", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		toggleActionGroup(harness.actionGroups, 1);

		const head = toolComponent(ids[0]);
		linesOf(head);
		head.handleMouse(clickAt(0, HEADER_ROW + 1));
		assert.equal(harness.groupToggles(), 1, "展开态点击组头也应触发切换");
	});
});

test("鼠标点击组头切换该动作组，非组头行透传给 Pi", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 2);

		const head = toolComponent(ids[0]);
		linesOf(head);
		head.handleMouse(clickAt(0, 1));
		assert.equal(harness.groupToggles(), 1, "点击组头应触发一次动作组切换");

		const member = toolComponent(ids[1]);
		linesOf(member);
		member.handleMouse(clickAt(0, 1));
		assert.equal(harness.groupToggles(), 1, "点击组内成员不应切换动作组");
	});
});

test("运行级折叠优先于动作组，组头也一并隐藏", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		for (const id of ids) {
			assert.deepEqual(linesOf(toolComponent(id)), [], "运行折叠时所有工具行都应隐藏");
		}
	});
});
