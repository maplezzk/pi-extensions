/**
 * 实时活动区的运行时。
 *
 * 活动行内联在对话里（见 component-patches.ts）：本轮已经有工具行时挂在当前动作组头上，
 * 跟着最新动作走；还没有工具行、或者收起态看不到工具行时，回落到轮首槽位。
 * 不用 Pi 的 widget：widget 固定在编辑器上下方，滚历史时它不动，看起来像钉在底部的一条状态。
 *
 * 为什么还要签名去重：活动行每 tick 都会重算，但内容常常没变（例如耗时没走到
 * 下一秒、动画帧循环回同一格）。内容不变时完全跳过重绘，让整屏刷新只发生在真正
 * 有新信息的时候；动画按固定节拍推进，并让定时器只在运行期间存在。
 *
 * 刷新只做两件事：更新 runtime.lines，再请求重绘。行从哪里渲染由 component-patches.ts
 * 决定（轮首子组件或当前组头的工具行）；这两个动作都是 ActivityUiHost 的必需成员，刻意不套
 * safeUiCall：它们抛错说明扩展入口的适配层坏了，应当暴露而不是吞掉；safeUiCall
 * 只用于老版本 Pi 可能缺失的可选 UI 方法。
 *
 * 另一个必须先想的点：活动行要等一个能挂它的组件先出现 —— 轮首槽位属于本轮第一条
 * assistant 消息（message_start 才创建），组头则是第一个工具调用。所以从 agent_start
 * 到第一个 token 之间活动行根本画不出来，这段时间必须留着 Pi 自带的 Working 提示，
 * 否则屏幕上什么都没有，看起来就是卡住。
 */

import type { ActivityPainter, ActivitySnapshot } from "./activity.js";

/** 开启动画时的刷新间隔：约 6.7fps，跟 cli-spinners 点状动画的手感对齐。 */
const ANIMATED_INTERVAL_MS = 150;
/** 关闭动画时的刷新间隔，只是为了让耗时数字仍然更新。 */
const STILL_INTERVAL_MS = 1000;

/**
 * 活动区需要的 UI 能力。
 *
 * 刻意比 `ExtensionContext` 窄：这里只用到主题取色、内置 Working 提示的显隐开关，
 * 以及触发重绘，窄接口让测试无需伪造整个上下文。
 */
export interface ActivityUiHost {
	ui: {
		/** 主题取色能力，用于渲染活动行。 */
		theme: ActivityPainter;
		/** 控制 Pi 内置 Working 提示的显隐。 */
		setWorkingVisible(visible: boolean): void;
	};
	/** 把最新活动行刷到屏幕上。 */
	requestRender(): void;
}

/** 活动区运行时持有的可变状态。 */
export interface ActivityAreaRuntime {
	/** 上一次渲染结果的行签名，用于跳过无变化的重绘。 */
	linesSignature?: string;
	/**
	 * 当前要展示在 transcript 末尾的行；空数组表示不展示。
	 *
	 * 本文件只负责写：每次重算后与 linesSignature 成对更新，由扩展入口通过
	 * `getLines` 交给轮首子组件在渲染时读取。
	 */
	lines: string[];
	/**
	 * 本轮活动块见过的最大行数。
	 *
	 * 块内行数增减会改变对话内容高度，底部锚定就会被反复拉动，看起来就是「卡/跳」。
	 * 所以运行期间行数只增不减（不足的行用空行补齐），新行出现时就地长高，不会先长后缩。
	 */
	paddedRows: number;
	/** 动画帧序号。 */
	frame: number;
	/** 刷新定时器；只在运行期间存在。 */
	timer?: ReturnType<typeof setInterval>;
	/** 最近一次拿到的 UI 宿主，定时器回调里复用它。 */
	lastHost?: ActivityUiHost;
	/** 活动区是否正在替代 Pi 内置的 Working 提示。 */
	workingSuppressed: boolean;
}

/** 活动区从扩展入口注入的依赖。 */
export interface ActivityAreaDeps {
	/** 读取当前活动快照。 */
	getSnapshot: () => ActivitySnapshot;
	/** 是否开启动画。 */
	isAnimated: () => boolean;
	/** 最多显示几行。 */
	getMaxRows: () => number;
	/** 用给定主题渲染活动区行。 */
	renderLines: (input: ActivityLinesInput) => string[];
	/**
	 * 本轮是否已经有能承载活动行的轮首组件。
	 *
	 * 轮首槽位属于本轮第一条 assistant 消息，它要等 message_start 才存在。在那之前
	 * 活动行画不出来（组头也还没有），Pi 自带的 Working 提示就得继续顶着，
	 * 否则从 agent_start 到第一个 token 之间屏幕上没有任何反馈。
	 */
	hasRunHeaderHost: () => boolean;
}

/** 渲染活动区行的输入。 */
export interface ActivityLinesInput {
	/** 主题取色能力。 */
	painter: ActivityPainter;
	/** 动画帧序号。 */
	frame: number;
	/** 最多渲染几行。 */
	maxRows: number;
	/** 是否启用动画。 */
	animated: boolean;
}

/** 创建活动区运行时状态。 */
export function createActivityAreaRuntime(): ActivityAreaRuntime {
	return { frame: 0, workingSuppressed: false, lines: [], paddedRows: 0 };
}

/** 安全调用 ui 上的可选方法；老版本或极简上下文可能不提供。 */
function safeUiCall(action: () => void): void {
	try {
		action();
	} catch {
		// 显示层失败不影响主流程。
	}
}

/** 补位用的空行：活动块只长高不缩短，多出来的行用空行占位。 */
const PADDING_ROW = "";
/** 去重签名里的「承载者已就绪」标记。 */
const SIGNATURE_HOST_READY = "host:ready";
/** 去重签名里的「承载者还没出现」标记。 */
const SIGNATURE_HOST_MISSING = "host:missing";

/**
 * 组装去重签名：行内容 + 承载者是否就绪。
 *
 * 承载者就绪与否必须参与签名：内容一个字都没变但承载者刚从无到有时，也要让签名
 * 变化一次，下一个 tick 才能重新接管并关掉 Pi 的内置提示；否则会被去重挡住。
 */
function buildLinesSignature(lines: string[], hostReady: boolean): string {
	return `${hostReady ? SIGNATURE_HOST_READY : SIGNATURE_HOST_MISSING}\n${lines.join("\n")}`;
}

/**
 * 把活动行补齐到本轮见过的最大行数。
 *
 * 行数来回变化会让对话内容高度抖动，底部锚定被反复拉动；补齐后运行期间只会「长高」，
 * 不会先长后缩。传入空行集（未运行）时原样返回，并把补位高度归零交给下一轮重算。
 */
function padActivityLines(runtime: ActivityAreaRuntime, lines: string[]): string[] {
	if (lines.length === 0) {
		runtime.paddedRows = 0;
		return lines;
	}

	runtime.paddedRows = Math.max(runtime.paddedRows, lines.length);
	if (runtime.paddedRows === lines.length) {
		return lines;
	}
	return [...lines, ...new Array<string>(runtime.paddedRows - lines.length).fill(PADDING_ROW)];
}

/** 按当前主题与快照渲染活动行；未运行时返回空行集。 */
function renderActivityLines(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): string[] {
	if (!deps.getSnapshot().active) {
		return [];
	}
	return deps.renderLines({
		painter: host.ui.theme,
		frame: runtime.frame,
		maxRows: deps.getMaxRows(),
		animated: deps.isAnimated(),
	});
}

/**
 * 刷新活动区。
 *
 * 行内容与上一 tick 完全一致时直接返回，不触发重绘；行有变化时先把新行写进
 * runtime.lines，再请求重绘（轮首的活动区子组件每次渲染都从这里取行）。
 */
export function refreshActivityArea(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): void {
	runtime.lastHost = host;

	const rendered = renderActivityLines(runtime, host, deps);
	const lines = padActivityLines(runtime, rendered);
	const signature = buildLinesSignature(lines, deps.hasRunHeaderHost());

	if (signature === runtime.linesSignature) {
		return;
	}

	// lines 与 linesSignature 必须成对落盘：前者决定屏幕上画什么，后者决定下一
	// tick 要不要重画。提前 return 之前不留下这两者不一致的窗口。
	runtime.linesSignature = signature;
	runtime.lines = lines;

	if (lines.length === 0) {
		host.requestRender();
		restorePiWorkingIndicator(runtime, host);
		return;
	}

	host.requestRender();

	if (!deps.hasRunHeaderHost()) {
		// 承载者还没出现，活动行画不出来；这时关掉 Pi 的 Working 提示会让屏幕彻底没有
		// 反馈，看起来就是卡住。承载者出现后下一 tick 会因签名变化重新走到下面接管。
		restorePiWorkingIndicator(runtime, host);
		return;
	}

	// 活动区已经在展示当前动作，Pi 内置的 Working 提示就是重复信息。
	safeUiCall(() => host.ui.setWorkingVisible(false));
	runtime.workingSuppressed = true;
}

/** 把 Pi 内置的 Working 提示恢复显示。 */
function restorePiWorkingIndicator(runtime: ActivityAreaRuntime, host: ActivityUiHost): void {
	if (!runtime.workingSuppressed) {
		return;
	}
	safeUiCall(() => host.ui.setWorkingVisible(true));
	runtime.workingSuppressed = false;
}

/** 移除活动行、恢复 Pi 内置提示并停止定时器。 */
export function clearActivityArea(runtime: ActivityAreaRuntime, host: ActivityUiHost): void {
	stopActivityTimer(runtime);
	runtime.linesSignature = undefined;
	runtime.lines = [];
	runtime.paddedRows = 0;
	host.requestRender();
	restorePiWorkingIndicator(runtime, host);
}

/** 启动刷新定时器；已经在跑时直接返回。 */
export function startActivityTimer(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): void {
	if (runtime.timer) {
		return;
	}

	runtime.lastHost = host;
	runtime.frame = 0;
	runtime.paddedRows = 0;
	refreshActivityArea(runtime, host, deps);

	const intervalMs = deps.isAnimated() ? ANIMATED_INTERVAL_MS : STILL_INTERVAL_MS;
	const timer = setInterval(() => {
		const activeHost = runtime.lastHost;
		if (!activeHost || !deps.getSnapshot().active) {
			stopActivityTimer(runtime);
			return;
		}
		runtime.frame += 1;
		refreshActivityArea(runtime, activeHost, deps);
	}, intervalMs);

	// 不让定时器拖住进程退出。
	timer.unref?.();
	runtime.timer = timer;
}

/** 停止刷新定时器。 */
export function stopActivityTimer(runtime: ActivityAreaRuntime): void {
	if (!runtime.timer) {
		return;
	}
	clearInterval(runtime.timer);
	runtime.timer = undefined;
}
