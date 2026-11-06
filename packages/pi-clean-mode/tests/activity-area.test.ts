import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clearActivityArea,
	createActivityAreaRuntime,
	refreshActivityArea,
	startActivityTimer,
	stopActivityTimer,
	type ActivityAreaDeps,
	type ActivityUiHost,
} from "../src/activity-area.ts";
import {
	BRANCH_CONTINUATION_PADDING,
	TREE_INDENT,
	activityCountersNote,
	createActivitySnapshot,
	renderActivityRows,
	type ActivityRow,
	type ActivitySnapshot,
} from "../src/activity.ts";
import { ACTIVITY_ROWS_DEFAULT } from "../src/types.ts";

/** 树形行前缀（`├─ ` / `└─ `）与续行前缀；从源码常量算，缩进变了断言跟着走。 */
const BRANCH = `${TREE_INDENT}`;
const TAIL = `${TREE_INDENT} ${BRANCH_CONTINUATION_PADDING}`;

/** 活动区默认行数，测试里同样用它避免魔法值。 */
const MAX_ROWS = ACTIVITY_ROWS_DEFAULT;
/** 透明着色：活动块的前缀与正文都按原样比对。 */
const PLAIN_PAINTER = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
/** 默认的结构化活动行。 */
const DEFAULT_ROWS: ActivityRow[] = [{ kind: "item", text: "⠹ 运行命令" }];
/** 默认活动行渲染后的文本；竖折前缀由 renderActivityRows 拼。 */
const DEFAULT_LINES = renderActivityRows(DEFAULT_ROWS, PLAIN_PAINTER);
/** 轮首状态行的默认内容；与活动块不同，轮首只有这一行。 */
const DEFAULT_RUN_STATUS_LINES = ["│ ⠋ 在处理 · 1s"];
/** 内容变化对比用的第一组行。 */
const NPM_TEST_ROWS: ActivityRow[] = [{ kind: "item", text: "⠹ 运行命令 npm test" }];
/** 内容变化对比用的第二组行。 */
const NPM_BUILD_ROWS: ActivityRow[] = [{ kind: "item", text: "⠸ 运行命令 npm run build" }];

/**
 * 测试用的假 UI 宿主。
 *
 * 活动行由轮首的活动区子组件从 runtime.lines 读取，所以宿主侧要观察的是
 * 「请求了几次重绘」和「Pi 内置 Working 的显隐」，而不是过去那种挂 widget。
 */
interface FakeHost {
	host: ActivityUiHost;
	/** 显示层调用计数。 */
	calls: { renders: number };
	/** Pi 内置 Working 提示的显隐变化。 */
	workingVisible: boolean[];
}

/** 造一个记录调用的假 UI 宿主；不需要伪造整个 ExtensionContext。 */
function createFakeHost(): FakeHost {
	const calls = { renders: 0 };
	const workingVisible: boolean[] = [];

	const host: ActivityUiHost = {
		ui: {
			/** 透明主题：测试只关心明文内容。 */
			theme: {
				// 不改变文本，便于直接断言。
				fg: (_color: string, text: string) => text,
				// 不改变文本，便于直接断言。
				bold: (text: string) => text,
			},
			/** 记录 Pi 内置 Working 提示的显隐变化。 */
			setWorkingVisible: (visible: boolean) => {
				workingVisible.push(visible);
			},
		},
		/** 活动行从 runtime.lines 渲染，刷新只体现为一次重绘请求。 */
		requestRender: () => {
			calls.renders += 1;
		},
	};

	return { host, calls, workingVisible };
}

/** 造一个返回固定结构化行的渲染依赖。 */
function createDeps(snapshot: ActivitySnapshot, rows: ActivityRow[] = DEFAULT_ROWS): ActivityAreaDeps {
	return {
		getSnapshot: () => snapshot,
		// 本组用例只关心去重与生命周期，动画固定为开。
		isAnimated: () => true,
		getMaxRows: () => MAX_ROWS,
		// 默认没有动作名行；需要验证动作行号的用例自行覆盖。
		renderLines: () => ({ rows, actionRows: [] }),
		// 轮首状态行与本组用例无关，固定返回一行可辨识的内容。
		renderRunStatusLines: () => DEFAULT_RUN_STATUS_LINES,
		// 默认假定本轮已有承载折叠头的组件；需要验证「承载者未就绪」的用例自行覆盖它。
		hasRunHeaderHost: () => true,
		// 默认假定轮首那条「处理中 · Ns」会画出来；要验证「轮首不画」的用例自行覆盖它。
		isRunHeaderShown: () => true,
	};
}

/** 造一个运行中的快照。 */
function activeSnapshot(): ActivitySnapshot {
	return { ...createActivitySnapshot(), active: true };
}

test("内容不变时跳过重绘", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	const rendersAfterFirst = fake.calls.renders;

	refreshActivityArea(runtime, fake.host, deps);
	assert.equal(fake.calls.renders, rendersAfterFirst, "签名相同就不应再请求重绘");
});

test("运行中内容无变化时刷新去重，不重复重绘", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, DEFAULT_LINES, "内容无变化时行保持原样");
	assert.equal(fake.calls.renders, 1, "内容无变化就不应该重复重绘");
});

test("内容变化时更新行并请求重绘", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	let rows = NPM_TEST_ROWS;
	const deps: ActivityAreaDeps = {
		getSnapshot: () => activeSnapshot(),
		// 本用例只关心内容变化触发重绘。
		isAnimated: () => true,
		getMaxRows: () => MAX_ROWS,
		renderLines: () => ({ rows, actionRows: [] }),
		renderRunStatusLines: () => DEFAULT_RUN_STATUS_LINES,
		// 本用例与本轮承载者无关，固定为已就绪。
		hasRunHeaderHost: () => true,
	};

	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, renderActivityRows(NPM_TEST_ROWS, PLAIN_PAINTER), "runtime 应持有当前渲染行");
	const rendersAfterFirst = fake.calls.renders;

	rows = NPM_BUILD_ROWS;
	refreshActivityArea(runtime, fake.host, deps);
	assert.equal(fake.calls.renders, rendersAfterFirst + 1, "内容变化应请求重绘");
	assert.deepEqual(
		runtime.lines,
		renderActivityRows(NPM_BUILD_ROWS, PLAIN_PAINTER),
		"runtime 的行应跟着更新",
	);
});

test("没有内容时清空行并请求重绘", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(createActivitySnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, [], "未运行时不应留下任何活动行");
	assert.equal(fake.calls.renders, 1, "清空行也要重绘一次");
});

test("活动区有内容时隐藏 Pi 内置 Working，清理时恢复", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(fake.workingVisible, [false], "有内容时应隐藏内置 Working");

	clearActivityArea(runtime, fake.host);
	assert.equal(fake.workingVisible[fake.workingVisible.length - 1], true, "清理时应恢复显示");
});

test("承载者还没出现时保留 Pi 内置 Working 提示", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());
	// 模拟 agent_start 之后、第一条 assistant 消息（message_start）之前。
	deps.hasRunHeaderHost = () => false;

	refreshActivityArea(runtime, fake.host, deps);

	assert.deepEqual(runtime.lines, DEFAULT_LINES, "活动行仍要准备好，承载者一出现就能画");
	assert.ok(fake.calls.renders > 0, "承载者未就绪也要重绘一次，避免上轮残留");
	assert.deepEqual(fake.workingVisible, [], "这段窗口里不能关掉 Pi 的 Working 提示");
});

test("承载者出现后接管并关掉 Pi 内置 Working 提示", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());
	// 内容一个字不变，只有承载者从无到有：签名必须因此变化，否则会被去重挡住。
	let hostReady = false;
	deps.hasRunHeaderHost = () => hostReady;

	refreshActivityArea(runtime, fake.host, deps);
	hostReady = true;
	refreshActivityArea(runtime, fake.host, deps);

	assert.deepEqual(fake.workingVisible, [false], "承载者就绪后才关掉内置提示");
});

test("轮首状态行随刷新写入 runtime，清理后清空", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();

	refreshActivityArea(runtime, fake.host, createDeps(activeSnapshot()));
	assert.deepEqual(runtime.runStatusLines, DEFAULT_RUN_STATUS_LINES, "运行时应持有轮首状态行");

	clearActivityArea(runtime, fake.host);
	assert.deepEqual(runtime.runStatusLines, [], "清理后不应残留轮首状态行");
});

test("轮首状态行内容变化也触发重绘", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	let statusLines = ["│ ⠋ 在处理 · 1s"];
	const deps = createDeps(activeSnapshot());
	deps.renderRunStatusLines = () => statusLines;

	refreshActivityArea(runtime, fake.host, deps);
	const rendersAfterFirst = fake.calls.renders;

	statusLines = ["│ ⠙ 在处理 · 2s"];
	refreshActivityArea(runtime, fake.host, deps);

	assert.equal(fake.calls.renders, rendersAfterFirst + 1, "只有状态行变也要重绘");
	assert.deepEqual(runtime.runStatusLines, statusLines, "runtime 应持有最新状态行");
});

test("活动行清空后恢复 Pi 内置 Working 提示", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();

	refreshActivityArea(runtime, fake.host, createDeps(activeSnapshot()));
	// 同一次 run 里活动行被清空（例如运行结束）：内置提示要接回来。
	refreshActivityArea(runtime, fake.host, createDeps(createActivitySnapshot()));

	assert.deepEqual(fake.workingVisible, [false, true], "清空后应恢复显示");
});

test("本轮还在跑时空档里不再把内置 Working 提示弹回来", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();

	refreshActivityArea(runtime, fake.host, createDeps(activeSnapshot(), DEFAULT_ROWS));
	// 工具刚结束、下一条还没开始：这一帧一行活动行都没有，但轮首「处理中 · Ns」还在。
	refreshActivityArea(runtime, fake.host, createDeps(activeSnapshot(), []));

	assert.ok(
		!fake.workingVisible.includes(true),
		`接管过就不能再把内置提示弹回来，否则底部那行「⏱ Ns」会随着每条命令一闪一闪：${fake.workingVisible.join(",")}`,
	);
});

test("轮首不画状态行且这帧没有活动行时，把内置 Working 提示让回去", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot(), []);
	// 轮首被关掉（showRunHeader=false）时它不再是反馈，屏幕上只剩 Pi 的提示。
	deps.isRunHeaderShown = () => false;

	refreshActivityArea(runtime, fake.host, deps);

	assert.ok(
		!fake.workingVisible.includes(false),
		`没有别的反馈时不能关掉内置提示：${fake.workingVisible.join(",")}`,
	);
});

test("定时器启动后存在，停止后释放", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	startActivityTimer(runtime, fake.host, deps);
	assert.notEqual(runtime.timer, undefined, "运行中应存在刷新定时器");

	stopActivityTimer(runtime);
	assert.equal(runtime.timer, undefined);
});

test("清理活动区会停掉定时器、清空行并请求重绘", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	startActivityTimer(runtime, fake.host, deps);
	const rendersAfterStart = fake.calls.renders;
	clearActivityArea(runtime, fake.host);

	assert.equal(runtime.timer, undefined, "清理后不应残留定时器");
	assert.equal(runtime.linesSignature, undefined);
	assert.deepEqual(runtime.lines, [], "清理后不应残留活动行");
	assert.equal(fake.calls.renders, rendersAfterStart + 1, "清理后应重绘一次把行摘掉");
});

test("运行期间活动块行数只增不减，避免内容高度抖动", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	let rows: ActivityRow[] = [{ kind: "item", text: "处理中" }];
	const deps: ActivityAreaDeps = {
		getSnapshot: () => activeSnapshot(),
		// 本用例只关心补位行为，动画固定为开。
		isAnimated: () => true,
		getMaxRows: () => MAX_ROWS,
		renderLines: () => ({ rows, actionRows: [] }),
		renderRunStatusLines: () => DEFAULT_RUN_STATUS_LINES,
		// 补位与承载者无关，固定为已就绪。
		hasRunHeaderHost: () => true,
	};

	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, [`${BRANCH}└─ 处理中`]);

	rows = [
		{ kind: "item", text: "处理中" },
		{ kind: "item", text: "思考 正在定位 token 失效路径" },
	];
	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(
		runtime.lines,
		[`${BRANCH}├─ 处理中`, `${BRANCH}└─ 思考 正在定位 token 失效路径`],
		"新行出现时就地长高，收口跟着最后一项走",
	);

	rows = [{ kind: "item", text: "处理中" }];
	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(
		runtime.lines,
		[`${BRANCH}└─ 处理中`, ""],
		"行变少时用空行补齐，且补位行不带竖折前缀",
	);
});

test("细节形态去掉动作名后重拼前缀，收口落在剩下的最后一项上", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const rows: ActivityRow[] = [
		{ kind: "item", text: "思考 权衡方案" },
		{ kind: "item", text: "运行命令 npm test" },
		{ kind: "tail", text: "↳ 12 passing" },
	];
	const deps = createDeps(activeSnapshot(), rows);
	deps.renderLines = () => ({ rows, actionRows: [1] });

	refreshActivityArea(runtime, fake.host, deps);

	assert.deepEqual(
		runtime.lines,
		[`${BRANCH}├─ 思考 权衡方案`, `${BRANCH}└─ 运行命令 npm test`, `${TAIL}↳ 12 passing`],
		"完整形态里动作行是最后一项",
	);
	assert.deepEqual(
		runtime.detailLines,
		[`${BRANCH}└─ 思考 权衡方案`, `${TAIL}↳ 12 passing`],
		"去掉动作行后思考接替成为最后一项，分支符要重拼成 └─",
	);
});

test("分类计数尾注接在最后一个子项行上，不接输出尾巴，两种形态各接一次", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const rows: ActivityRow[] = [
		{ kind: "item", text: "思考 权衡方案" },
		{ kind: "item", text: "运行命令 npm test" },
		{ kind: "tail", text: "↳ 12 passing" },
	];
	const snapshot: ActivitySnapshot = {
		...activeSnapshot(),
		counters: { read: 4, search: 3, command: 1, other: 0 },
	};
	const deps = createDeps(snapshot, rows);
	deps.renderLines = () => ({ rows, actionRows: [1] });

	refreshActivityArea(runtime, fake.host, deps);

	const note = activityCountersNote(snapshot.counters);
	assert.notEqual(note, "", "前置条件：该快照应当产生尾注");
	assert.ok(
		(runtime.lines[1] ?? "").endsWith(note),
		`尾注应接在最后一个子项行（动作行）尾：${runtime.lines.join("\n")}`,
	);
	assert.equal(
		runtime.lines.at(-1),
		`${TAIL}↳ 12 passing`,
		`输出尾巴保持原样，不带本轮计数：${runtime.lines.join("\n")}`,
	);
	assert.equal(runtime.lines.length, rows.length, "尾注不另占一行，行数预算不变");
	assert.ok(
		(runtime.detailLines[0] ?? "").endsWith(note),
		`去掉动作行之后尾注要重新接在新的最后一项上：${runtime.detailLines.join("\n")}`,
	);
});

test("清理活动区后补位高度归零，下一轮重新计算", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot(), [
		{ kind: "item", text: "处理中" },
		{ kind: "item", text: "思考" },
	]);

	refreshActivityArea(runtime, fake.host, deps);
	clearActivityArea(runtime, fake.host);
	assert.equal(runtime.paddedRows, 0);
});

test("重复启动定时器不会叠加", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	startActivityTimer(runtime, fake.host, deps);
	const first = runtime.timer;
	startActivityTimer(runtime, fake.host, deps);

	assert.equal(runtime.timer, first, "已在运行时不应重复创建");
	stopActivityTimer(runtime);
});
