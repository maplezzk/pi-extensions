/**
 * 实时活动区的运行时。
 *
 * 为什么需要这一层签名去重：`ctx.ui.setWidget` 会重绘整屏。参考实现
 * （pi-desktop-transcript）的做法是先把行渲染成字符串比较签名，内容与上一 tick
 * 完全一致时直接返回，不调用 setWidget；同时把动画压到 2.5fps，并让定时器只在
 * 运行期间存在。三者一起才能既表达「正在做什么」又不把整屏刷成噪点。
 */

import type { ActivityPainter, ActivitySnapshot } from "./activity.js";

/** 活动区 widget 的 key。 */
const ACTIVITY_WIDGET_KEY = "pi-clean-mode-activity";
/** 开启动画时的刷新间隔，约 2.5fps。 */
const ANIMATED_INTERVAL_MS = 400;
/** 关闭动画时的刷新间隔，只是为了让耗时数字仍然更新。 */
const STILL_INTERVAL_MS = 1000;
/** 空行集，用于没有内容可显示的组件。 */
const NO_LINES: string[] = [];

/**
 * 活动区 widget 组件：Pi 只要求 render 与 invalidate 两个成员。
 */
export interface ActivityWidgetComponent {
	/** 输出当前活动区行。 */
	render(): string[];
	/** Component 接口要求；活动区不缓存行，所以是空实现。 */
	invalidate(): void;
}

/**
 * 活动区需要的 UI 能力。
 *
 * 刻意比 `ExtensionContext` 窄：这里只用到主题取色、挂载 widget、以及两个内置
 * 提示的显隐开关，窄接口让测试无需伪造整个上下文。
 *
 * `setHiddenThinkingLabel("")` 表示把占位文案清空（活动区已经在展示真实思考头部），
 * 传 `undefined` 则是恢复 Pi 的默认占位文案。
 */
export interface ActivityUiHost {
	ui: {
		/** 主题取色能力，用于生成可比较的签名。 */
		theme: ActivityPainter;
		/**
		 * 挂载或摘掉 widget；undefined 表示摘掉。
		 * content 的最终解释权在 Pi，因此类型保持宽泛，由调用处提供组件工厂。
		 */
		setWidget(key: string, content: unknown): void;
		/** 控制 Pi 内置 Working 提示的显隐。 */
		setWorkingVisible(visible: boolean): void;
		/** 设置 Pi 隐藏思考块的占位文案。 */
		setHiddenThinkingLabel(label?: string): void;
	};
}

/** 活动区运行时持有的可变状态。 */
export interface ActivityAreaRuntime {
	/** 上一次交给 setWidget 的内容签名，用于跳过无变化的重绘。 */
	widgetSignature?: string;
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
	return { frame: 0, workingSuppressed: false };
}

/** 安全调用 ui 上的可选方法；老版本或极简上下文可能不提供。 */
function safeUiCall(action: () => void): void {
	try {
		action();
	} catch {
		// 显示层失败不影响主流程。
	}
}

/**
 * 用当前主题渲染活动区行并拼成签名；无内容时返回空字符串。
 *
 * 签名只用于比较是否需要重绘，因此用扩展上下文里的当前主题即可。
 */
function buildSignature(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): string {
	const snapshot = deps.getSnapshot();
	if (!snapshot.active) {
		return "";
	}
	const lines = deps.renderLines({
		painter: host.ui.theme,
		frame: runtime.frame,
		maxRows: deps.getMaxRows(),
		animated: deps.isAnimated(),
	});
	return lines.join("\n");
}

/** 把渲染好的行挂到 widget 上，使用 Pi 传入的主题与实时动画帧。 */
function mountActivityWidget(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): void {
	host.ui.setWidget(ACTIVITY_WIDGET_KEY, (_tui: unknown, theme: ActivityPainter): ActivityWidgetComponent => ({
		/** 每次重绘都按当时的主题与动画帧重新生成行。 */
		render: () => {
			const snapshot = deps.getSnapshot();
			if (!snapshot.active) {
				return NO_LINES;
			}
			return deps.renderLines({
				painter: theme,
				frame: runtime.frame,
				maxRows: deps.getMaxRows(),
				animated: deps.isAnimated(),
			});
		},
		/** Component 接口要求；行内容实时生成，没有缓存需要清理。 */
		invalidate: () => {},
	}));
}

/**
 * 刷新活动区。
 *
 * 内容签名与上一 tick 相同时完全跳过 setWidget，因为 setWidget 会重绘整屏；
 * 没有内容可显示时把 widget 摘掉，而不是画一个空 widget。
 */
export function refreshActivityArea(
	runtime: ActivityAreaRuntime,
	host: ActivityUiHost,
	deps: ActivityAreaDeps,
): void {
	runtime.lastHost = host;

	const signature = buildSignature(runtime, host, deps);
	if (signature === runtime.widgetSignature) {
		return;
	}
	runtime.widgetSignature = signature;

	if (!signature) {
		safeUiCall(() => host.ui.setWidget(ACTIVITY_WIDGET_KEY, undefined));
		restorePiWorkingIndicator(runtime, host);
		return;
	}

	mountActivityWidget(runtime, host, deps);

	// 活动区已经在展示当前动作，Pi 内置的 Working 提示就是重复信息。
	safeUiCall(() => host.ui.setWorkingVisible(false));
	safeUiCall(() => host.ui.setHiddenThinkingLabel(""));
	runtime.workingSuppressed = true;
}

/** 把 Pi 内置的 Working 提示恢复显示。 */
function restorePiWorkingIndicator(runtime: ActivityAreaRuntime, host: ActivityUiHost): void {
	if (!runtime.workingSuppressed) {
		return;
	}
	safeUiCall(() => host.ui.setWorkingVisible(true));
	safeUiCall(() => host.ui.setHiddenThinkingLabel(undefined));
	runtime.workingSuppressed = false;
}

/** 移除活动区、恢复 Pi 内置提示并停止定时器。 */
export function clearActivityArea(runtime: ActivityAreaRuntime, host: ActivityUiHost): void {
	stopActivityTimer(runtime);
	runtime.widgetSignature = undefined;
	safeUiCall(() => host.ui.setWidget(ACTIVITY_WIDGET_KEY, undefined));
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
