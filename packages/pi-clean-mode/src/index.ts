/**
 * 清爽模式扩展入口。
 *
 * 目标：把一轮对话的工作过程（工具调用 + 中间解说）折叠起来，只留最终答案，
 * 需要时再展开。折叠单位是「一次 agent 运行」（agent_start → agent_settled）。
 *
 * 实现要点：
 * - 运行中自动展开，运行结束自动收起，避免流式期间用户看不到任何内容；
 * - 用户手动切换过之后，本次运行不再自动收起；
 * - TUI 句柄在 session_start 通过一个空 widget 工厂取得，render 补丁保持纯函数。
 */

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	AssistantMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	installNoticeRenderer,
	notifyWithSource,
	type NoticeColor,
} from "pi-extensions-i18n";
import { loadConfig, saveConfig } from "./config-store.js";
import { parseToggleValue, withBooleanConfigField } from "./config-fields.js";
import { openConfigPanel } from "./config-panel.js";
import { debugLog, debugLogPath } from "./debug-logger.js";
import {
	activityClassLabel,
	buildActivityLines,
	buildRunStatusLines,
	classifyToolActivity,
	createActivitySnapshot,
	dominantActivityClass,
	extractOutputTail,
	extractThoughtHead,
	toolActivityDetail,
	toolActivityLabel,
	type ActivityCounters,
	type ActivitySnapshot,
} from "./activity.js";
import {
	clearActivityArea,
	createActivityAreaRuntime,
	startActivityTimer,
	type ActivityAreaDeps,
	type ActivityAreaRuntime,
	type ActivityUiHost,
} from "./activity-area.js";
import { installComponentPatches, type ToolRowGroupInfo } from "./component-patches.js";
import { installExtensionEntryPatch, resolveContainerPrototypes } from "./extension-entry-patch.js";
import { createHeaderStyler, type HeaderStyler, type ThemePainter } from "./header-style.js";
import {
	areAllActionGroupsExpanded,
	beginActionGroupStep,
	createActionGroupState,
	findActionGroupMembership,
	getActionGroupActivityCounts,
	getActionGroupSize,
	hasNarrationText,
	isActionGroupExpanded,
	isAssistantMessage,
	registerActionToolCall,
	setAllActionGroupsExpanded,
	toggleActionGroup,
	type ActionGroupState,
} from "./action-groups.js";
import {
	applyStreamedMessage,
	beginStreamedMessage,
	createStreamRegistration,
	type StreamRegistration,
	type StreamedToolCall,
} from "./stream-registration.js";
import { i18n } from "./i18n.js";
import { NOTICE_SOURCE } from "./source-tag.js";
import {
	applyCollapsed,
	createInitialState,
	restoreHistory,
	settleRun,
	startRun,
} from "./run-state.js";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type CleanModeState } from "./types.js";

/** 折叠/展开快捷键；f2 未被 Pi 内置键位占用。 */
const TOGGLE_SHORTCUT = "f2";
/**
 * 调试日志里的缺失字段占位符，与 component-patches.ts 的 `DEBUG_UNKNOWN` 同一约定。
 *
 * `session_start` 的 reason 在旧版本 Pi 上可能不存在，日志里要能看出「没这个字段」
 * 而不是打出 `undefined`。
 */
const DEBUG_UNKNOWN_REASON = "unknown";
/** 批量展开/收起全部动作组的快捷键。 */
const TOGGLE_GROUPS_SHORTCUT = "shift+f2";
/** 用于取得 TUI 句柄的空 widget key；该 widget 不渲染任何内容。 */
const PROBE_WIDGET_KEY = "pi-clean-mode-probe";
/** 切换折叠状态的命令名。 */
const TOGGLE_COMMAND = "clean";
/** 查看与修改配置的命令名。 */
const CONFIG_COMMAND = "config:clean-mode";
/** 一轮开始时本轮工具调用计数的初值。 */
const INITIAL_RUN_TOOL_COUNT = 0;
/** 空渲染结果；探针组件用它表示「不占任何行」。 */
const NO_LINES: string[] = [];
/** 配置命令里 `key=value` 的最大切分段数。 */
const ASSIGNMENT_PART_LIMIT = 2;
/** `/clean` 后面跟这个参数时打开配置面板，而不是切换折叠。 */
const CONFIG_PANEL_ARG = "config";

/** 不渲染任何内容的组件，用于挂载探针并取得 TUI 句柄。 */
const NO_CONTENT_COMPONENT: Component = {
	/** 永远返回空行集，不占用任何屏幕行。 */
	render: () => NO_LINES,
	/** 无缓存状态，无需清理。 */
	invalidate: () => {},
};
/**
/**
 * 主题还没拿到时的占位画笔。
 *
 * 只做排版，不上色也不加粗；session_start 拿到主题后换成真的着色器。
 */
const PLAIN_PAINTER: ThemePainter = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** 本扩展的运行期状态。 */
interface Runtime {
	state: CleanModeState;
	config: CleanModeConfig;
	/** 当前一次运行的开始时间戳（毫秒）。 */
	runStartedAtMs?: number;
	/** 取得 TUI 句柄后用于触发重绘。 */
	tui?: TUI;
	/** 折叠头着色器：横条、标签与强调色都从它取。 */
	styler: HeaderStyler;
	/** 动作组状态：一个 turn 一个组，用于把多条工具调用收成一行组头。 */
	actionGroups: ActionGroupState;
	/** 安装补丁后的还原函数。 */
	restorePatches?: () => void;
	/** 实时活动区的快照。 */
	activity: ActivitySnapshot;
	/** 实时活动区的运行时（定时器与签名缓存）。 */
	activityArea: ActivityAreaRuntime;
	/** 活动区 UI 宿主；session_start 里构造一次，事件回调与定时器复用同一个对象。 */
	activityHost?: ActivityUiHost;
	/** 本轮登记过的工具调用数，运行结束写进折叠头。 */
	runToolCount: number;
	/** 每轮耗时账本，把耗时绑定到具体的最终答案消息上。 */
	runDurations: RunDurationLedger;
	/**
	 * 会话恢复窗口：session_start 之后、首次 agent_start 之前为真。
	 *
	 * 历史条目与历史消息一样不会重放事件，所以这个窗口里的扩展条目也要当成
	 * 上一轮的工作过程收起，否则 `/resume` 之后审计行会一条条铺在折叠好的对话里。
	 */
	historyRestoreWindow: boolean;
	/**
	 * 流式消息里的动作组登记状态机。
	 *
	 * 组边界与工具调用登记都要赶在那一行工具行被渲染之前完成，所以状态与顺序由
	 * `stream-registration.ts` 统一持有，事件回调只负责把消息喂进去。
	 */
	streamRegistration: StreamRegistration;
}

/**
 * 每轮耗时账本。
 *
 * 耗时与动作步数按「折叠头承载者组件」存，因此历史轮次的折叠头不会跟着最新一轮变化；
 * 承载者是每轮第一条 assistant 消息，保证折叠头永远在整轮最前面。
 */
interface RunDurationLedger {
	/** 开始新一轮：重开归属认领。 */
	beginRun(): void;
	/** 认领本轮折叠头归属；本轮已被认领时返回 false。 */
	claimOwner(host: object): boolean;
	/** 本轮是否已经有承载折叠头的组件；没有则活动行还画不出来。 */
	hasRunHeaderHost(): boolean;
	/** 该承载者是否就是当前这一轮的承载者。 */
	isOwner(host: object): boolean;
	/**
	 * 把本轮结果绑定到当前承载者上；耗时未知或还没人认领时不做任何事。
	 *
	 * `steps` 是本轮登记过的工具调用数，由调用方统计（含被其它扩展拦下的调用）。
	 */
	bindRun(durationMs: number | undefined, steps: number): void;
	/** 查询某个承载者所属那一轮的耗时。 */
	getDuration(host: object): number | undefined;
	/** 查询某个承载者所属那一轮的工具调用数。 */
	getSteps(host: object): number | undefined;
}

/** 一轮结束后记在承载者上的结果。 */
interface RunSummary {
	/** 本轮耗时（毫秒）。 */
	durationMs: number;
	/** 本轮登记过的工具调用数（含被其它扩展拦下的，它们也会发 tool_execution_start）。 */
	steps: number;
}

/** 创建耗时账本。 */
function createRunDurationLedger(): RunDurationLedger {
	const summaries = new WeakMap<object, RunSummary>();
	let owner: object | undefined;
	let claimed = false;

	return {
		/** 重开归属认领，让下一条 assistant 消息成为本轮承载者。 */
		beginRun: () => {
			owner = undefined;
			claimed = false;
		},
		/** 本轮第一个来认领的实例得到 true，其余得到 false。 */
		claimOwner: (host) => {
			if (claimed) {
				return false;
			}
			claimed = true;
			owner = host;
			return true;
		},
		/** 当前轮的承载者才返回 true；用于让轮首活动区只在当前轮出现。 */
		isOwner: (host) => claimed && owner === host,
		/** 本轮是否已经有组件承载折叠头（owner 非空）；为假时活动行还画不出来。 */
		hasRunHeaderHost: () => owner !== undefined,
		/** 耗时未知或尚无承载者时直接跳过。 */
		bindRun: (durationMs, steps) => {
			if (durationMs === undefined || !owner) {
				return;
			}
			summaries.set(owner, { durationMs, steps });
		},
		/** 未登记过的承载者返回 undefined，调用方据此不显示折叠头。 */
		getDuration: (host) => summaries.get(host)?.durationMs,
		/** 同上：没有记录就不显示步数。 */
		getSteps: (host) => summaries.get(host)?.steps,
	};
}

/** 创建初始运行期状态。 */
function createRuntime(): Runtime {
	return {
		state: createInitialState(),
		config: { ...DEFAULT_CLEAN_MODE_CONFIG },
		styler: createHeaderStyler(PLAIN_PAINTER),
		actionGroups: createActionGroupState(),
		activity: createActivitySnapshot(),
		activityArea: createActivityAreaRuntime(),
		runToolCount: INITIAL_RUN_TOOL_COUNT,
		runDurations: createRunDurationLedger(),
		historyRestoreWindow: false,
		streamRegistration: createStreamRegistration(),
	};
}

/** 活动区当前是否应当工作：总开关与活动区开关都打开才启用。 */
function isActivityEnabled(runtime: Runtime): boolean {
	return runtime.config.enabled && runtime.config.showActivityArea;
}

/** 累加一个分类计数，返回新的计数值。 */
function bumpCounter(counters: ActivityCounters, bucket: keyof ActivityCounters): ActivityCounters {
	return { ...counters, [bucket]: counters[bucket] + 1 };
}

/** 把刚启动的工具登记进正在执行列表。 */
function noteToolStarted(
	runtime: Runtime,
	event: { toolCallId: string; toolName: string; args: unknown },
): void {
	const action = {
		toolCallId: event.toolCallId,
		label: toolActivityLabel(event.toolName),
		detail: toolActivityDetail(event.toolName, event.args),
	};
	runtime.activity.running = [
		...runtime.activity.running.filter((item) => item.toolCallId !== event.toolCallId),
		action,
	];
}

/** 记录正在执行工具的最新输出尾巴。 */
function noteToolOutput(runtime: Runtime, toolCallId: string, result: unknown): void {
	const tail = extractOutputTail(result);
	if (!tail) {
		return;
	}
	runtime.activity.running = runtime.activity.running.map((item) =>
		item.toolCallId === toolCallId ? { ...item, outputTail: tail } : item,
	);
}

/** 一个工具结束：移出正在执行列表并累加分类计数。 */
function noteToolFinished(
	runtime: Runtime,
	event: { toolCallId: string; toolName: string },
): void {
	runtime.activity.running = runtime.activity.running.filter(
		(item) => item.toolCallId !== event.toolCallId,
	);
	runtime.activity.counters = bumpCounter(
		runtime.activity.counters,
		classifyToolActivity(event.toolName),
	);
}

/** 组装活动区渲染依赖；行数、动画与行内容都从当前配置与快照读取。 */
function createActivityDeps(runtime: Runtime): ActivityAreaDeps {
	return {
		getSnapshot: () => runtime.activity,
		isAnimated: () => runtime.config.animateActivity,
		getMaxRows: () => runtime.config.activityRows,
		hasRunHeaderHost: () => runtime.runDurations.hasRunHeaderHost(),
		isRunHeaderShown: () => runtime.config.showRunHeader,
		renderLines: (input) => {
			const { painter, frame, maxRows, animated } = input;
			return buildActivityLines({
				snapshot: runtime.activity,
				nowMs: Date.now(),
				frame,
				animated,
				maxRows,
				paint: painter,
			});
		},
		renderRunStatusLines: (input) => {
			const { painter, frame, maxRows, animated } = input;
			return buildRunStatusLines({
				snapshot: runtime.activity,
				nowMs: Date.now(),
				frame,
				animated,
				maxRows,
				paint: painter,
			});
		},
	};
}

/**
 * 把扩展上下文适配成活动区需要的窄接口。
 *
 * 活动行内联在 transcript 末尾，不再走 widget：requestRender 把新行真的画出来，
 * attachTranscript 保证补丁已挂上（transcript 容器可能晚于扩展加载才出现）。
 * 整个会话只构造一次，存进 runtime 供事件回调与定时器共用。
 */
function createActivityHost(runtime: Runtime, ctx: ExtensionContext): ActivityUiHost {
	return {
		ui: {
			theme: ctx.ui.theme,
			setWorkingVisible: (visible) => ctx.ui.setWorkingVisible(visible),
		},
		requestRender: () => requestRender(runtime),
	};
}

/**
 * 取活动区宿主。
 *
 * 活动事件只会在 session_start 之后触发，所以正常路径上一定已经构造过；真缺失
 * 说明事件顺序变了，直接报错而不是静默不显示。
 */
function requireActivityHost(runtime: Runtime): ActivityUiHost {
	const host = runtime.activityHost;
	if (!host) {
		throw new Error("pi-clean-mode: activity host used before session_start");
	}
	return host;
}

/**
 * 把一次工具调用压成一行摘要，例如「运行命令 ls -la」。
 *
 * 参数里没有可读字段时只留动作标签，避免把工具名重复说一遍
 * （toolActivityDetail 找不到已知字段时会退回工具名）。
 */
function summarizeToolCall(toolName: string, args: unknown): string {
	const label = toolActivityLabel(toolName);
	const detail = toolActivityDetail(toolName, args);
	return detail && detail !== toolName ? `${label} ${detail}` : label;
}

/** 一次工具调用的登记输入；两个事件用不同字段名传参数，所以调用方先归一化。 */
interface ToolActionInput {
	/** 工具调用 id。 */
	toolCallId: string;
	/** 工具名。 */
	toolName: string;
	/** 工具参数。 */
	args: unknown;
}

/**
 * 把一个工具调用登记进当前动作组，并计入本轮步数。
 *
 * `tool_call` 与 `tool_execution_start` 都会调它，靠现有归属判重，所以同一次调用
 * 只会让步数加一；被其它扩展拦下的调用拿不到 tool_call，但拿得到
 * tool_execution_start，同样会被计入。
 */
function registerToolAction(runtime: Runtime, action: ToolActionInput): void {
	if (findActionGroupMembership(runtime.actionGroups, action.toolCallId)) {
		return;
	}
	registerActionToolCall(runtime.actionGroups, {
		toolCallId: action.toolCallId,
		summary: summarizeToolCall(action.toolName, action.args),
		activity: classifyToolActivity(action.toolName),
	});
	runtime.runToolCount += 1;
}

/** 把一次流式消息喂给登记状态机，并累加本轮步数。 */
function feedStreamedMessage(runtime: Runtime, message: unknown): void {
	const outcome = applyStreamedMessage({
		state: runtime.streamRegistration,
		message,
		actionGroups: runtime.actionGroups,
		describe: describeStreamedToolCall,
	});
	if (outcome.registered.length > 0) {
		runtime.runToolCount += outcome.registered.length;
		debugLog(
			"stream register",
			`group=${runtime.actionGroups.currentGroupId} ${outcome.registered.map((call) => call.toolCallId).join(",")}`,
		);
	}
	if (outcome.stepped) {
		debugLog("narration", `new group=${runtime.actionGroups.currentGroupId}`);
	}
}

/** 把一次工具调用翻译成动作组登记所需的摘要与分类。 */
function describeStreamedToolCall(call: StreamedToolCall): {
	summary?: string;
	activity: keyof ActivityCounters;
} {
	return {
		summary: hasToolArguments(call.args) ? summarizeToolCall(call.toolName, call.args) : undefined,
		activity: classifyToolActivity(call.toolName),
	};
}

/**
 * 参数是不是已经能读出内容。
 *
 * 流式内容块里的 `arguments` 是分片拼出来的，块刚出现时还是空对象。空对象只能读出
 * 「运行命令」这样的标签，把标签当摘要写进去就再也不会被补全了 —— 那时宁可不写，
 * 等参数到齐后由 `fillActionToolCallSummary` 补上（真正无参数的工具由后续事件
 * 登记时补上标签本身）。
 */
function hasToolArguments(args: unknown): boolean {
	return typeof args === "object" && args !== null && Object.keys(args).length > 0;
}

/**
 * 取某个动作组的组头主词（如「运行命令」）。
 *
 * 组内有一类动作过半就用它命名，混在一起说不清时返回 undefined，由渲染层退回
 * 通用词「探索 · N 步」。
 */
function lookupGroupActivityLabel(runtime: Runtime, groupId: number): string | undefined {
	const dominant = dominantActivityClass(getActionGroupActivityCounts(runtime.actionGroups, groupId));
	return dominant === undefined ? undefined : activityClassLabel(dominant);
}

/** 取一个工具行的动作组快照，供渲染决策使用。 */
function lookupToolRowGroup(runtime: Runtime, toolCallId: string): ToolRowGroupInfo | undefined {
	const membership = findActionGroupMembership(runtime.actionGroups, toolCallId);
	if (!membership) {
		return undefined;
	}

	return {
		membership,
		groupSize: getActionGroupSize(runtime.actionGroups, membership.groupId),
		groupExpanded: isActionGroupExpanded(runtime.actionGroups, membership.groupId),
		...(membership.summary === undefined ? {} : { summary: membership.summary }),
	};
}

/** 请求重绘；TUI 句柄尚未取得时静默跳过。 */
function requestRender(runtime: Runtime): void {
	runtime.tui?.requestRender();
}

/** 安装渲染补丁；重复调用是幂等的。 */
function installPatches(runtime: Runtime): void {
	runtime.restorePatches?.();
	const restoreComponentPatches = installComponentPatches({
		getState: () => runtime.state,
		getConfig: () => runtime.config,
		styler: runtime.styler,
		onToggle: () => {
			toggleRuntime(runtime);
		},
		getToolRowGroup: (toolCallId) => lookupToolRowGroup(runtime, toolCallId),
		onToggleActionGroup: (groupId) => {
			toggleActionGroup(runtime.actionGroups, groupId);
			requestRender(runtime);
		},
		requestRender: () => requestRender(runtime),
		claimRunHeaderHost: (host) => runtime.runDurations.claimOwner(host),
		isCurrentRunHost: (host) => runtime.runDurations.isOwner(host),
		getActivityLines: () => runtime.activityArea.lines,
		getActivityDetailLines: () => runtime.activityArea.detailLines,
		getRunStatusLines: () => runtime.activityArea.runStatusLines,
		isCurrentActionGroup: (groupId) => groupId === runtime.actionGroups.currentGroupId,
		getGroupActivityLabel: (groupId) => lookupGroupActivityLabel(runtime, groupId),
		getRunDuration: (host) => runtime.runDurations.getDuration(host),
		getRunSteps: (host) => runtime.runDurations.getSteps(host),
	});
	const restoreExtensionEntryPatch = installExtensionEntryPatch({
		getState: () => runtime.state,
		getConfig: () => runtime.config,
		isHistoryRestoreWindow: () => runtime.historyRestoreWindow,
		// pi-tui 可能被装成两份，条目组件继承的那份从 Pi 导出的组件往上取。
		containerPrototypes: resolveContainerPrototypes({
			ownContainerPrototype: Container.prototype,
			piComponentPrototype: AssistantMessageComponent.prototype,
		}),
	});

	runtime.restorePatches = () => {
		restoreExtensionEntryPatch();
		restoreComponentPatches();
	};
}

/**
 * 切换折叠状态并触发重绘，返回切换后的状态。
 *
 * 快捷键、命令与鼠标点击折叠头都走这里；提示文案由各入口自行决定，
 * 鼠标点击靠画面变化即时反馈，不再重复弹提示。
 */
function toggleRuntime(runtime: Runtime): boolean {
	const next = !runtime.state.collapsed;
	runtime.state = applyCollapsed(runtime.state, next, true);
	requestRender(runtime);
	return next;
}

/** 切换折叠状态并提示用户。 */
function toggleCollapsed(runtime: Runtime, ctx: ExtensionContext | ExtensionCommandContext): void {
	const next = toggleRuntime(runtime);

	notifyWithSource({
		ctx,
		source: NOTICE_SOURCE,
		level: "info",
		message: i18n.t(next ? "collapsedNotice" : "expandedNotice", { key: TOGGLE_SHORTCUT }),
	});
}

/**
 * 尝试把 `key=value` 写入配置：校验字段、写入并让配置立即生效。
 *
 * 返回 false 表示参数不是可识别的配置赋值，由调用方改走其它入口（打开配置面板）。
 */
function applyConfigAssignment(
	runtime: Runtime,
	args: string,
	ctx: ExtensionCommandContext,
): boolean {
	const assignment = args.trim();
	if (!assignment.includes("=")) {
		return false;
	}

	const parts = assignment.split("=", ASSIGNMENT_PART_LIMIT);
	const value = parseToggleValue(parts[1] ?? "");
	const nextConfig =
		value === undefined
			? undefined
			: withBooleanConfigField(runtime.config, (parts[0] ?? "").trim(), value);

	if (!nextConfig) {
		return false;
	}

	applyLiveConfig(runtime, nextConfig, ctx, { announceSaved: true });
	return true;
}

/** 批量展开或收起全部动作组，并按当前状态提示用户。 */
function toggleAllActionGroups(
	runtime: Runtime,
	ctx: ExtensionContext | ExtensionCommandContext,
): void {
	const expand = !areAllActionGroupsExpanded(runtime.actionGroups);
	setAllActionGroupsExpanded(runtime.actionGroups, expand);
	requestRender(runtime);

	notifyWithSource({
		ctx,
		source: NOTICE_SOURCE,
		level: "info",
		message: i18n.t(expand ? "groupsExpandedNotice" : "groupsCollapsedNotice", {
			key: TOGGLE_GROUPS_SHORTCUT,
		}),
	});
}

/** 写入配置时的附加选项。 */
interface ApplyConfigOptions {
	/** 存盘成功后是否提示；面板里逐项切换不提示，避免刷屏。 */
	announceSaved?: boolean;
}

/**
 * 写入一项新配置并让它立即生效：存盘、重装补丁、重绘。
 *
 * 存盘失败也要先把新配置用在本次会话里，用户不至于改了没反应；失败只提示不静默。
 */
function applyLiveConfig(
	runtime: Runtime,
	config: CleanModeConfig,
	ctx: ExtensionCommandContext,
	options: ApplyConfigOptions = {},
): void {
	runtime.config = config;
	const result = saveConfig(config);
	installPatches(runtime);
	requestRender(runtime);

	if (!result.success) {
		notifyWithSource({
			ctx,
			source: NOTICE_SOURCE,
			level: "error",
			message: i18n.t("configSaveFailed", { error: result.error ?? "" }),
		});
		return;
	}

	if (options.announceSaved) {
		notifyWithSource({
			ctx,
			source: NOTICE_SOURCE,
			level: "info",
			message: i18n.t("configSaved"),
		});
	}
}

/** 打开配置面板；改动即时写入并生效。 */
function openCleanModeConfigPanel(runtime: Runtime, ctx: ExtensionCommandContext): Promise<void> {
	return openConfigPanel(ctx, {
		getConfig: () => runtime.config,
		onChange: (config) => applyLiveConfig(runtime, config, ctx),
	});
}

/** 处理 `/config:clean-mode key=on|off`；没有合法赋值时打开配置面板。 */
function handleConfigCommand(
	runtime: Runtime,
	args: string,
	ctx: ExtensionCommandContext,
): void | Promise<void> {
	if (applyConfigAssignment(runtime, args, ctx)) {
		return;
	}

	return openCleanModeConfigPanel(runtime, ctx);
}

/** `/clean` 的入口：`/clean config` 打开配置面板，其余情况切换折叠状态。 */
function handleToggleCommand(
	runtime: Runtime,
	args: string,
	ctx: ExtensionCommandContext,
): void | Promise<void> {
	if (args.trim() === CONFIG_PANEL_ARG) {
		return openCleanModeConfigPanel(runtime, ctx);
	}

	toggleCollapsed(runtime, ctx);
}

/** 扩展工厂：注册事件、快捷键与命令。 */
export default function registerCleanMode(pi: ExtensionAPI): void {
	const runtime = createRuntime();
	installNoticeRenderer(pi);

	pi.on("session_start", async (event, ctx) => {
		const loaded = loadConfig();
		runtime.config = loaded.config;
		runtime.styler = createHeaderStyler(ctx.ui.theme);

		// 历史消息不会重放 agent_start / agent_settled，不主动处理就会整段原样展开。
		runtime.state = restoreHistory({ state: runtime.state, config: runtime.config });
		// 历史扩展条目同样不会重放事件，开一个恢复窗口直到本轮真正开始运行。
		runtime.historyRestoreWindow = true;

		// 通过一个不渲染内容的 widget 工厂取得 TUI 句柄，用于后续触发重绘。
		ctx.ui.setWidget(PROBE_WIDGET_KEY, (tui: TUI): Component => {
			runtime.tui = tui;
			return NO_CONTENT_COMPONENT;
		});

		// 宿主在这里装配一次，之后事件回调只做取值与复用。
		runtime.activityHost = createActivityHost(runtime, ctx);

		installPatches(runtime);
		requestRender(runtime);
		debugLog(
			"session_start",
			`reason=${event.reason ?? DEBUG_UNKNOWN_REASON} debug file=${debugLogPath()} actionGroups=${runtime.config.enableActionGroups} collapsed=${runtime.state.collapsed}`,
		);

		if (loaded.diagnostic) {
			notifyWithSource({
				ctx,
				source: NOTICE_SOURCE,
				level: "warning",
				message: i18n.t("loadFailed", { error: loaded.diagnostic }),
			});
		}
	});

	// 一次运行开始：重置折叠状态、开始计时、并开一个动作组。
	pi.on("agent_start", async (_event, ctx) => {
		runtime.runStartedAtMs = Date.now();
		runtime.runToolCount = INITIAL_RUN_TOOL_COUNT;
		runtime.state = startRun({ state: runtime.state, config: runtime.config });
		runtime.historyRestoreWindow = false;
		beginActionGroupStep(runtime.actionGroups);
		runtime.runDurations.beginRun();
		runtime.streamRegistration = createStreamRegistration();

		runtime.activity = { ...createActivitySnapshot(), active: true, startedAtMs: runtime.runStartedAtMs };
		if (isActivityEnabled(runtime)) {
			startActivityTimer(
				runtime.activityArea,
				requireActivityHost(runtime),
				createActivityDeps(runtime),
			);
		}

		requestRender(runtime);
	});

	// 工具开始执行：登记到活动区，让用户看到「现在在做什么」。
	//
	// 这里必须同时登记动作组：`tool_call` 会被先注册的扩展截断——pi-safety-guards
	// 拦下命令时 runner 立刻停止分发，后面的扩展就收不到那次调用，那一行会掉出分组
	// 而以原始形式显示。tool_execution_start 在每次调用前都会发出（被拦下的也发），
	// 登记又是幂等的，所以两处都登记。
	pi.on("tool_execution_start", async (event, ctx) => {
		registerToolAction(runtime, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});
		if (!isActivityEnabled(runtime)) {
			return;
		}
		noteToolStarted(runtime, event);
		startActivityTimer(runtime.activityArea, requireActivityHost(runtime), createActivityDeps(runtime));
	});

	// 工具流式输出：只保留最后一行作为输出尾巴。
	pi.on("tool_execution_update", async (event) => {
		if (!isActivityEnabled(runtime)) {
			return;
		}
		noteToolOutput(runtime, event.toolCallId, event.partialResult);
	});

	// 工具结束：移出正在执行列表，并把结果尾巴再抓一次。
	pi.on("tool_execution_end", async (event) => {
		if (!isActivityEnabled(runtime)) {
			return;
		}
		noteToolOutput(runtime, event.toolCallId, event.result);
		noteToolFinished(runtime, event);
	});

	// 一条 assistant 消息开始流式：记下「这条还没开新组」，并把上一条消息的登记清掉。
	pi.on("message_start", async (event) => {
		beginStreamedMessage(runtime.streamRegistration, event.message);
	});

	// 模型流式更新：先开组、先把已出现的工具调用登记掉，再取思考头部。
	//
	// 顺序不能换：开组必须早于登记，否则解说后面那几个调用会落到上一组；
	// 登记必须早于渲染，否则那行工具行会先以原样画出来（见 `stream-registration.ts`）。
	pi.on("message_update", async (event) => {
		feedStreamedMessage(runtime, event.message);
		if (!isActivityEnabled(runtime)) {
			return;
		}
		runtime.activity.thought = extractThoughtHead(event.message);
	});

	// 一次运行结束：记录耗时、按配置自动收起，并清掉本次的开始时间。
	pi.on("agent_settled", async (_event, ctx) => {
		runtime.state = settleRun({
			state: runtime.state,
			config: runtime.config,
			nowMs: Date.now(),
			startedAtMs: runtime.runStartedAtMs,
		});
		runtime.runStartedAtMs = undefined;
		runtime.activity = { ...runtime.activity, active: false };
		runtime.runDurations.bindRun(runtime.state.runDurationMs, runtime.runToolCount);
		clearActivityArea(runtime.activityArea, requireActivityHost(runtime));
		requestRender(runtime);
	});

	// 组边界跟着「解说」走：带正文解说的 assistant 消息开新组，
	// 连续的纯工具 turn 合并进同一组，这样才能真正收成一行组头。
	//
	// 流式阶段已经开过组、也已经登记过工具调用的消息在这里只剩两个兑底：不流式的
	// provider，以及流式更新里没扫到的调用。
	pi.on("message_end", async (event) => {
		const isAssistant = isAssistantMessage(event.message);
		const hasText = hasNarrationText(event.message);
		debugLog("message_end", `assistant=${isAssistant} text=${hasText}`);
		if (!isAssistant) {
			return;
		}
		feedStreamedMessage(runtime, event.message);
	});

	// 把每个工具调用登记进当前动作组，供渲染时判断是否收成组头。
	// tool_call 比 tool_execution_start 早，能更早拿到归属；两者互为兑底。
	pi.on("tool_call", async (event) => {
		registerToolAction(runtime, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.input,
		});
		debugLog("tool_call", `${event.toolCallId} -> group=${runtime.actionGroups.currentGroupId}`);
	});

	pi.on("session_shutdown", async () => {
		// 清理要先于置空：clearActivityArea 还需要宿主去恢复 Pi 的内置提示。
		clearActivityArea(runtime.activityArea, requireActivityHost(runtime));
		runtime.restorePatches?.();
		runtime.restorePatches = undefined;
		runtime.activityHost = undefined;
		runtime.tui = undefined;
	});

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: i18n.t("toggleDescription"),
		handler: (ctx) => toggleCollapsed(runtime, ctx),
	});

	pi.registerCommand(TOGGLE_COMMAND, {
		description: i18n.t("toggleDescription"),
		handler: async (args, ctx) => handleToggleCommand(runtime, args, ctx),
	});

	pi.registerShortcut(TOGGLE_GROUPS_SHORTCUT, {
		description: i18n.t("toggleGroupsDescription"),
		handler: (ctx) => toggleAllActionGroups(runtime, ctx),
	});

	pi.registerCommand(CONFIG_COMMAND, {
		description: i18n.t("configDescription"),
		handler: async (args, ctx) => handleConfigCommand(runtime, args, ctx),
	});
}
