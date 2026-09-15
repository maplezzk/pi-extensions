import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activityGlyph,
	buildActivityLines,
	classifyToolActivity,
	clampActivityText,
	createActivitySnapshot,
	extractOutputTail,
	extractThoughtHead,
	toolActivityDetail,
	toolActivityLabel,
	type ActivityRenderInput,
} from "../src/activity.ts";
import { i18n } from "../src/i18n.ts";

/** 透明的取色能力，便于断言明文。 */
const PLAIN_PAINTER = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** 造一个进行中、带一条正在执行命令的快照。 */
function runningSnapshot(): ReturnType<typeof createActivitySnapshot> {
	return {
		active: true,
		startedAtMs: 1_000_000,
		running: [{ toolCallId: "c1", label: i18n.t("activityCommand"), detail: "npm test" }],
		counters: { read: 4, search: 3, command: 1, other: 0 },
	};
}

/** 组装渲染输入，默认取运行中快照与 4 行预算。 */
function renderInput(overrides: Partial<ActivityRenderInput> = {}): ActivityRenderInput {
	return {
		snapshot: runningSnapshot(),
		nowMs: 1_042_000,
		frame: 0,
		animated: false,
		maxRows: 4,
		paint: PLAIN_PAINTER,
		...overrides,
	};
}

test("静止模式下 thinking 与 working 使用不同标记", () => {
	assert.equal(activityGlyph("thinking", 0, false), "◌");
	assert.equal(activityGlyph("working", 0, false), "›");
});

test("动画模式下 working 每帧前进，thinking 半速前进", () => {
	assert.notEqual(activityGlyph("working", 0, true), activityGlyph("working", 1, true));
	assert.equal(
		activityGlyph("thinking", 0, true),
		activityGlyph("thinking", 1, true),
		"thinking 应当比 working 慢，相邻两帧保持同一标记",
	);
	assert.notEqual(activityGlyph("thinking", 0, true), activityGlyph("thinking", 2, true));
});

test("帧号异常时回落到静止标记", () => {
	assert.equal(activityGlyph("working", -5, true), activityGlyph("working", 0, true));
});

test("长文本按宽度截断并加省略号", () => {
	assert.equal(clampActivityText("short", 10), "short");
	assert.equal(clampActivityText("abcdefghijk", 5), "abcd…");
	assert.equal(clampActivityText("a\n  b"), "a b", "换行会折成空格");
});

test("工具名映射到语义标签", () => {
	assert.equal(toolActivityLabel("read"), i18n.t("activityRead"));
	assert.equal(toolActivityLabel("grep"), i18n.t("activitySearch"));
	assert.equal(toolActivityLabel("bash"), i18n.t("activityCommand"));
	assert.equal(toolActivityLabel("mcp__x/edit"), i18n.t("activityEdit"));
	assert.equal(toolActivityLabel("weird_tool"), i18n.t("activityTool"));
});

test("工具分类决定计数桶", () => {
	assert.equal(classifyToolActivity("read"), "read");
	assert.equal(classifyToolActivity("find"), "search");
	assert.equal(classifyToolActivity("bash"), "command");
	assert.equal(classifyToolActivity("weird_tool"), "other");
});

test("参数摘要优先取命令原文，缺失时退回工具名", () => {
	assert.equal(toolActivityDetail("bash", { command: "npm test" }), "npm test");
	assert.equal(toolActivityDetail("read", { file_path: "a/b.ts" }), "a/b.ts");
	assert.equal(toolActivityDetail("weird_tool", { unknown: 1 }), "weird_tool");
	assert.equal(toolActivityDetail("bash", null), undefined);
});

test("输出尾巴取最后一个非空文本块的最后一行", () => {
	const result = { content: [{ type: "text", text: "line one\nline two" }] };
	assert.equal(extractOutputTail(result), "line two");
	assert.equal(extractOutputTail({ content: [] }), undefined);
	assert.equal(extractOutputTail(undefined), undefined);
});

test("思考头部取第一条 thinking 的首个非空行", () => {
	const message = { content: [{ type: "thinking", thinking: "\n  正在追踪 token 失效路径…\n第二行" }] };
	assert.equal(extractThoughtHead(message), "正在追踪 token 失效路径…");
	assert.equal(extractThoughtHead({ content: [{ type: "text", text: "x" }] }), undefined);
});

test("未运行时活动区不输出任何行", () => {
	const snapshot = { ...createActivitySnapshot(), active: false };
	assert.deepEqual(buildActivityLines(renderInput({ snapshot })), []);
});

test("运行中至少输出当前动作行，并带上最新输出与计数", () => {
	const snapshot = runningSnapshot();
	snapshot.running[0].outputTail = "12 passing";
	const lines = buildActivityLines(renderInput({ snapshot }));
	const joined = lines.join("\n");

	assert.ok(joined.includes("npm test"), `应显示当前动作与参数：${joined}`);
	assert.ok(joined.includes("12 passing"), `应显示最新输出：${joined}`);
	assert.ok(joined.includes("42s"), `应显示耗时：${joined}`);
	assert.ok(joined.includes("读取 4"), `应显示计数：${joined}`);
});

test("行数预算收紧时优先保留当前动作", () => {
	const snapshot = runningSnapshot();
	snapshot.thought = "想一下";
	const lines = buildActivityLines(renderInput({ snapshot, maxRows: 1 }));
	assert.equal(lines.length, 1);
	assert.ok(lines[0]?.includes("npm test"), `第一行应是当前动作：${lines[0]}`);
});

test("并行执行时用一行汇总而不是逐条堆叠", () => {
	const snapshot = runningSnapshot();
	snapshot.running.push({ toolCallId: "c2", label: i18n.t("activityRead"), detail: "b.ts" });
	const lines = buildActivityLines(renderInput({ snapshot }));
	assert.ok(lines.length > 0, "并行时至少应输出一行");
	assert.ok(lines[0]?.includes(i18n.t("activityParallel")), `首行应是并行汇总：${lines[0]}`);
	assert.ok(lines[0]?.includes("2 ·"), `首行应带上并行条数：${lines[0]}`);
});

test("没有正在执行的工具但有思考时只显示思考与计数", () => {
	const snapshot = { ...runningSnapshot(), running: [], thought: "权衡方案" };
	const lines = buildActivityLines(renderInput({ snapshot }));
	assert.ok(lines.join("\n").includes("权衡方案"));
});
