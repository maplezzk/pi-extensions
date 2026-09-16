import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activityGlyph,
	buildActivityLines,
	buildRunStatusLines,
	classifyToolActivity,
	clampActivityText,
	createActivitySnapshot,
	extractOutputTail,
	extractThoughtHead,
	isActivityHeadLine,
	toolActivityDetail,
	toolActivityLabel,
	type ActivityRenderInput,
} from "../src/activity.ts";
import { i18n } from "../src/i18n.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

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

/** 思考动画一圈的帧数：半填充圆的四个朝向。 */
const THINKING_FRAME_COUNT = 4;

test("静止模式下 thinking 与 working 使用不同标记", () => {
	assert.equal(activityGlyph("thinking", 0, false), "·");
	assert.equal(activityGlyph("working", 0, false), "›");
});

test("动画模式下 thinking 与 working 每帧都前进", () => {
	assert.notEqual(activityGlyph("working", 0, true), activityGlyph("working", 1, true));
	assert.notEqual(activityGlyph("thinking", 0, true), activityGlyph("thinking", 1, true));
});

test("思考动画每帧都是不同朝向、单格宽，且走满一圈回到起始帧", () => {
	const frames = new Set<string>();
	for (let frame = 0; frame < THINKING_FRAME_COUNT; frame += 1) {
		const glyph = activityGlyph("thinking", frame, true);
		assert.equal(visibleWidth(glyph), 1, `${glyph} 应当只占一格，否则行宽会抖`);
		frames.add(glyph);
	}
	assert.equal(frames.size, THINKING_FRAME_COUNT, "每帧应当是不同朝向");
	assert.equal(
		activityGlyph("thinking", THINKING_FRAME_COUNT, true),
		activityGlyph("thinking", 0, true),
		"走满一圈后回到起始帧",
	);
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

test("思考头部的 markdown 强调符会被剥掉", () => {
	const message = { content: [{ type: "thinking", thinking: "**先看 token 路径** 再看 `session.ts`" }] };
	assert.equal(extractThoughtHead(message), "先看 token 路径 再看 session.ts");
	assert.equal(
		extractThoughtHead({ content: [{ type: "thinking", thinking: "snake_case 与 a*b 保持原样" }] }),
		"snake_case 与 a*b 保持原样",
		"散落的单个 * 与下划线不是成对标记，不应被删",
	);
	assert.equal(
		extractThoughtHead({ content: [{ type: "thinking", thinking: "**  **" }] }),
		undefined,
		"只剩空白的标记剥完不应输出一行空思考",
	);
	assert.equal(
		extractThoughtHead({ content: [{ type: "thinking", thinking: "**" }] }),
		"**",
		"落单的 ** 不是成对标记，原样保留",
	);
});

test("未运行时活动区不输出任何行", () => {
	const snapshot = { ...createActivitySnapshot(), active: false };
	assert.deepEqual(buildActivityLines(renderInput({ snapshot })), []);
});

test("活动块首行只报计数：不重复顶部的「处理中」与耗时", () => {
	const snapshot = runningSnapshot();
	snapshot.running[0].outputTail = "12 passing";
	snapshot.counters = { read: 4, search: 0, command: 0, other: 0 };
	const head = buildActivityLines(renderInput({ snapshot }))[0] ?? "";

	assert.ok(head.includes(i18n.t("activityCounterRead", { count: "4" })), `首行应带读取计数：${head}`);
	assert.ok(
		!head.includes(i18n.t("activityWorking")),
		`「处理中」只在轮首，块首行不应重复：${head}`,
	);
	assert.ok(!head.includes("42s"), `耗时只在轮首，块首行不应重复：${head}`);
	assert.ok(!head.includes(i18n.t("activityCounterSearch", { count: "0" })), `0 的桶不应占位：${head}`);
	assert.ok(!head.includes(i18n.t("activityCounterCommand", { count: "0" })), `0 的桶不应占位：${head}`);
});

test("计数全为 0 时不画块首行，块直接从动作行开始", () => {
	const snapshot = runningSnapshot();
	snapshot.counters = { read: 0, search: 0, command: 0, other: 0 };
	const lines = buildActivityLines(renderInput({ snapshot }));

	assert.equal(lines.length, 1, `没有计数时只应有动作行：${lines.join("\n")}`);
	assert.ok(lines[0]?.includes("npm test"), `动作行应保留：${lines[0]}`);
	assert.equal(
		isActivityHeadLine(lines[0] ?? ""),
		false,
		`计数为 0 时首行是细节行，不应铺底色：${lines[0]}`,
	);
});

test("块首行与细节行靠缩进区分", () => {
	const snapshot = runningSnapshot();
	const lines = buildActivityLines(renderInput({ snapshot }));

	assert.equal(isActivityHeadLine(lines[0] ?? ""), true, `计数横条是块首行：${lines[0]}`);
	assert.equal(isActivityHeadLine(lines[1] ?? ""), false, `动作行不是块首行：${lines[1]}`);
	assert.equal(isActivityHeadLine(""), false, "补位空行不是块首行");
});

test("轮首状态行只报运行级时间：状态与耗时，不带计数与细节", () => {
	const snapshot = { ...runningSnapshot(), thought: "正在追踪 token 失效路径" };
	const lines = buildRunStatusLines(renderInput({ snapshot }));

	assert.equal(lines.length, 1, `轮首只应有一行：${lines.join("\n")}`);
	const line = lines[0] ?? "";
	assert.ok(line.includes(i18n.t("activityWorking")), `应说明正在处理：${line}`);
	assert.ok(line.includes("42s"), `应带耗时：${line}`);
	assert.ok(
		!line.includes(i18n.t("activityCounterRead", { count: "4" })),
		`轮首不应带分类计数：${line}`,
	);
	assert.ok(!line.includes(i18n.t("activityThinking")), `轮首不应带思考细节：${line}`);
	assert.ok(!line.includes("npm test"), `轮首不应带正在跑的工具：${line}`);
});

test("轮首状态行在未运行或行数预算为零时为空", () => {
	const inactive = { ...createActivitySnapshot(), active: false };
	assert.deepEqual(buildRunStatusLines(renderInput({ snapshot: inactive })), []);
	assert.deepEqual(buildRunStatusLines(renderInput({ maxRows: 0 })), []);
});

test("思考行用当前动画帧，不出现改变填充比例的图形", () => {
	const snapshot = { ...runningSnapshot(), thought: "正在追踪 token 失效路径" };
	const lines = buildActivityLines(renderInput({ snapshot, animated: true, frame: 2 }));
	const thoughtLine = lines.find((line) => line.includes(i18n.t("activityThinking")));

	assert.ok(thoughtLine, `应当输出思考行：${lines.join("\n")}`);
	assert.ok(
		thoughtLine.includes(activityGlyph("thinking", 2, true)),
		`思考行应带当前动画帧：${thoughtLine}`,
	);
	assert.ok(!/[◌◔◕●]/.test(thoughtLine), `思考行不应出现填充比例图形：${thoughtLine}`);
});

test("当前动作与其输出尾巴各占一行，且都缩进在横条之下", () => {
	const snapshot = runningSnapshot();
	snapshot.running[0].outputTail = "12 passing";
	const lines = buildActivityLines(renderInput({ snapshot }));
	const joined = lines.join("\n");

	assert.ok(joined.includes("npm test"), `应显示当前动作与参数：${joined}`);
	assert.ok(joined.includes("12 passing"), `应显示最新输出：${joined}`);
	assert.ok(lines[1]?.startsWith("    "), `动作行应缩进一级：${JSON.stringify(lines[1])}`);
	assert.ok(lines[2]?.startsWith("      "), `输出尾巴应缩进两级：${JSON.stringify(lines[2])}`);
});

test("行数预算收紧时优先保留块首行", () => {
	const snapshot = runningSnapshot();
	snapshot.thought = "想一下";
	const lines = buildActivityLines(renderInput({ snapshot, maxRows: 1 }));
	assert.equal(lines.length, 1);
	assert.ok(
		lines[0]?.includes(i18n.t("activityCounterRead", { count: "4" })),
		`第一行应是计数横条：${lines[0]}`,
	);
});

test("并行执行时轮首换成并行文案，块首行仍只报计数", () => {
	const snapshot = runningSnapshot();
	snapshot.running.push({ toolCallId: "c2", label: i18n.t("activityRead"), detail: "b.ts" });
	const lines = buildActivityLines(renderInput({ snapshot }));
	const joined = lines.join("\n");

	assert.ok(
		!joined.includes(i18n.t("activityParallel")),
		`并行文案只在轮首，块里不应重复：${joined}`,
	);
	assert.ok(
		buildRunStatusLines(renderInput({ snapshot }))[0]?.includes(i18n.t("activityParallel")),
		"轮首应换成并行文案",
	);
	assert.ok(joined.includes("npm test"), `应列出第一个动作：${joined}`);
	assert.ok(joined.includes("b.ts"), `应列出第二个动作：${joined}`);
});

test("没有正在执行的工具但有思考时，思考接在计数横条下面", () => {
	const snapshot = { ...runningSnapshot(), running: [], thought: "权衡方案" };
	const lines = buildActivityLines(renderInput({ snapshot }));

	assert.equal(lines.length, 2, `应只有计数行与思考行：${lines.join("\n")}`);
	assert.ok(
		lines[0]?.includes(i18n.t("activityCounterRead", { count: "4" })),
		`首行应是计数横条：${lines[0]}`,
	);
	assert.ok(lines[1]?.includes("权衡方案"), `第二行应是思考：${lines[1]}`);
});
