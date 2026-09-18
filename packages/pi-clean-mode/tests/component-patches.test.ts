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
import { visibleWidth } from "@earendil-works/pi-tui";
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
import { createHeaderStyler, type ThemePainter } from "../src/header-style.ts";
import { i18n } from "../src/i18n.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type CleanModeState } from "../src/types.ts";

/** 渲染宽度。 */
const WIDTH = 80;
/** 本次运行的耗时；折叠头文案由它推导，避免两处取值漂移。 */
const RUN_DURATION_MS = 266_000;
/** 本次运行的工具调用数；折叠头文案由它推导。 */
const RUN_STEPS = 5;
/** 折叠头右侧展示的展开快捷键；由扩展入口注入，测试里固定为一个值。 */
const EXPAND_HINT = "f2";
/** 透明主题：测试断言明文，不关心颜色，但保留横条的截断与补齐行为。 */
const PLAIN_THEME: ThemePainter = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};
/** 折叠头里应当出现的耗时文案。 */
const HEADER_FRAGMENT = formatDuration(RUN_DURATION_MS);
/** 运行级折叠头的完整标签（含耗时），用来量它的起始列。 */
const RUN_HEADER_LABEL = i18n.t("runHeader", { duration: formatDuration(RUN_DURATION_MS) });
/** 步数文案；箭头紧跟在它右边。 */
const RUN_HEADER_STEPS = i18n.t("runHeaderSteps", { count: String(RUN_STEPS) });
/** 三条成员的组头文案；由 i18n 推导，避免与实现里的文案漂移。 */
const GROUP_HEADER_FRAGMENT = i18n.t("actionGroupHeader", { count: "3" });
/** 单条动作的组头摘要；组内只有一条时直接用它当组头文案。 */
const SINGLE_ACTION_SUMMARY = "运行命令 ls -la";
/** 活动块里的动作行；块里全是普通行，不铺底色。 */
const ACTIVITY_ROW = "    │ ⠹ 运行命令 npm test";
/** 活动块里跟在动作行后面的输出尾巴。 */
const ACTIVITY_TAIL_ROW = "      │ ↳ 12 passing";
/**
 * 轮首槽位的状态行：只报在处理与耗时。
 *
 * 它与活动块首行各报各的，所以断言要整行比，不能用子串比。
 */
const RUN_STATUS_ROW = "  │ ⠋ 处理中 · 7s";
/** 活动行首行在组件里的行号：折叠头子组件输出「空行 + 活动行」，所以是第 1 行。 */
const ACTIVITY_HEAD_ROW = 1;
/** 工具调用 id。 */
const TOOL_CALL_ID = "call-1";
/** 最终答案的正文。 */
const FINAL_TEXT = "final answer body";
/** thinking 块的正文；开启 hideThinking 后它不应出现在任何渲染行里。 */
const THINKING_TEXT = "secret reasoning body";
/** 工作过程的解说正文。 */
const WORK_TEXT = "intermediate narration";
/** 工具行构造用的工作目录。 */
const TOOL_CWD = "/tmp";
/** 折叠头的行号；折叠头子组件输出「空行 + 折叠头」，所以落在第 1 行。 */
const HEADER_ROW = 1;
/** 两级折叠头共用的左缩进列数：组头文案不再比运行级多缩一级。 */
const HEADER_INDENT_COLUMNS = 2;
/** 展开态箭头：实心下三角。 */
const EXPANDED_CHEVRON = "▼";
/** 收起态箭头：实心右三角；动作组默认就是收起态。 */
const COLLAPSED_CHEVRON = "▶";
/** 文案与箭头之间的空格数。 */
const CHEVRON_GAP_COLUMNS = 1;
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

/** 造一条带 thinking 的最终答案消息：用来验证 thinking 被整个抽掉、不留占位行。 */
function thinkingMessage(): Record<string, unknown> {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: THINKING_TEXT },
			{ type: "text", text: FINAL_TEXT },
		],
		stopReason: "stop",
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
	/** 当前要展示的实时活动行；用例可直接改它模拟运行中。 */
	activityLines: string[];
	/** 活动块在「组内只有一条」时的形态：去掉动作名，只留思考与输出尾巴。 */
	activityDetailLines: string[];
	/** 接在当前组组头后面的分类计数后缀；空串表示还没计数。 */
	activityCounters: string;
	/** 组头主词（如「运行命令」）；undefined 表示组内没有过半分类，组头用通用词。 */
	groupActivityLabel: string | undefined;
	/** 轮首槽位的状态行（只在在处理 + 耗时）；用例可直接改它模拟运行中。 */
	runStatusLines: string[];
	/** 运行级折叠被切换的次数。 */
	runToggles: () => number;
	/** 动作组被切换的次数。 */
	groupToggles: () => number;
}

/** `withPatches` 的可选行为开关。 */
interface PatchOptions {
	/**
	 * 承载者是否直接拿到已知耗时；默认 true。
	 *
	 * 运行中的用例设为 false：真实运行期间耗时还没写入（`agent_settled` 才记），
	 * 轮首槽位里应当装的是「处理中」状态横条，而不是耗时横条。
	 */
	runHeaderHasDuration?: boolean;
}

/** 装一次补丁、跑断言或渲染、无论成败都还原，避免测试间互相污染。 */
function withPatches<T>(
	state: CleanModeState,
	config: CleanModeConfig,
	run: (harness: PatchHarness) => T,
	options: PatchOptions = {},
): T {
	const actionGroups = createActionGroupState();
	const durations = new WeakMap<object, number>();
	const activityLines: string[] = [];
	const activityDetailLines: string[] = [];
	const harness: { activityCounters: string; groupActivityLabel: string | undefined } = {
		activityCounters: "",
		groupActivityLabel: undefined,
	};
	const runStatusLines: string[] = [];
	let runHeaderAssigned = false;
	let runHeaderHost: object | undefined;
	let runToggleCount = 0;
	let groupToggleCount = 0;
	const restore = installComponentPatches({
		getState: () => state,
		getConfig: () => config,
		styler: createHeaderStyler(PLAIN_THEME),
		expandHint: EXPAND_HINT,
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
				...(membership.summary === undefined ? {} : { summary: membership.summary }),
			};
		},
		onToggleActionGroup: (groupId) => {
			toggleActionGroup(actionGroups, groupId);
			groupToggleCount += 1;
		},
		claimRunHeaderHost: (host) => {
			// 每轮只让第一个来认领的实例成为承载者；耗时已知时顺便记上。
			if (runHeaderAssigned) {
				return false;
			}
			runHeaderAssigned = true;
			runHeaderHost = host;
			if (options.runHeaderHasDuration ?? true) {
				durations.set(host, RUN_DURATION_MS);
			}
			return true;
		},
		isCurrentRunHost: (host) => host === runHeaderHost,
		getActivityLines: () => activityLines,
		getActivityDetailLines: () => activityDetailLines,
		getActivityCounters: () => harness.activityCounters,
		getRunStatusLines: () => runStatusLines,
		isCurrentActionGroup: (groupId) => groupId === actionGroups.currentGroupId,
		getGroupActivityLabel: () => harness.groupActivityLabel,
		getRunDuration: (host) => durations.get(host),
		getRunSteps: () => RUN_STEPS,
	});
	try {
		return run({
			actionGroups,
			activityLines,
			activityDetailLines,
			get activityCounters(): string {
				return harness.activityCounters;
			},
			set activityCounters(value: string) {
				harness.activityCounters = value;
			},
			get groupActivityLabel(): string | undefined {
				return harness.groupActivityLabel;
			},
			set groupActivityLabel(value: string | undefined) {
				harness.groupActivityLabel = value;
			},
			runStatusLines,
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

/**
 * 让活动块在两种形态下都输出同样几行。
 *
 * 不关心组内条数的用例用它；只有要验证「单条组不重复动作名」时才分别摆两种形态。
 */
function seedActivityBlock(harness: PatchHarness, rows: string[]): void {
	harness.activityLines.push(...rows);
	harness.activityDetailLines.push(...rows);
}

/** 去掉 ANSI 转义，只留可见文本。 */
function stripAnsi(line: string): string {
	return line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** 子串在行内的起始列；含全角字符时不能用字符串下标当列号。 */
function columnOf(line: string, marker: string): number {
	const index = line.indexOf(marker);
	return index === -1 ? -1 : visibleWidth(line.slice(0, index));
}

/** 断言箭头紧跟在指定文案（该行箭头前最后一段可见文字）右边，只隔 CHEVRON_GAP_COLUMNS 格。 */
function assertChevronFollowsLabel(line: string, label: string, chevron: string): void {
	const labelColumn = columnOf(line, label);
	assert.ok(labelColumn >= 0, `前置条件：行内应出现文案：${JSON.stringify(line)}`);
	const expected = labelColumn + visibleWidth(label) + CHEVRON_GAP_COLUMNS;
	assert.equal(
		columnOf(line, chevron),
		expected,
		`箭头应紧跟在文案右边：${JSON.stringify(line)}`,
	);
}

test("本轮还没有工具行时，轮首只画状态行", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		harness.activityLines.push(RUN_STATUS_ROW, ACTIVITY_ROW);
		harness.runStatusLines.push(RUN_STATUS_ROW);
		const component = new AssistantMessageComponent(workMessage());
		const lines = linesOf(component);

		const head = lines[ACTIVITY_HEAD_ROW];
		assert.equal(head?.trimEnd(), RUN_STATUS_ROW, "状态行应落在空行之后的第一行");
		// 首行被当做状态横条渲染（styler.band），band 会按宽度补齐到整行。
		assert.equal(
			visibleWidth(head ?? ""),
			WIDTH,
			`状态行应铺满整行：${JSON.stringify(head)}`,
		);
		assert.deepEqual(
			lines.slice(0, ACTIVITY_HEAD_ROW + 1).map((line) => line.trimEnd()),
			["", RUN_STATUS_ROW],
			"状态行应在工作过程正文之前",
		);
		assert.ok(!lines.join("\n").includes(ACTIVITY_ROW), `轮首不应出现思考与工具细节：${lines.join("\n")}`);
	});
});

test("组头带上当前组的分类计数后缀", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		harness.activityCounters = ` · ${i18n.t("activityCounterRead", { count: "4" })} · ${i18n.t("activityCounterCommand", { count: "1" })}`;

		const groupHeader = linesOf(toolComponent(ids[0])).find((line) =>
			line.includes(GROUP_HEADER_FRAGMENT),
		);
		assert.ok(groupHeader, "前置条件：应渲染出组头行");
		assert.ok(
			groupHeader.includes(i18n.t("activityCounterRead", { count: "4" })),
			`组头应带上读取计数：${groupHeader}`,
		);
		assert.equal(
			columnOf(groupHeader, GROUP_HEADER_FRAGMENT),
			HEADER_INDENT_COLUMNS,
			"计数后缀不能把组头文案挤离缩进列",
		);
		assertChevronFollowsLabel(
			groupHeader,
			i18n.t("activityCounterCommand", { count: "1" }),
			COLLAPSED_CHEVRON,
		);
	});
});

test("历史组的组头不带分类计数", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: "call-next", summary: SINGLE_ACTION_SUMMARY });
		harness.activityCounters = " · 读取 4";

		const oldHeader = linesOf(toolComponent(ids[0])).find((line) =>
			line.includes(GROUP_HEADER_FRAGMENT),
		);
		assert.ok(oldHeader, "前置条件：历史组头仍应渲染");
		assert.ok(
			!oldHeader.includes(i18n.t("activityCounterRead", { count: "4" })),
			`历史组不该显示本轮累计计数：${oldHeader}`,
		);
	});
});

test("计数还没出现时活动块不铺底色", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: TOOL_CALL_ID, summary: SINGLE_ACTION_SUMMARY });
		// 满屏只有轮首一条横条：活动块里的行原样接上，不补宽也不铺底。
		harness.activityDetailLines.push(ACTIVITY_ROW);

		const rendered = linesOf(toolComponent()).map(stripAnsi);
		const tail = rendered[rendered.length - 1] ?? "";
		assert.equal(tail, ACTIVITY_ROW, `活动块应原样接在组尾：${rendered.join("\n")}`);
		assert.ok(
			visibleWidth(tail) < WIDTH,
			`活动块里的行不应被铺成整宽底色块：${JSON.stringify(tail)}`,
		);
	});
});

test("组内只有一条时，活动块不重复组头已经写出的动作名", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: TOOL_CALL_ID, summary: SINGLE_ACTION_SUMMARY });
		// 单条组的组头就是这条动作的摘要，活动块只留尾巴（思考行同理）。
		harness.activityLines.push(ACTIVITY_ROW, ACTIVITY_TAIL_ROW);
		harness.activityDetailLines.push(ACTIVITY_TAIL_ROW);

		const rendered = linesOf(toolComponent()).map(stripAnsi);
		const joined = rendered.join("\n");
		assert.ok(joined.includes(SINGLE_ACTION_SUMMARY), `组头应写出这条动作：${joined}`);
		assert.deepEqual(
			rendered.slice(-1),
			[ACTIVITY_TAIL_ROW],
			`活动块只应补上输出尾巴：${joined}`,
		);
		assert.ok(
			!joined.includes(ACTIVITY_ROW.trimStart()),
			`动作名不应再出现第二遍：${joined}`,
		);
	});
});

test("当前组展开时，活动块接在末位成员行下面", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: "call-1", summary: SINGLE_ACTION_SUMMARY });
		registerActionToolCall(harness.actionGroups, { toolCallId: "call-2", summary: SINGLE_ACTION_SUMMARY });
		toggleActionGroup(harness.actionGroups, harness.actionGroups.currentGroupId);
		harness.activityLines.push(ACTIVITY_ROW, ACTIVITY_TAIL_ROW);

		const headText = linesOf(toolComponent("call-1")).map(stripAnsi).join("\n");
		const lastLines = linesOf(toolComponent("call-2")).map(stripAnsi);

		assert.ok(!headText.includes(ACTIVITY_ROW), `组头行不该带活动块：${headText}`);
		assert.deepEqual(
			lastLines.slice(-2),
			[ACTIVITY_ROW, ACTIVITY_TAIL_ROW],
			`活动块应原样贴在末位成员下面：${lastLines.join("\n")}`,
		);
		assert.ok(
			visibleWidth(lastLines[lastLines.length - 2] ?? "") < WIDTH,
			"活动块不铺底色，不被补成整宽色块",
		);
	});
});

test("组收起时，成员行整行隐藏，活动块接在组头下面", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: "call-1", summary: SINGLE_ACTION_SUMMARY });
		registerActionToolCall(harness.actionGroups, { toolCallId: "call-2", summary: SINGLE_ACTION_SUMMARY });
		harness.activityLines.push(ACTIVITY_ROW, ACTIVITY_TAIL_ROW);

		const headLines = linesOf(toolComponent("call-1")).map(stripAnsi);
		assert.deepEqual(
			headLines.slice(-2),
			[ACTIVITY_ROW, ACTIVITY_TAIL_ROW],
			`组头是该组唯一可见的行，活动块接在它下面：${headLines.join("\n")}`,
		);
		assert.deepEqual(linesOf(toolComponent("call-2")), [], "收起组的成员行整行隐藏");
	});
});

test("历史组不显示活动块", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: "call-1", summary: SINGLE_ACTION_SUMMARY });
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: "call-2", summary: SINGLE_ACTION_SUMMARY });
		seedActivityBlock(harness, [ACTIVITY_ROW, ACTIVITY_TAIL_ROW]);

		assert.ok(
			!linesOf(toolComponent("call-1")).join("\n").includes(ACTIVITY_ROW),
			"历史组不应带活动块",
		);
		assert.ok(
			linesOf(toolComponent("call-2")).join("\n").includes(ACTIVITY_ROW),
			"当前组应带活动块",
		);
	});
});

test("轮首只画运行级时间，活动细节接在组尾", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: TOOL_CALL_ID, summary: SINGLE_ACTION_SUMMARY });
		seedActivityBlock(harness, [ACTIVITY_ROW, ACTIVITY_TAIL_ROW]);
		harness.runStatusLines.push(RUN_STATUS_ROW);

		const headLines = linesOf(new AssistantMessageComponent(workMessage())).map(stripAnsi);
		assert.equal(headLines[ACTIVITY_HEAD_ROW]?.trimEnd(), RUN_STATUS_ROW, "轮首应显示整轮时间");
		assert.ok(
			!headLines.join("\n").includes(ACTIVITY_ROW),
			`轮首不应出现活动细节：${headLines.join("\n")}`,
		);

		const tailLines = linesOf(toolComponent()).map(stripAnsi);
		assert.deepEqual(
			tailLines.slice(-2),
			[ACTIVITY_ROW, ACTIVITY_TAIL_ROW],
			`活动细节应接在组尾：${tailLines.join("\n")}`,
		);
	});
});

test("运行级收起时轮首只画运行级时间，活动块不出现", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		beginActionGroupStep(harness.actionGroups);
		registerActionToolCall(harness.actionGroups, { toolCallId: TOOL_CALL_ID, summary: SINGLE_ACTION_SUMMARY });
		harness.activityLines.push(ACTIVITY_ROW, ACTIVITY_TAIL_ROW);
		harness.runStatusLines.push(RUN_STATUS_ROW);

		const rendered = linesOf(new AssistantMessageComponent(workMessage())).map(stripAnsi);
		assert.equal(
			rendered[ACTIVITY_HEAD_ROW]?.trimEnd(),
			RUN_STATUS_ROW,
			"运行级收起时轮首只留运行级时间",
		);
		assert.ok(!rendered.join("\n").includes(ACTIVITY_ROW), "收起时活动块整块隐藏");
		assert.deepEqual(linesOf(toolComponent()), [], "运行级收起时工具行整行隐藏");
	});
});

test("历史轮次不重复显示轮首状态行", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		// 先让第一条消息认领当前轮，再渲染另一轮的消息。
		const current = new AssistantMessageComponent(workMessage());
		harness.runStatusLines.push(RUN_STATUS_ROW);

		const other = new AssistantMessageComponent(workMessage());
		assert.ok(
			linesOf(current).join("\n").includes(RUN_STATUS_ROW),
			"当前轮应显示运行级状态",
		);
		assert.ok(
			!linesOf(other).join("\n").includes(RUN_STATUS_ROW),
			"状态行只应出现在当前轮",
		);
	});
});

test("折叠时承载折叠头的工作过程消息只输出折叠头", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		const component = new AssistantMessageComponent(workMessage());
		const rendered = linesOf(component).join("\n");

		assert.ok(rendered.includes(HEADER_FRAGMENT), `折叠头应在整轮最前面：${rendered}`);
		assert.ok(!rendered.includes(WORK_TEXT), `工作过程正文应隐藏：${rendered}`);
	});
});

test("运行中收起后仍输出「处理中」状态横条，不出现整屏空白", () => {
	withPatches(
		COLLAPSED_STATE,
		{ ...DEFAULT_CLEAN_MODE_CONFIG },
		(harness) => {
			harness.runStatusLines.push(RUN_STATUS_ROW);
			const lines = linesOf(new AssistantMessageComponent(workMessage()));

			assert.deepEqual(
				lines.map((line) => line.trimEnd()),
				["", RUN_STATUS_ROW],
				"运行中耗时还没写入，槽位必须继续输出：否则整个屏幕上没有任何「还在跑」的信息",
			);
			assert.equal(
				visibleWidth(lines[ACTIVITY_HEAD_ROW] ?? ""),
				WIDTH,
				`状态横条应铺满整行：${JSON.stringify(lines[ACTIVITY_HEAD_ROW])}`,
			);
		},
		{ runHeaderHasDuration: false },
	);
});

test("折叠时非承载者的工作过程消息渲染为 0 行", () => {
	withPatches(COLLAPSED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		// 折叠头归属归本轮第一个实例；先把它占掉，再验证第二个实例什么都不输出。
		// 第一个实例：应成为本轮折叠头承载者。
		const owner = new AssistantMessageComponent(workMessage());
		assert.ok(
			linesOf(owner).join("\n").includes(HEADER_FRAGMENT),
			"前置条件：第一个实例应当成为折叠头承载者",
		);

		// 第二个实例：非承载者，应渲染 0 行。
		const nonOwner = new AssistantMessageComponent(workMessage());
		assert.deepEqual(linesOf(nonOwner), []);
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

test("展开时带 tool call 的消息照常渲染正文，折叠头仍在最前面", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		const component = new AssistantMessageComponent(workMessage());
		const rendered = linesOf(component).join("\n");

		assert.ok(rendered.includes(WORK_TEXT), `展开后解说丢失：${rendered}`);
		assert.ok(rendered.includes(HEADER_FRAGMENT), `折叠头应保持在整轮最前面：${rendered}`);
		assert.ok(
			rendered.indexOf(HEADER_FRAGMENT) < rendered.indexOf(WORK_TEXT),
			"折叠头必须排在正文之前，形成耗时 → 过程 → 答案的树形结构",
		);
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

test("开启 hideThinking 时 thinking 块整个消失，不留占位行", () => {
	const withThinking = renderAsRunHeader(thinkingMessage());
	const withoutThinking = renderAsRunHeader(plainMessage());

	assert.ok(!withThinking.join("\n").includes(THINKING_TEXT), "thinking 正文不应出现");
	assert.ok(withThinking.join("\n").includes(FINAL_TEXT), "最终答案仍应保留");
	assert.equal(
		withThinking.length,
		withoutThinking.length,
		"抽掉 thinking 后行数应与压根没有 thinking 的消息一致，不留占位行",
	);
});

test("关闭 hideThinking 时 thinking 原文照常渲染", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG, hideThinking: false }, () => {
		const component = new AssistantMessageComponent(thinkingMessage(), false, undefined, "Thinking...", 1, []);
		assert.ok(linesOf(component).join("\n").includes(THINKING_TEXT), "关掉开关应保留原文");
	});
});

/**
 * 在干净的补丁环境里把一条消息当作本轮的承载者渲染出来。
 *
 * 每次调用都新建一套补丁，这样拿到的两条消息都带折叠头，行数才可比。
 */
function renderAsRunHeader(message: Record<string, unknown>): string[] {
	return withPatches(
		EXPANDED_STATE,
		{ ...DEFAULT_CLEAN_MODE_CONFIG, hideThinking: true },
		() => linesOf(new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [])),
	);
}

/** 造一条只有正文、没有 thinking 的最终答案消息，用作行数基准。 */
function plainMessage(): Record<string, unknown> {
	return { role: "assistant", content: [{ type: "text", text: FINAL_TEXT }], stopReason: "stop" };
}

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
function seedActionGroup(
	actionGroups: ActionGroupState,
	count: number,
	summaries: Array<string | undefined> = [],
): string[] {
	beginActionGroupStep(actionGroups);
	const ids: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const id = `group-${actionGroups.currentGroupId}-${index}`;
		registerActionToolCall(actionGroups, { toolCallId: id, summary: summaries[index] });
		ids.push(id);
	}
	return ids;
}

test("组内只有一条时也收成一行，用动作摘要当组头", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const [onlyId] = seedActionGroup(harness.actionGroups, 1, [SINGLE_ACTION_SUMMARY]);
		const headLines = linesOf(toolComponent(onlyId));

		assert.equal(headLines.length, 2, "单条动作也是「空行 + 组头」两行");
		const rendered = headLines.join("\n");
		assert.ok(rendered.includes(SINGLE_ACTION_SUMMARY), `组头应带动作摘要：${rendered}`);
		assert.ok(!rendered.includes("a.ts"), `收起态不应露出原始工具输出：${rendered}`);
	});
});

test("组内只有一条时展开仍能看到原始工具行", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const [onlyId] = seedActionGroup(harness.actionGroups, 1, [SINGLE_ACTION_SUMMARY]);
		toggleActionGroup(harness.actionGroups, 1);
		const rendered = linesOf(toolComponent(onlyId)).join("\n");

		assert.ok(rendered.includes(SINGLE_ACTION_SUMMARY), `展开态应保留组头：${rendered}`);
		assert.ok(rendered.includes("a.ts"), `展开态应能看到原始工具行：${rendered}`);
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

test("组内有过半分类时组头用它命名", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		harness.groupActivityLabel = i18n.t("activityCommand");

		const rendered = linesOf(toolComponent(ids[0])).join("\n");
		assert.ok(
			rendered.includes(
				i18n.t("actionGroupSteps", { label: i18n.t("activityCommand"), count: "3" }),
			),
			`组头应带主导分类：${rendered}`,
		);
		assert.ok(
			!rendered.includes(GROUP_HEADER_FRAGMENT),
			`有主导分类时不应再写通用词：${rendered}`,
		);
	});
});

test("没有过半分类时组头退回通用词", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);

		const rendered = linesOf(toolComponent(ids[0])).join("\n");
		assert.ok(rendered.includes(GROUP_HEADER_FRAGMENT), `应退回「探索 · 3 步」：${rendered}`);
	});
});

test("两级折叠头的文案同列，箭头紧跟在文案右边", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		const groupHeader = linesOf(toolComponent(ids[0])).find((line) =>
			line.includes(GROUP_HEADER_FRAGMENT),
		);
		assert.ok(groupHeader, "前置条件：应渲染出组头行");

		const runHeader = linesOf(new AssistantMessageComponent(finalMessage())).find((line) =>
			line.includes(HEADER_FRAGMENT),
		);
		assert.ok(runHeader, "前置条件：应渲染出运行级折叠头");

		// 箭头挪到文案右边后，左侧只剩文案；两级文案必须同列，否则看着还是没对齐。
		assert.equal(
			columnOf(groupHeader, GROUP_HEADER_FRAGMENT),
			columnOf(runHeader, RUN_HEADER_LABEL),
			"两级折叠头的文案应同列",
		);
		assert.equal(
			columnOf(groupHeader, GROUP_HEADER_FRAGMENT),
			HEADER_INDENT_COLUMNS,
			"组头文案应顶在折叠头缩进列上",
		);

		// 箭头紧跟在文案右边（只隔一格），而且不再显示快捷键提示。
		assertChevronFollowsLabel(groupHeader, GROUP_HEADER_FRAGMENT, COLLAPSED_CHEVRON);
		assertChevronFollowsLabel(runHeader, RUN_HEADER_STEPS, EXPANDED_CHEVRON);
		assert.ok(!runHeader.includes(EXPAND_HINT), `折叠头不应再显示快捷键：${runHeader}`);
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

test("工具行的首行带上可点击箭头，点击该行切换 Pi 自己的展开", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, () => {
		const component = toolComponent("loose-1");
		const lines = linesOf(component);
		const arrowRow = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
		assert.ok(arrowRow >= 0, "前置条件：工具行应有可见内容");

		const firstLine = lines[arrowRow] ?? "";
		assert.ok(
			stripAnsi(firstLine).trimEnd().endsWith(COLLAPSED_CHEVRON),
			`工具行首行应以箭头收尾：${JSON.stringify(stripAnsi(firstLine))}`,
		);
		assert.equal(visibleWidth(firstLine), WIDTH, "加箭头不能改变行宽");

		// 点这一行应切到展开态，箭头方向跟着反过来。
		component.handleMouse(clickAt(arrowRow, lines.length));
		const expandedLines = linesOf(component);
		assert.ok(
			stripAnsi(expandedLines[arrowRow] ?? "").trimEnd().endsWith(EXPANDED_CHEVRON),
			`展开后箭头应变成实心下三角：${JSON.stringify(stripAnsi(expandedLines[arrowRow] ?? ""))}`,
		);
	});
});

test("展开的组里点成员箭头只切换这条工具行，不折叠整组", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		toggleActionGroup(harness.actionGroups, 1);

		const head = toolComponent(ids[0]);
		const lines = linesOf(head);
		// 组头行用的是展开态箭头 ▼，成员行自己的箭头才是 ▶，据此定位成员行。
		const arrowRow = lines.findIndex((line) => stripAnsi(line).trimEnd().endsWith(COLLAPSED_CHEVRON));
		assert.ok(arrowRow >= 0, `前置条件：展开的组里成员行应带箭头：${lines.join("\n")}`);

		head.handleMouse(clickAt(arrowRow, lines.length));
		assert.equal(harness.groupToggles(), 0, "点成员箭头不应折叠整组");

		const after = linesOf(head);
		assert.ok(
			stripAnsi(after[arrowRow] ?? "").trimEnd().endsWith(EXPANDED_CHEVRON),
			`点箭头后该工具行应变成展开态：${JSON.stringify(stripAnsi(after[arrowRow] ?? ""))}`,
		);
	});
});

test("展开的组里点组头可折叠整组，点成员正文不折叠整组", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		toggleActionGroup(harness.actionGroups, 1);

		const head = toolComponent(ids[0]);
		const lines = linesOf(head);

		head.handleMouse(clickAt(HEADER_BLANK_ROW, lines.length));
		assert.equal(harness.groupToggles(), 1, "组头上方的空行属于同一点击块，应能折叠整组");

		// 组头下面的行属于工具行自己，鼠标要透传给 Pi，不能当成组头。
		head.handleMouse(clickAt(lines.length - 1, lines.length));
		assert.equal(harness.groupToggles(), 1, "点成员正文不应折叠整组");
	});
});

test("组展开后点击组头仍能收起该组", () => {
	withPatches(EXPANDED_STATE, { ...DEFAULT_CLEAN_MODE_CONFIG }, (harness) => {
		const ids = seedActionGroup(harness.actionGroups, 3);
		toggleActionGroup(harness.actionGroups, 1);

		const head = toolComponent(ids[0]);
		linesOf(head);
		head.handleMouse(clickAt(HEADER_ROW, HEADER_ROW + 1));
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
