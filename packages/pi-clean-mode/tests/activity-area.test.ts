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

/** 记录一次 setWidget 调用的实参。 */
interface WidgetCall {
	key: string;
	/** 传 undefined 表示摘掉 widget。 */
	content: unknown;
}

/** 测试用的假 UI 宿主，记录所有显示层调用。 */
interface FakeHost {
	host: ActivityUiHost;
	widgets: WidgetCall[];
	workingVisible: boolean[];
	thinkingLabels: Array<string | undefined>;
}

/** 造一个记录调用的假 UI 宿主；不需要伪造整个 ExtensionContext。 */
function createFakeHost(): FakeHost {
	const widgets: WidgetCall[] = [];
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
			/** 记录每次挂载或摘掉 widget 的实参。 */
			setWidget: (key: string, content: unknown) => {
				widgets.push({ key, content });
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
	};

	return { host, widgets, workingVisible, thinkingLabels };
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

test("内容不变时跳过第二次 setWidget，避免整屏重绘", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	const afterFirst = fake.widgets.length;

	refreshActivityArea(runtime, fake.host, deps);
	assert.equal(fake.widgets.length, afterFirst, "签名相同不应再次调用 setWidget");
});

test("内容变化时重新挂载 widget", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	let lines = NPM_TEST_LINES;
	const deps: ActivityAreaDeps = {
		getSnapshot: () => activeSnapshot(),
		// 本用例只关心内容变化触发重挂载。
		isAnimated: () => true,
		getMaxRows: () => MAX_ROWS,
		renderLines: () => lines,
	};

	refreshActivityArea(runtime, fake.host, deps);
	const afterFirst = fake.widgets.length;

	lines = NPM_BUILD_LINES;
	refreshActivityArea(runtime, fake.host, deps);
	assert.equal(fake.widgets.length, afterFirst + 1, "内容变化应重新挂载");
});

test("没有内容时摘掉 widget 而不是画空 widget", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(createActivitySnapshot());

	refreshActivityArea(runtime, fake.host, deps);
	assert.equal(fake.widgets.length, 1);
	assert.equal(fake.widgets[0]?.content, undefined);
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

test("清理活动区会同时停掉定时器并摘掉 widget", () => {
	const fake = createFakeHost();
	const runtime = createActivityAreaRuntime();
	const deps = createDeps(activeSnapshot());

	startActivityTimer(runtime, fake.host, deps);
	clearActivityArea(runtime, fake.host);

	assert.equal(runtime.timer, undefined, "清理后不应残留定时器");
	assert.equal(fake.widgets[fake.widgets.length - 1]?.content, undefined);
	assert.equal(runtime.widgetSignature, undefined);
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
