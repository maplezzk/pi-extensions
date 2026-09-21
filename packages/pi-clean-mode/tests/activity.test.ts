import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BRANCH_CONTINUATION_PADDING,
	TREE_INDENT,
	activityClassLabel,
	activityCountersNote,
	activityGlyph,
	appendActivityCountersNote,
	buildActivityLines,
	buildRunStatusLines,
	classifyToolActivity,
	clampActivityText,
	createActivitySnapshot,
	dominantActivityClass,
	extractOutputTail,
	extractThoughtHead,
	formatActivityCountersNote,
	renderActivityRows,
	toolActivityDetail,
	toolActivityLabel,
	withoutActionRows,
	type ActivityRenderInput,
	type ActivityRow,
} from "../src/activity.ts";
import { i18n } from "../src/i18n.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/** 透明的取色能力，便于断言明文。 */
const PLAIN_PAINTER = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/**
 * 续行的前缀：树形缩进 + 一个贯通占位（横向无后续子项时是空格）+ 与分支符同宽的占位。
 *
 * 从源码导出的常量算出来，缩进或分支符宽度变了断言会跟着走，不必手改字面量。
 */
const TAIL_PREFIX = `${TREE_INDENT} ${BRANCH_CONTINUATION_PADDING}`;

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

/** 只取活动块里的行：结构化行按最终留下的行拼上竖折前缀。 */
function blockLines(overrides: Partial<ActivityRenderInput> = {}): string[] {
	return renderActivityRows(buildActivityLines(renderInput(overrides)).rows, PLAIN_PAINTER);
}

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

test("分类桶映射到动作标签", () => {
	assert.equal(activityClassLabel("read"), i18n.t("activityRead"));
	assert.equal(activityClassLabel("search"), i18n.t("activitySearch"));
	assert.equal(activityClassLabel("command"), i18n.t("activityCommand"));
	assert.equal(activityClassLabel("other"), i18n.t("activityTool"));
});

test("主导分类要严格过半，最多但不够半数就不给主词", () => {
	assert.equal(dominantActivityClass({ command: 9, read: 3 }), "command", "9/12 严格过半");
	assert.equal(dominantActivityClass({ read: 7, search: 1 }), "read", "7/8 严格过半");
	assert.equal(
		dominantActivityClass({ read: 3, command: 2, search: 1 }),
		undefined,
		"3/6 正好一半，「最多的一类」不算主导",
	);
	assert.equal(
		dominantActivityClass({ read: 3, other: 4 }),
		undefined,
		"「调用工具」不当主词，但它算在分母里",
	);
	assert.equal(dominantActivityClass({ command: 4, other: 1 }), "command", "只有过半才忽略 other");
	assert.equal(dominantActivityClass({}), undefined, "空计数没有主导");
	assert.equal(dominantActivityClass(undefined), undefined, "未知组没有主导");
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
	assert.deepEqual(blockLines({ snapshot }), []);
});

test("活动块末尾带本轮分类计数尾注，不重复顶部文案与耗时", () => {
	const snapshot = runningSnapshot();
	snapshot.running[0].outputTail = "12 passing";
	const rows = buildActivityLines(renderInput({ snapshot })).rows;
	const joined = appendActivityCountersNote(
		rows,
		renderActivityRows(rows, PLAIN_PAINTER),
		activityCountersNote(snapshot.counters),
	).join("\n");

	assert.ok(joined.includes("npm test"), `应显示正在跑的工具：${joined}`);
	assert.ok(
		joined.includes(i18n.t("activityCounterRead", { count: "4" })),
		`分类计数应作为尾注出现在活动块里：${joined}`,
	);
	assert.ok(
		!joined.includes(i18n.t("activityWorking")),
		`「处理中」只在轮首，活动块不应重复：${joined}`,
	);
	assert.ok(!joined.includes("42s"), `耗时只在轮首，活动块不应重复：${joined}`);
});

test("尾注接在最后一个子项行上：不接输出尾巴，不另占一行，也不挂到补位空行后面", () => {
	const note = activityCountersNote(runningSnapshot().counters);
	const rows: ActivityRow[] = [
		{ kind: "item", text: "思考 权衡方案" },
		{ kind: "item", text: "运行命令 npm test" },
		{ kind: "tail", text: "↳ 12 passing" },
		{ kind: "blank", text: "" },
	];
	const lines = renderActivityRows(rows, PLAIN_PAINTER);
	const appended = appendActivityCountersNote(rows, lines, note);

	assert.equal(appended.length, lines.length, "尾注不该改变行数");
	assert.ok(appended[1]?.endsWith(note), `尾注应接在最后一个子项行尾：${appended[1]}`);
	assert.equal(
		appended[2],
		lines[2],
		`输出尾巴是命令自己打出来的那行，不能挂本轮计数：${appended[2]}`,
	);
	assert.equal(appended[3], "", "补位空行保持空行，不挂尾注");
});

test("块里只剩续行时尾注退回最后一条非空行", () => {
	const note = activityCountersNote(runningSnapshot().counters);
	const rows: ActivityRow[] = [
		{ kind: "tail", text: "↳ 12 passing" },
		{ kind: "blank", text: "" },
	];
	const lines = renderActivityRows(rows, PLAIN_PAINTER);
	const appended = appendActivityCountersNote(rows, lines, note);

	assert.ok(appended[0]?.endsWith(note), `没有子项行时退回最后一条非空行：${appended[0]}`);
	assert.equal(appended[1], "", "补位空行仍然不挂尾注");
});

test("只有一次动作时不出尾注：组头已经写了动作名", () => {
	assert.equal(
		activityCountersNote({ read: 0, search: 0, command: 1, other: 0 }),
		"",
		"一次动作时尾注应为空串",
	);
	const rows: ActivityRow[] = [{ kind: "item", text: "运行命令 npm test" }];
	const lines = renderActivityRows(rows, PLAIN_PAINTER);
	assert.deepEqual(
		appendActivityCountersNote(rows, lines, ""),
		lines,
		"没有尾注时行原样返回",
	);
});

test("轮首状态行不随动画帧变化，也不带转动图标", () => {
	const first = buildRunStatusLines(renderInput({ frame: 0, animated: true }))[0] ?? "";
	const second = buildRunStatusLines(renderInput({ frame: 3, animated: true }))[0] ?? "";

	assert.ok(first.length > 0, "前置条件：运行中应输出状态行");
	assert.equal(first, second, `状态行不该逐帧变，否则顶部一直在跳：${first} / ${second}`);
	for (const glyph of ["⠋", "⠙", "⠹", "›"]) {
		assert.ok(
			!first.includes(glyph),
			`状态行不带转动图标「${glyph}」：耗时本身就每秒在变：${first}`,
		);
	}
});

test("分类计数拼成一行尾注，0 的桶按需省略", () => {
	const counted = formatActivityCountersNote({ read: 4, search: 3, command: 1, other: 9 });
	assert.equal(
		counted,
		`${i18n.t("activityCounterRead", { count: "4" })} · ${i18n.t("activityCounterSearch", { count: "3" })} · ${i18n.t("activityCounterCommand", { count: "1" })}`,
		`顺序是读取 → 搜索 → 命令，且不带前导分隔符：${counted}`,
	);
	assert.equal(
		formatActivityCountersNote({ read: 0, search: 0, command: 0, other: 5 }),
		"",
		"只有 other 时没有可报的分类，应返回空串",
	);
	assert.equal(
		formatActivityCountersNote({ read: 0, search: 2, command: 0, other: 0 }),
		i18n.t("activityCounterSearch", { count: "2" }),
		"只有一个桶时只留那一个桶",
	);
});

test("轮首状态行只报运行级时间：状态与耗时，不带计数与细节", () => {
	const snapshot = { ...runningSnapshot(), thought: "正在追踪 token 失效路径" };
	const lines = buildRunStatusLines(renderInput({ snapshot }));

	assert.equal(lines.length, 1, `轮首只应有一行：${lines.join("\n")}`);
	const line = lines[0] ?? "";
	assert.ok(!line.includes("[clean]"), `轮首不应带来源前缀：${line}`);
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
	const lines = blockLines({ snapshot, animated: true, frame: 2 });
	const thoughtLine = lines.find((line) => line.includes(i18n.t("activityThinking")));

	assert.ok(thoughtLine, `应当输出思考行：${lines.join("\n")}`);
	assert.ok(
		thoughtLine.includes(activityGlyph("thinking", 2, true)),
		`思考行应带当前动画帧：${thoughtLine}`,
	);
	assert.ok(!/[◌◔◕●]/.test(thoughtLine), `思考行不应出现填充比例图形：${thoughtLine}`);
});

test("当前动作与其输出尾巴各占一行，用竖折挂在组头下面", () => {
	const snapshot = runningSnapshot();
	snapshot.running[0].outputTail = "12 passing";
	const lines = blockLines({ snapshot });
	const joined = lines.join("\n");

	assert.ok(joined.includes("npm test"), `应显示当前动作与参数：${joined}`);
	assert.ok(joined.includes("12 passing"), `应显示最新输出：${joined}`);
	// 只有这一条动作，它就是活动块里最后一个子项，分支符用 └─ 收口。
	assert.ok(lines[0]?.startsWith(`${TREE_INDENT}└─ `), `动作行应带收口分支符：${JSON.stringify(lines[0])}`);
	// 尾巴与分支符后的正文同列，不再深一级缩进。
	assert.ok(
		lines[1]?.startsWith(`${TAIL_PREFIX}↳ `),
		`输出尾巴应与动作正文同列：${JSON.stringify(lines[1])}`,
	);
});

test("行数预算收紧时从尾部截断，先保住第一行", () => {
	const snapshot = runningSnapshot();
	snapshot.thought = "想一下";
	const lines = blockLines({ snapshot, maxRows: 1 });

	assert.equal(lines.length, 1);
	assert.ok(lines[0]?.includes("想一下"), `第一行应是思考行：${lines[0]}`);
});

test("并行执行时轮首换成并行文案，活动块里不重复", () => {
	const snapshot = runningSnapshot();
	snapshot.running.push({ toolCallId: "c2", label: i18n.t("activityRead"), detail: "b.ts" });
	const lines = blockLines({ snapshot });
	const joined = lines.join("\n");

	assert.ok(
		!joined.includes(i18n.t("activityParallel")),
		`并行文案只在轮首，活动块里不应重复：${joined}`,
	);
	assert.ok(
		buildRunStatusLines(renderInput({ snapshot }))[0]?.includes(i18n.t("activityParallel")),
		"轮首应换成并行文案",
	);
	assert.ok(joined.includes("npm test"), `应列出第一个动作：${joined}`);
	assert.ok(joined.includes("b.ts"), `应列出第二个动作：${joined}`);
});

test("块里哪几行是动作名：并行列出行号，截断时丢掉越界的", () => {
	const snapshot = runningSnapshot();
	snapshot.running[0].outputTail = "12 passing";
	snapshot.running.push({ toolCallId: "c2", label: i18n.t("activityRead"), detail: "b.ts" });
	snapshot.thought = "权衡方案";

	const block = buildActivityLines(renderInput({ snapshot }));
	assert.deepEqual(
		block.actionRows,
		[1, 3],
		`思考占一行，第一条动作带输出尾巴，第二条动作落在第 3 行：${renderActivityRows(block.rows, PLAIN_PAINTER).join("\n")}`,
	);

	const truncated = buildActivityLines(renderInput({ snapshot, maxRows: 2 }));
	assert.deepEqual(
		truncated.actionRows,
		[1],
		`被截掉的动作行不应再算动作名：${renderActivityRows(truncated.rows, PLAIN_PAINTER).join("\n")}`,
	);
});

test("多行时分支符按「后面还有没有子项」收口，尾巴用竖线与后续子项贯通", () => {
	const snapshot = runningSnapshot();
	snapshot.thought = "权衡方案";
	snapshot.running[0].outputTail = "12 passing";
	snapshot.running.push({ toolCallId: "c2", label: i18n.t("activityRead"), detail: "b.ts" });

	const lines = blockLines({ snapshot });

	assert.equal(lines.length, 4, `应是思考 + 动作 + 尾巴 + 动作四行：${lines.join("\n")}`);
	assert.ok(lines[0]?.startsWith(`${TREE_INDENT}├─ `), `后面还有子项时用 ├─：${JSON.stringify(lines[0])}`);
	assert.ok(lines[1]?.startsWith(`${TREE_INDENT}├─ `), `第一条动作后面还有子项：${JSON.stringify(lines[1])}`);
	assert.ok(
		lines[2]?.startsWith(`${TREE_INDENT}│${BRANCH_CONTINUATION_PADDING}↳ `),
		`续行的竖线要与分支符同列贯通：${JSON.stringify(lines[2])}`,
	);
	assert.ok(lines[3]?.startsWith(`${TREE_INDENT}└─ `), `最后一个子项收口成 └─：${JSON.stringify(lines[3])}`);
});

test("去掉动作名后只剩思考与输出尾巴", () => {
	const snapshot = runningSnapshot();
	snapshot.running[0].outputTail = "12 passing";
	snapshot.thought = "权衡方案";

	const block = buildActivityLines(renderInput({ snapshot }));
	const detail = renderActivityRows(withoutActionRows(block), PLAIN_PAINTER);

	assert.deepEqual(
		detail,
		[
			`${TREE_INDENT}└─ ${activityGlyph("thinking", 0, false)} ${i18n.t("activityThinking")}  权衡方案`,
			`${TAIL_PREFIX}↳ 12 passing`,
		],
		`动作名去掉后只留思考与尾巴，思考收口成 └─：${detail.join("\n")}`,
	);
	assert.ok(
		!detail.join("\n").includes("npm test"),
		`动作名不应再出现：${detail.join("\n")}`,
	);
});

test("没有正在执行的工具但有思考时，只输出思考行", () => {
	const snapshot = { ...runningSnapshot(), running: [], thought: "权衡方案" };
	const lines = blockLines({ snapshot });

	assert.equal(lines.length, 1, `没有动作时只应有思考行：${lines.join("\n")}`);
	assert.ok(lines[0]?.includes("权衡方案"), `应输出思考：${lines[0]}`);
});
