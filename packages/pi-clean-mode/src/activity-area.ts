/**
 * 实时活动区的运行时。
 *
 * 活动行内联在对话里（见 component-patches.ts）：
 * - 活动块接在当前组最后一条可见行的末尾，永远贴在最新状态下面；
 * - 轮首槽位只拿状态行（在处理 + 耗时），顶部只回答「整轮一共跑了多久」。
 * 不用 Pi 的 widget：widget 固定在编辑器上下方，滚历史时它不动，看起来像钉在底部的一条状态。
 *
 * 为什么还要签名去重：活动行每 tick 都会重算，但内容常常没变（例如耗时没走到
 * 下一秒、动画帧循环回同一格）。内容不变时完全跳过重绘，让整屏刷新只发生在真正
 * 有新信息的时候；动画按固定节拍推进，并让定时器只在运行期间存在。
 *
 * 刷新只做三件事：更新 runtime.lines（和它里哪几行是动作名）、再请求重绘。行从哪里渲染
 * 由 component-patches.ts 决定（轮首子组件或当前组头的工具行）；这两个动作都是 ActivityUiHost 的必需成员，刻意不套
 * safeUiCall：它们抛错说明扩展入口的适配层坏了，应当暴露而不是吞掉；safeUiCall
 * 只用于老版本 Pi 可能缺失的可选 UI 方法。
 *
 * 另一个必须先想的点：活动行要等一个能挂它的组件先出现 —— 轮首槽位属于本轮第一条
 * assistant 消息（message_start 才创建），组头则是第一个工具调用。所以从 agent_start
 * 到第一个 token 之间活动行根本画不出来，这段时间必须留着 Pi 自带的 Working 提示，
 * 否则屏幕上什么都没有，看起来就是卡住。
 */

import {
	activityCountersNote,
	appendActivityCountersNote,
	blankActivityRow,
	renderActivityRows,
	withoutActionRows,
	type ActivityLines,
	type ActivityPainter,
	type ActivityRow,
	type ActivitySnapshot,
} from "./activity.js";

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
	 * `getLines` 交给当前组的工具行在渲染末尾接上。
	 */
	lines: string[];
	/**
	 * 同一批行的「去掉动作名」形态：组内只有一条时，组头已经写出这条动作。
	 *
	 * 与 `lines` 分开存：树形前缀要按最终留下的行重拼，去掉动作行之后原本的第二项
	 * 才是最后一项，不能直接拿 `lines` 筛一遍字符串。
	 */
	detailLines: string[];
	/**
	 * `lines` 与 `detailLines` 的结构化来源（已补位）。
	 *
	 * 树形前缀的收口依赖「后面还有没有别的子项」，所以渲染推迟到这里：去掉动作行之后
	 * 重拼一遍，分支符才会从 `├─` 换成 `└─`。
	 */
	rows: ActivityRow[];
	/**
	 * `lines` 里属于动作名的行号。
	 *
	 * 组头已经写出这条动作时（单条组），渲染层要把这几行去掉，只留思考与输出尾巴；
	 * 补位空行只会追加在末尾，所以行号补齐后依然有效。
	 */
	actionRows: number[];
	/**
	 * 轮首槽位要展示的状态行（最多一行：在处理 + 耗时）；空数组表示不展示。
	 *
	 * 与 `lines` 分开存放：轮首只报运行级时间，思考与工具细节只在当前组头上出现。
	 */
	runStatusLines: string[];
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
	/** 用给定主题渲染活动块（含哪几行是动作名）。 */
	renderLines: (input: ActivityLinesInput) => ActivityLines;
	/** 用给定主题渲染轮首状态行（只含在处理与耗时）。 */
	renderRunStatusLines: (input: ActivityLinesInput) => string[];
	/**
	 * 本轮是否已经有能承载活动行的轮首组件。
	 *
	 * 轮首槽位属于本轮第一条 assistant 消息，它要等 message_start 才存在。在那之前
	 * 活动行画不出来（组头也还没有），Pi 自带的 Working 提示就得继续顶着，
	 * 否则从 agent_start 到第一个 token 之间屏幕上没有任何反馈。
	 */
	hasRunHeaderHost: () => boolean;
	/** 轮首的那条状态行（`处理中 · Ns`）是否真的会被画出来，由 `showRunHeader` 决定。 */
	isRunHeaderShown: () => boolean;
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
	return {
		actionRows: [],
		detailLines: [],
		frame: 0,
		workingSuppressed: false,
		lines: [],
		rows: [],
		runStatusLines: [],
		paddedRows: 0,
	};
}

/** 安全调用 ui 上的可选方法；老版本或极简上下文可能不提供。 */
function safeUiCall(action: () => void): void {
	try {
		action();
	} catch {
		// 显示层失败不影响主流程。
	}
}

/** 去重签名里的「承载者已就绪」标记。 */
const SIGNATURE_HOST_READY = "host:ready";
/** 去重签名里的「承载者还没出现」标记。 */
const SIGNATURE_HOST_MISSING = "host:missing";
/** 去重签名里分隔活动块与轮首状态行的标记，避免两块内容拼串后互相误命中。 */
const SIGNATURE_RUN_STATUS = "run-status:";
/** 去重签名里分隔活动块行与其细节形态的标记。 */
const SIGNATURE_DETAIL_LINES = "detail-lines:";
/** 去重签名里分隔活动块行与动作行号的标记。 */
const SIGNATURE_ACTION_ROWS = "action-rows:";

/** 去重签名要覆盖的四块内容：活动块行、细节形态、动作行号、轮首状态行。 */
interface LinesSignatureInput {
	/** 活动块行（已补位）。 */
	lines: string[];
	/** 活动块的「去掉动作名」形态（已补位）。 */
	detailLines: string[];
	/** 活动块里属于动作名的行号。 */
	actionRows: number[];
	/** 轮首状态行。 */
	runStatusLines: string[];
	/** 本轮是否已经有能承载活动行的轮首组件。 */
	hostReady: boolean;
}

/**
 * 组装去重签名：两形态的行 + 动作行号 + 承载者是否就绪。
 *
 * 承载者就绪与否必须参与签名：内容一个字都没变但承载者刚从无到有时，也要让签名
 * 变化一次，下一个 tick 才能重新接管并关掉 Pi 的内置提示；否则会被去重挡住。
 * 轮首状态行也要参与：它只在回落条件下渲染，块内容不变时它可能刚被清空或刚出现。
 * 动作行号同样要参与：行内容一字未变但「哪行是动作名」变了（并行转单条），渲染层要换一种拼法。
 * 细节形态也要参与：它是另一串最终文本，两串都得存下来才能跳过重复渲染。
 */
function buildLinesSignature({ lines, detailLines, actionRows, runStatusLines, hostReady }: LinesSignatureInput): string {
	return [
		hostReady ? SIGNATURE_HOST_READY : SIGNATURE_HOST_MISSING,
		...lines,
		SIGNATURE_DETAIL_LINES,
		...detailLines,
		SIGNATURE_ACTION_ROWS,
		actionRows.join(","),
		SIGNATURE_RUN_STATUS,
		...runStatusLines,
	].join("\n");
}

/**
 * 把结构化活动行补齐到本轮见过的最大行数。
 *
 * 行数来回变化会让对话内容高度抖动，底部锚定被反复拉动；补齐后运行期间只会「长高」，
 * 不会先长后缩。传入空行集（未运行）时原样返回，并把补位高度归零交给下一轮重算。
 */
function padActivityRows(runtime: ActivityAreaRuntime, rows: ActivityRow[]): ActivityRow[] {
	if (rows.length === 0) {
		runtime.paddedRows = 0;
		return rows;
	}

	runtime.paddedRows = Math.max(runtime.paddedRows, rows.length);
	if (runtime.paddedRows === rows.length) {
		return rows;
	}
	return [
		...rows,
		...Array.from({ length: runtime.paddedRows - rows.length }, () => blankActivityRow()),
	];
}

/** 组装一次渲染的输入：同一个 tick 里两块内容共用同一帧、主题与行数预算。 */
function buildRenderInput(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): ActivityLinesInput {
	return {
		painter: host.ui.theme,
		frame: runtime.frame,
		maxRows: deps.getMaxRows(),
		animated: deps.isAnimated(),
	};
}

/** 按当前主题与快照渲染活动块的结构化行；未运行时返回空块。 */
function renderActivityLines(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): ActivityLines {
	if (!deps.getSnapshot().active) {
		return { rows: [], actionRows: [] };
	}
	return deps.renderLines(buildRenderInput(runtime, host, deps));
}

/**
 * 渲染轮首状态行；未运行时返回空行集。
 *
 * 不走 padActivityLines：轮首固定就是一行，补位只会往顶部铺空行。
 */
function renderRunStatusLines(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): string[] {
	if (!deps.getSnapshot().active) {
		return [];
	}
	return deps.renderRunStatusLines(buildRenderInput(runtime, host, deps));
}

/**
 * 刷新活动区。
 *
 * 两块内容都渲染：当前组头用的活动块，以及轮首槽位用的状态行。活动块补位后拼出两
 * 形态（完整、去掉动作名），树形前缀在去掉动作行之后重新算，收口才不会错。行内容与
 * 上一 tick 完全一致时直接返回，不触发重绘；有变化时先把新行写进 runtime，再请求重绘
 * （两处渲染时都从 runtime 取行）。
 */
export function refreshActivityArea(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): void {
	runtime.lastHost = host;

	const rendered = renderActivityLines(runtime, host, deps);
	const rows = padActivityRows(runtime, rendered.rows);
	// 尾注接在已渲染的行上：它不占行数预算，单条组把动作行去掉之后也还在。
	// 两种形态各拼一次，而不是先拼好再筛 —— 两者的最后一行本来就不是同一行。
	const note = activityCountersNote(deps.getSnapshot().counters);
	const lines = appendActivityCountersNote(rows, renderActivityRows(rows, host.ui.theme), note);
	// 单条组的组头已经写出这条动作，动作名从细节形态里去掉；去掉之后重拼前缀，
	// 原本的第二项才成为最后一项。
	const detailRows = withoutActionRows({ rows, actionRows: rendered.actionRows });
	const detailLines = appendActivityCountersNote(
		detailRows,
		renderActivityRows(detailRows, host.ui.theme),
		note,
	);
	const runStatusLines = renderRunStatusLines(runtime, host, deps);
	const signature = buildLinesSignature({
		lines,
		detailLines,
		actionRows: rendered.actionRows,
		runStatusLines,
		hostReady: deps.hasRunHeaderHost(),
	});

	if (signature === runtime.linesSignature) {
		return;
	}

	// 行、细节形态、动作行号与 linesSignature 必须成对落盘：前者决定屏幕上画什么，
	// 后者决定下一 tick 要不要重画。提前 return 之前不留下它们不一致的窗口。
	runtime.linesSignature = signature;
	runtime.rows = rows;
	runtime.lines = lines;
	runtime.detailLines = detailLines;
	runtime.actionRows = rendered.actionRows;
	runtime.runStatusLines = runStatusLines;

	host.requestRender();

	// 只要本轮还有 clean-mode 自己的反馈（活动块有行，或轮首那条「处理中 · Ns」会画出来），
	// Pi 内置的 Working 提示就是重复信息。判断只看「本轮有没有承载者」，**不再看这一帧
	// 有没有活动行**：工具刚跑完、下一条还没开始的空档里活动块会短暂为空，按帧判断会让
	// 底部那行「⏱ Ns」随着每条命令一闪一闪。一次运行只接管一次，接管到本轮结束为止
	// （clearActivityArea 在运行结束时把提示让回去）。
	const ownsFeedback =
		deps.getSnapshot().active &&
		deps.hasRunHeaderHost() &&
		(lines.length > 0 || deps.isRunHeaderShown());

	if (!ownsFeedback) {
		// 承载者还没出现，或轮首不画状态行且这一帧没有活动行：Pi 的提示是屏幕上唯一的
		// 反馈，这时关掉它看起来就是卡住。
		restorePiWorkingIndicator(runtime, host);
		return;
	}

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
	runtime.detailLines = [];
	runtime.rows = [];
	runtime.actionRows = [];
	runtime.runStatusLines = [];
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
