/**
 * 扩展条目折叠的测试。
 *
 * 补丁装在 pi-tui 的 `Container.prototype` 上，所以每个用例都自己安装并在结束时还原，
 * 避免用例之间共享前一个用例的依赖闭包（骨架对同一原型是幂等的，装了就不会重装）。
 *
 * 这里同时覆盖「pi-tui 被装成两份」的布局：Pi 内部组件继承的那份原型从导出的
 * AssistantMessageComponent 往上取，与扩展自己 import 的 Container 可能不是同一个对象。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { NOTICE_ENTRY_TYPE } from "pi-extensions-i18n";
import {
	installExtensionEntryPatch,
	isExtensionEntryHost,
	isExtensionEntryWorkWindow,
	readExtensionEntryCustomType,
	resolveContainerPrototypes,
	shouldHideExtensionEntry,
} from "../src/extension-entry-patch.ts";
import { isMethodPatchInstalled } from "../src/prototype-patch.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type CleanModeState } from "../src/types.ts";

/** 测一条条目渲染出来的行数。 */
const SINGLE_LINE = 1;
/** 渲染宽度；条目折叠只看行数，用固定宽度即可。 */
const RENDER_WIDTH = 80;

/** 带条目特征的组件结构；与 Pi 的 CustomEntryComponent 同形。 */
interface EntryHostShape {
	entry: { customType: string };
	renderer: () => unknown;
	hasContent: () => boolean;
	children: Array<{ render(width: number): string[]; invalidate(): void }>;
}

/** 结构上等同于 Pi 的 CustomEntryComponent：三个特征字段齐全。 */
class FakeEntryComponent extends Container implements EntryHostShape {
	entry: { customType: string };
	renderer = (): unknown => undefined;
	hasContent = (): boolean => true;

	constructor(customType: string) {
		super();
		this.entry = { customType };
		this.addChild({ render: () => [`entry:${customType}`], invalidate: () => {} });
	}
}

/** 模拟「另一份 pi-tui」的容器：与真实 Container 同形，但不是同一个原型。 */
class ForeignContainer {
	children: EntryHostShape["children"] = [];

	/** 拼接子组件行；与真实 Container.render 的关键行为一致。 */
	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}
}

/**
 * 造一个继承 Pi 内部那份 Container 原型的条目组件。
 *
 * 用 `Object.create` 而不是 `new`：目标原型来自 Pi 导出的组件，不是本文件 import 的
 * Container 类，所以没有可用的构造函数。
 */
function createPiSideEntryHost(customType: string): EntryHostShape & { render(width: number): string[] } {
	const piComponentPrototype: object = Object.getPrototypeOf(AssistantMessageComponent.prototype) as object;
	const host = Object.create(piComponentPrototype) as EntryHostShape & { render(width: number): string[] };
	host.entry = { customType };
	host.renderer = () => undefined;
	host.hasContent = () => true;
	host.children = [{ render: () => [`entry:${customType}`], invalidate: () => {} }];
	return host;
}

/** 造一份指定折叠状态的副本。 */
function stateWith(patch: Partial<CleanModeState>): CleanModeState {
	return { collapsed: false, runSettled: false, userOverrodeThisRun: false, ...patch };
}

/** 造一份指定配置的副本。 */
function configWith(patch: Partial<CleanModeConfig>): CleanModeConfig {
	return { ...DEFAULT_CLEAN_MODE_CONFIG, ...patch };
}

/** 补丁依赖的可改写盒子；测试通过改它模拟运行进度。 */
interface PatchBox {
	state: CleanModeState;
	config: CleanModeConfig;
	restoreWindow: boolean;
}

/** 安装补丁、跑用例、还原；原型列表按运行时解析情况取，与入口装配一致。 */
function withPatch(init: PatchBox, run: (box: PatchBox) => void): void {
	const box: PatchBox = { ...init };
	const restore = installExtensionEntryPatch({
		getState: () => box.state,
		getConfig: () => box.config,
		isHistoryRestoreWindow: () => box.restoreWindow,
		containerPrototypes: resolveContainerPrototypes({
			ownContainerPrototype: Container.prototype,
			piComponentPrototype: AssistantMessageComponent.prototype,
		}),
	});
	try {
		run(box);
	} finally {
		restore();
	}
}

test("特征判定只认条目组件", () => {
	const entry = new FakeEntryComponent("pi-distill-audit");
	assert.equal(isExtensionEntryHost(entry), true);
	assert.equal(isExtensionEntryHost(new Container()), false);
	assert.equal(isExtensionEntryHost(undefined), false);
	assert.equal(isExtensionEntryHost({ entry: {} }), false, "缺 renderer 与 hasContent 不算");
	assert.equal(readExtensionEntryCustomType(entry), "pi-distill-audit");
	assert.equal(readExtensionEntryCustomType({ entry: { customType: 42 } }), undefined);
	assert.equal(readExtensionEntryCustomType({ entry: { customType: "" } }), undefined);
});

test("工作窗口覆盖运行中与会话恢复", () => {
	const running = stateWith({ runSettled: false });
	const settled = stateWith({ runSettled: true });
	assert.equal(isExtensionEntryWorkWindow({ state: running, isHistoryRestoreWindow: false }), true);
	assert.equal(isExtensionEntryWorkWindow({ state: settled, isHistoryRestoreWindow: true }), true);
	assert.equal(isExtensionEntryWorkWindow({ state: settled, isHistoryRestoreWindow: false }), false);
});

test("折叠判定：只有工作条目 + 折叠态 + 开关都打开才隐藏", () => {
	const collapsed = stateWith({ collapsed: true });
	const config = configWith({});
	assert.equal(
		shouldHideExtensionEntry({ state: collapsed, config, customType: "pi-distill-audit", isWorkEntry: true }),
		true,
	);
	assert.equal(
		shouldHideExtensionEntry({ state: collapsed, config, customType: "pi-distill-audit", isWorkEntry: false }),
		false,
		"非工作条目保持可见",
	);
	assert.equal(
		shouldHideExtensionEntry({
			state: stateWith({ collapsed: false }),
			config,
			customType: "pi-distill-audit",
			isWorkEntry: true,
		}),
		false,
		"展开态一律可见",
	);
	assert.equal(
		shouldHideExtensionEntry({
			state: collapsed,
			config: configWith({ hideExtensionEntries: false }),
			customType: "pi-distill-audit",
			isWorkEntry: true,
		}),
		false,
	);
	assert.equal(
		shouldHideExtensionEntry({
			state: collapsed,
			config: configWith({ enabled: false }),
			customType: "pi-distill-audit",
			isWorkEntry: true,
		}),
		false,
	);
	assert.equal(
		shouldHideExtensionEntry({ state: collapsed, config, customType: NOTICE_ENTRY_TYPE, isWorkEntry: true }),
		false,
		"通知条目豁免",
	);
});

test("原型解析：同一份时只返回一个，不同份时两个都返回", () => {
	const resolved = resolveContainerPrototypes({
		ownContainerPrototype: Container.prototype,
		piComponentPrototype: AssistantMessageComponent.prototype,
	});
	assert.ok(resolved.length === 1 || resolved.length === 2, "真实布局下最多两份原型");
	assert.equal(resolved[0], Container.prototype);

	// 造一份「不是同一个对象」的父原型，验证两条都会被收集。
	const foreignPrototype = { render: () => [] };
	class FakePiComponent {}
	Object.setPrototypeOf(FakePiComponent.prototype, foreignPrototype);
	const both = resolveContainerPrototypes({
		ownContainerPrototype: Container.prototype,
		piComponentPrototype: FakePiComponent.prototype,
	});
	assert.deepEqual(both, [Container.prototype, foreignPrototype]);
});

test("两份不同的 Container 原型都会被补丁", () => {
	const prototypes: object[] = [Container.prototype, ForeignContainer.prototype];
	const restore = installExtensionEntryPatch({
		getState: () => stateWith({ collapsed: true, runSettled: false }),
		getConfig: () => configWith({}),
		isHistoryRestoreWindow: () => false,
		containerPrototypes: prototypes,
	});
	try {
		for (const prototype of prototypes) {
			assert.equal(isMethodPatchInstalled(prototype, "render"), true);
		}
	} finally {
		restore();
	}
});

test("运行中出现的条目，收起后一行都不占", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, (box) => {
		const entry = new FakeEntryComponent("pi-distill-audit");
		assert.equal(entry.render(RENDER_WIDTH).length, SINGLE_LINE, "运行中保持可见");

		box.state = stateWith({ collapsed: true, runSettled: false });
		assert.deepEqual(entry.render(RENDER_WIDTH), [], "收起后不占行");
	});
});

test("条目归属在首次渲染时固定，运行结束后不会反转", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, (box) => {
		const entry = new FakeEntryComponent("pi-distill-audit");
		entry.render(RENDER_WIDTH);
		box.state = stateWith({ collapsed: true, runSettled: true });
		assert.deepEqual(entry.render(RENDER_WIDTH), [], "已判定为工作条目的组件不会因为运行结束而留下");
	});
});

test("运行结束后才出现的条目保持可见", () => {
	withPatch({ state: stateWith({ collapsed: true, runSettled: true }), config: configWith({}), restoreWindow: false }, () => {
		const entry = new FakeEntryComponent("pi-metrics-tps");
		assert.equal(entry.render(RENDER_WIDTH).length, SINGLE_LINE, "运行之外的条目不属于工作过程");
	});
});

test("会话恢复窗口内的历史条目在收起时隐藏", () => {
	withPatch({ state: stateWith({ collapsed: true, runSettled: true }), config: configWith({}), restoreWindow: true }, () => {
		const entry = new FakeEntryComponent("pi-distill-audit");
		assert.deepEqual(entry.render(RENDER_WIDTH), []);
	});
});

test("Pi 内部那份 Container 上的条目同样会被收起", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, (box) => {
		const entry = createPiSideEntryHost("pi-distill-audit");
		assert.equal(entry.render(RENDER_WIDTH).length, SINGLE_LINE, "运行中保持可见");

		box.state = stateWith({ collapsed: true, runSettled: false });
		assert.deepEqual(entry.render(RENDER_WIDTH), [], "收起后不占行");
	});
});

test("通知条目无论何时都可见", () => {
	withPatch({ state: stateWith({ collapsed: true, runSettled: false }), config: configWith({}), restoreWindow: false }, () => {
		const entry = new FakeEntryComponent(NOTICE_ENTRY_TYPE);
		assert.equal(entry.render(RENDER_WIDTH).length, SINGLE_LINE);
	});
});

test("关掉扩展条目折叠后，工作条目在收起态也保留", () => {
	withPatch(
		{ state: stateWith({ collapsed: true, runSettled: false }), config: configWith({ hideExtensionEntries: false }), restoreWindow: false },
		() => {
			const entry = new FakeEntryComponent("pi-distill-audit");
			assert.equal(entry.render(RENDER_WIDTH).length, SINGLE_LINE);
		},
	);
});

test("普通容器渲染不受补丁影响", () => {
	withPatch({ state: stateWith({ collapsed: true, runSettled: false }), config: configWith({}), restoreWindow: false }, () => {
		const container = new Container();
		container.addChild({ render: () => ["plain"], invalidate: () => {} });
		assert.deepEqual(container.render(RENDER_WIDTH), ["plain"]);
	});
});
