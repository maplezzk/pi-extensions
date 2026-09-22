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
	applyEntryRail,
	dropLeadingBlankLines,
	installExtensionEntryPatch,
	isExtensionEntryHost,
	isExtensionEntryWorkWindow,
	isExtensionMessageHost,
	readExtensionEntryCustomType,
	resolveContainerPrototypes,
	shouldHideExtensionEntry,
	shouldRailExtensionEntry,
} from "../src/extension-entry-patch.ts";
import { isMethodPatchInstalled } from "../src/prototype-patch.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type CleanModeState } from "../src/types.ts";

/** 测一条条目渲染出来的行数。 */
const SINGLE_LINE = 1;
/** 渲染宽度；条目折叠只看行数，用固定宽度即可。 */
const RENDER_WIDTH = 80;
/** 测试用的轨道前缀；与真实实现的 `│ ` 同宽。 */
const RAIL_PREFIX = "│ ";
/** 轨道前缀的可见列宽，用来验证渲染宽度确实让出去了。 */
const RAIL_WIDTH = 2;

/** 带条目特征的组件结构；与 Pi 的 CustomEntryComponent 同形。 */
interface EntryHostShape {
	entry: { customType: string };
	renderer: () => unknown;
	hasContent: () => boolean;
	children: Array<{ render(width: number): string[]; invalidate(): void }>;
}

/** 结构上等同于 Pi 的 CustomEntryComponent：三个特征字段齐全。 */
class FakeEntryComponent extends Container implements EntryHostShape {
	entry: { customType: string; data?: unknown };
	renderer = (): unknown => undefined;
	hasContent = (): boolean => true;

	/**
	 * @param customType 条目的 customType。
	 * @param data 条目载荷；通知条目用它带 level。
	 */
	constructor(customType: string, data?: unknown) {
		super();
		this.entry = data === undefined ? { customType } : { customType, data };
		this.addChild({ render: () => [`entry:${customType}`], invalidate: () => {} });
	}
}

/** 把收到的渲染宽度写进行里的条目：用来核对带轨道前缀时宽度让出了两列。 */
class WidthReportingEntry extends Container implements EntryHostShape {
	entry: { customType: string };
	renderer = (): unknown => undefined;
	hasContent = (): boolean => true;

	/**
	 * @param customType 条目的 customType。
	 * @param entry 复用的条目对象；不传时新建一个，用于模拟「同一条目换一个组件实例」。
	 */
	constructor(customType: string, entry: { customType: string } = { customType }) {
		super();
		this.entry = entry;
		this.addChild({ render: (width: number) => [`w=${width}`], invalidate: () => {} });
	}
}

/** 造一个与 target 共用同一条目对象的组件，模拟 Pi 重建组件实例。 */
function rebuildEntry(target: EntryHostShape): WidthReportingEntry {
	return new WidthReportingEntry(target.entry.customType, target.entry);
}

/**
 * 结构上等同于 Pi 的 CustomMessageComponent：扩展注册的消息渲染器（工作流结果面板）。
 *
 * 它不参与条目折叠，只参与接轨道，所以字段故意和条目组件不同。
 */
class FakeMessageComponent extends Container {
	message = { customType: "workflow_result" };
	customRenderer = (): unknown => undefined;
	setExpanded = (): void => undefined;

	/**
	 * @param leadingBlank 是否像 Pi 那样在内容前面插一个空行（`Spacer(1)`）。
	 */
	constructor(leadingBlank = false) {
		super();
		this.addChild({
			render: (width: number) => (leadingBlank ? ["", `w=${width}`] : [`w=${width}`]),
			invalidate: () => {},
		});
	}
}

/**
 * 结构上等同于 Pi 的 CustomEntryComponent：内容前面自带一个空行（`Spacer(1)`）。
 *
 * Pi 的条目与消息组件都是这样开头的（custom-entry.js / custom-message.js），运行期间
 * 接轨道时那一行要去掉，否则密集列表里每块前面都空出一行。
 */
class SpacerPrefixedEntry extends Container implements EntryHostShape {
	entry: { customType: string };
	renderer = (): unknown => undefined;
	hasContent = (): boolean => true;

	constructor(customType: string) {
		super();
		this.entry = { customType };
		this.addChild({ render: () => ["", `entry:${customType}`], invalidate: () => {} });
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
	/** 轨道前缀；`undefined` 模拟主题还没就绪。 */
	railPrefix?: string | undefined;
}

/** 安装补丁、跑用例、还原；原型列表按运行时解析情况取，与入口装配一致。 */
function withPatch(init: PatchBox, run: (box: PatchBox) => void): void {
	const box: PatchBox = { railPrefix: RAIL_PREFIX, ...init };
	const restore = installExtensionEntryPatch({
		getState: () => box.state,
		getConfig: () => box.config,
		isHistoryRestoreWindow: () => box.restoreWindow,
		getEntryRailPrefix: () => box.railPrefix,
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

test("消息组件与条目组件是两套判定", () => {
	const message = new FakeMessageComponent();
	assert.equal(isExtensionMessageHost(message), true);
	assert.equal(isExtensionMessageHost(new Container()), false);
	assert.equal(isExtensionMessageHost(undefined), false);
	assert.equal(isExtensionMessageHost({ message: {} }), false, "缺 customRenderer 与 setExpanded 不算");
	assert.equal(isExtensionEntryHost(message), false, "消息组件不是条目组件，不参与条目折叠");
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
		shouldHideExtensionEntry({
			state: collapsed,
			config,
			customType: NOTICE_ENTRY_TYPE,
			noticeLevel: "info",
			isWorkEntry: true,
		}),
		true,
		"info 级通知属于过程噪声，跟工作过程一起收起",
	);
	assert.equal(
		shouldHideExtensionEntry({
			state: collapsed,
			config,
			customType: NOTICE_ENTRY_TYPE,
			noticeLevel: "warning",
			isWorkEntry: true,
		}),
		false,
		"警告不能被静默吞掉",
	);
	assert.equal(
		shouldHideExtensionEntry({
			state: collapsed,
			config,
			customType: NOTICE_ENTRY_TYPE,
			noticeLevel: "error",
			isWorkEntry: true,
		}),
		false,
		"错误同样不能被静默吞掉",
	);
	assert.equal(
		shouldHideExtensionEntry({ state: collapsed, config, customType: NOTICE_ENTRY_TYPE, isWorkEntry: true }),
		false,
		"读不出版本（未带 level）的通知按可见处理，宁可多显示一条",
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
		getEntryRailPrefix: () => RAIL_PREFIX,
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

test("收起态下 info 级通知跟着收起，警告仍可见", () => {
	withPatch({ state: stateWith({ collapsed: true, runSettled: false }), config: configWith({}), restoreWindow: false }, () => {
		// 真实的 metrics 条目就是这个形状：customType 是通知类型，载荷里带 level。
		const info = new FakeEntryComponent(NOTICE_ENTRY_TYPE, { tag: "metrics", level: "info", message: "TPS" });
		assert.deepEqual(info.render(RENDER_WIDTH), [], "info 级通知在收起态应不占行");

		const warning = new FakeEntryComponent(NOTICE_ENTRY_TYPE, { tag: "clean-mode", level: "warning", message: "x" });
		assert.equal(warning.render(RENDER_WIDTH).length, SINGLE_LINE, "警告必须留着");
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

test("运行中的消息组件（工作流结果面板）也带上轨道前缀，且不被条目折叠收走", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, (box) => {
		const message = new FakeMessageComponent();
		assert.deepEqual(message.render(RENDER_WIDTH), [`${RAIL_PREFIX}w=${RENDER_WIDTH - RAIL_WIDTH}`]);

		// 收起态：组头不显示，消息块也不该被条目折叠收走。
		box.state = stateWith({ collapsed: true, runSettled: false });
		assert.deepEqual(message.render(RENDER_WIDTH), [`${RAIL_PREFIX}w=${RENDER_WIDTH - RAIL_WIDTH}`]);
	});
});

test("运行之外的消息组件不加轨道前缀", () => {
	withPatch({ state: stateWith({ runSettled: true }), config: configWith({}), restoreWindow: false }, () => {
		const message = new FakeMessageComponent();
		assert.deepEqual(message.render(RENDER_WIDTH), [`w=${RENDER_WIDTH}`]);
	});
});

test("轨道判定：只有运行中（未收起）的条目才加轨道", () => {
	const running = stateWith({ runSettled: false });
	const config = configWith({});
	assert.equal(shouldRailExtensionEntry({ state: running, config }), true);
	assert.equal(
		shouldRailExtensionEntry({ state: stateWith({ collapsed: true }), config }),
		false,
		"收起态组头本身不显示",
	);
	assert.equal(
		shouldRailExtensionEntry({ state: stateWith({ runSettled: true }), config }),
		false,
		"运行之外没有轨道可接",
	);
	assert.equal(
		shouldRailExtensionEntry({ state: running, config: configWith({ enabled: false }) }),
		false,
	);
});

test("轨道前缀逐行拼接，行数不变", () => {
	assert.deepEqual(applyEntryRail(["a", ""], RAIL_PREFIX), [`${RAIL_PREFIX}a`, RAIL_PREFIX]);
});

test("去掉开头自带的空行：只去开头的，末尾的留着", () => {
	assert.deepEqual(dropLeadingBlankLines(["", "a"]), ["a"]);
	assert.deepEqual(dropLeadingBlankLines(["", "", "a"]), ["a"]);
	assert.deepEqual(dropLeadingBlankLines(["a", ""]), ["a", ""], "末尾空行不是 Pi 加的");
	assert.deepEqual(dropLeadingBlankLines(["a"]), ["a"]);
	assert.deepEqual(dropLeadingBlankLines([]), []);
	assert.deepEqual(
		dropLeadingBlankLines(["", ""]),
		["", ""],
		"整块都是空行时不能变成 0 行",
	);
});

test("运行中的条目：开头那行空行不占行，块与相邻记录紧挨着", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, () => {
		const entry = new SpacerPrefixedEntry(NOTICE_ENTRY_TYPE);
		assert.deepEqual(entry.render(RENDER_WIDTH), [`${RAIL_PREFIX}entry:${NOTICE_ENTRY_TYPE}`]);

		const message = new FakeMessageComponent(true);
		assert.deepEqual(
			message.render(RENDER_WIDTH),
			[`${RAIL_PREFIX}w=${RENDER_WIDTH - RAIL_WIDTH}`],
			"工作流结果面板同样自带空行，一并去掉",
		);
	});
});

test("运行之外的条目保留 Pi 自己的空行", () => {
	withPatch({ state: stateWith({ runSettled: true }), config: configWith({}), restoreWindow: false }, () => {
		const entry = new SpacerPrefixedEntry(NOTICE_ENTRY_TYPE);
		assert.deepEqual(entry.render(RENDER_WIDTH), ["", `entry:${NOTICE_ENTRY_TYPE}`]);
	});
});

test("运行中的扩展条目带上轨道前缀，并让出前缀占的两列", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, () => {
		const notice = new WidthReportingEntry(NOTICE_ENTRY_TYPE);
		assert.deepEqual(notice.render(RENDER_WIDTH), [`${RAIL_PREFIX}w=${RENDER_WIDTH - RAIL_WIDTH}`]);

		const audit = new WidthReportingEntry("pi-distill-audit");
		assert.deepEqual(
			audit.render(RENDER_WIDTH),
			[`${RAIL_PREFIX}w=${RENDER_WIDTH - RAIL_WIDTH}`],
			"工作流结果面板、审计卡片同样铺满整宽，也得接上轨道",
		);
	});
});

test("收起态与运行之外的提示条目不加轨道前缀", () => {
	withPatch({ state: stateWith({ collapsed: true, runSettled: false }), config: configWith({}), restoreWindow: false }, () => {
		const entry = new WidthReportingEntry(NOTICE_ENTRY_TYPE);
		assert.deepEqual(entry.render(RENDER_WIDTH), [`w=${RENDER_WIDTH}`]);
	});
	withPatch({ state: stateWith({ runSettled: true }), config: configWith({}), restoreWindow: false }, () => {
		const entry = new WidthReportingEntry(NOTICE_ENTRY_TYPE);
		assert.deepEqual(entry.render(RENDER_WIDTH), [`w=${RENDER_WIDTH}`]);
	});
});

test("拿不到轨道前缀时按原样渲染", () => {
	withPatch(
		{ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false, railPrefix: undefined },
		() => {
			const entry = new WidthReportingEntry(NOTICE_ENTRY_TYPE);
			assert.deepEqual(entry.render(RENDER_WIDTH), [`w=${RENDER_WIDTH}`]);
		},
	);
});

test("宽度放不下前缀时按原样渲染", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, () => {
		const entry = new WidthReportingEntry(NOTICE_ENTRY_TYPE);
		assert.deepEqual(entry.render(RAIL_WIDTH), [`w=${RAIL_WIDTH}`]);
	});
});

test("轨道归属在首次渲染时固定，收起后仍然带着", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, (box) => {
		const entry = new FakeEntryComponent(NOTICE_ENTRY_TYPE);
		assert.deepEqual(entry.render(RENDER_WIDTH), [`${RAIL_PREFIX}entry:${NOTICE_ENTRY_TYPE}`]);

		box.state = stateWith({ collapsed: true, runSettled: true });
		assert.deepEqual(
			entry.render(RENDER_WIDTH),
			[`${RAIL_PREFIX}entry:${NOTICE_ENTRY_TYPE}`],
			"已判定归属的提示不会因为运行结束而变样",
		);
	});
});

test("Pi 重建条目组件后，轨道归属跟着条目对象走", () => {
	withPatch({ state: stateWith({ collapsed: true, runSettled: true }), config: configWith({}), restoreWindow: false }, (box) => {
		// 启动时的提示：先按「不在运行中」记下归属。
		const first = new WidthReportingEntry(NOTICE_ENTRY_TYPE);
		assert.deepEqual(first.render(RENDER_WIDTH), [`w=${RENDER_WIDTH}`]);

		// 运行开始了，而且 Pi 用同一条目对象重建了组件。
		box.state = stateWith({ collapsed: false, runSettled: false });
		const rebuilt = rebuildEntry(first);
		assert.deepEqual(
			rebuilt.render(RENDER_WIDTH),
			[`w=${RENDER_WIDTH}`],
			"按实例记归属时这里会凭空多出竖条：同一条提示的判定必须跟着条目对象",
		);
	});
});

test("重建后归属为真的提示仍然带着轨道前缀", () => {
	withPatch({ state: stateWith({ runSettled: false }), config: configWith({}), restoreWindow: false }, (box) => {
		const first = new WidthReportingEntry(NOTICE_ENTRY_TYPE);
		assert.deepEqual(first.render(RENDER_WIDTH), [`${RAIL_PREFIX}w=${RENDER_WIDTH - RAIL_WIDTH}`]);

		box.state = stateWith({ collapsed: true, runSettled: true });
		const rebuilt = rebuildEntry(first);
		assert.deepEqual(rebuilt.render(RENDER_WIDTH), [`${RAIL_PREFIX}w=${RENDER_WIDTH - RAIL_WIDTH}`]);
	});
});
