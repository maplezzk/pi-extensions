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
import { createActivitySnapshot, type ActivitySnapshot } from "../src/activity.ts";
import { ACTIVITY_ROWS_DEFAULT } from "../src/types.ts";

/** 活动区默认行数，测试里同样用它避免魔法值。 */
const MAX_ROWS = ACTIVITY_ROWS_DEFAULT;
/** 默认的固定渲染行。 */
const DEFAULT_LINES = ["│ ⠹ 运行命令"];
/** 内容变化对比用的第一组行。 */
const NPM_TEST_LINES = ["│ ⠹ 运行命令 npm test"];
/** 内容变化对比用的第二组行。 */
const NPM_BUILD_LINES = ["│ ⠸ 运行命令 npm run build"];

/**
 * 测试用的假 UI 宿主。
 *
 * 活动行内联在 transcript 里，所以宿主侧要观察的是「请求了几次重绘」和
 * 「有没有挂过 transcript 补丁」，而不是过去那种 setWidget 调用。
 */
interface FakeHost {
	host: ActivityUiHost;
	/** 显示层调用计数。 */
	calls: { renders: number; attaches: number };
	/** Pi 内置 Working 提示的显隐变化。 */
	workingVisible: boolean[];
	/** 隐藏思考占位文案的每次设置。 */
	thinkingLabels: Array<string | undefined>;
}

/** 造一个记录调用的假 UI 宿主；不需要伪造整个 ExtensionContext。 */
function createFakeHost(): FakeHost {
	const calls = { renders: 0, attaches: 0 };
	const workingVisible: boolean[] = [];
	const thinkingLabels: Array<string | undefined> = [];

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
			/** 记录隐藏思考占位文案的每次设置。 */
			setHiddenThinkingLabel: (label?: string) => {
				thinkingLabels.push(label);
			},
		},
		/** 活动行内联渲染，刷新只体现为一次重绘请求。 */
		requestRender: () => {
			calls.renders += 1;
		},
		/** 记录补丁挂载尝试。 */
		attachTranscript: () => {
			calls.attaches += 1;
		},
	};

	return { host, calls, workingVisible, thinkingLabels };
}

/** 造一个返回固定行的渲染依赖。 */
function createDeps(snapshot: ActivitySnapshot, lines: string[] = DEFAULT_LINES): ActivityAreaDeps {
	return {
		getSnapshot: () => snapshot,
		// 本组用例只关心去重与生命周期，动画固定为开。
		isAnimated: () => true,
		getMaxRows: () => MAX_ROWS,
		renderLines: () => lines,
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

/**
 * 合约：transcript 容器要等第一条 assistant 消息出现才存在，所以运行中每次刷新
 * 都试挂一次；已挂上时是常量时间的短路。
 */
test("运行中每次刷新都试挂补丁，便于等第一条 assistant 消息出现后补上", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	refreshActivityArea(runtime, fake.host, deps);
	assert.equal(fake.calls.attaches, 2, "内容无变化也要重试挂载，已挂上时是短路");
});

test("内容变化时更新行并请求重绘", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	let lines = NPM_TEST_LINES;
	const deps: ActivityAreaDeps = {
		getSnapshot: () => activeSnapshot(),
		// 本用例只关心内容变化触发重绘。
		isAnimated: () => true,
		getMaxRows: () => MAX_ROWS,
		renderLines: () => lines,
	};

	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, NPM_TEST_LINES, "runtime 应持有当前渲染行");
	const rendersAfterFirst = fake.calls.renders;

	lines = NPM_BUILD_LINES;
	refreshActivityArea(runtime, fake.host, deps);
	assert.equal(fake.calls.renders, rendersAfterFirst + 1, "内容变化应请求重绘");
	assert.deepEqual(runtime.lines, NPM_BUILD_LINES, "runtime 的行应跟着更新");
});

test("没有内容时清空行，只请求重绘不挂补丁", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(createActivitySnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, [], "未运行时不应留下任何活动行");
	assert.equal(fake.calls.renders, 1, "清空行也要重绘一次");
	assert.equal(fake.calls.attaches, 0, "没有内容时不需要挂 transcript 补丁");
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

test("活动区有内容时清空 Pi 的隐藏思考占位文案", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(fake.thinkingLabels, [""]);
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
	let lines = ["│ 处理中"];
	const deps: ActivityAreaDeps = {
		getSnapshot: () => activeSnapshot(),
		// 本用例只关心补位行为，动画固定为开。
		isAnimated: () => true,
		getMaxRows: () => MAX_ROWS,
		renderLines: () => lines,
	};

	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, ["│ 处理中"]);

	lines = ["│ 处理中", "│ 思考 正在定位 token 失效路径"];
	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, lines, "新行出现时就地长高");

	lines = ["│ 处理中"];
	refreshActivityArea(runtime, fake.host, deps);
	assert.deepEqual(runtime.lines, ["│ 处理中", ""], "行变少时用空行补齐，不缩回去");
});

test("清理活动区后补位高度归零，下一轮重新计算", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot(), ["│ 处理中", "│ 思考"]);

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
