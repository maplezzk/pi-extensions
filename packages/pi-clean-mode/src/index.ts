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

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	installNoticeRenderer,
	notifyWithSource,
	type NoticeColor,
	type NoticeSource,
} from "pi-extensions-i18n";
import { loadConfig, saveConfig } from "./config-store.js";
import { debugLog, debugLogPath } from "./debug-logger.js";
import {
	buildActivityLines,
	classifyToolActivity,
	createActivitySnapshot,
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
import {
	areAllActionGroupsExpanded,
	beginActionGroupStep,
	createActionGroupState,
	findActionGroupMembership,
	getActionGroupSize,
	hasNarrationText,
	isActionGroupExpanded,
	isAssistantMessage,
	registerActionToolCall,
	setAllActionGroupsExpanded,
	toggleActionGroup,
	type ActionGroupState,
} from "./action-groups.js";
import { i18n } from "./i18n.js";
import { applyCollapsed, createInitialState, settleRun, startRun } from "./run-state.js";
import { createTranscriptTail, type TranscriptTail } from "./transcript-tail.js";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type CleanModeState } from "./types.js";

/** 折叠/展开快捷键；f2 未被 Pi 内置键位占用。 */
const TOGGLE_SHORTCUT = "f2";
/** 批量展开/收起全部动作组的快捷键。 */
const TOGGLE_GROUPS_SHORTCUT = "shift+f2";
/** 用于取得 TUI 句柄的空 widget key；该 widget 不渲染任何内容。 */
const PROBE_WIDGET_KEY = "pi-clean-mode-probe";
/** 切换折叠状态的命令名。 */
const TOGGLE_COMMAND = "clean";
/** 查看与修改配置的命令名。 */
const CONFIG_COMMAND = "config:clean-mode";
/** 配置命令里表示「打开」的取值。 */
const CONFIG_ON_VALUES = new Set(["on", "true", "1", "yes"]);
/** 配置命令里表示「关闭」的取值。 */
const CONFIG_OFF_VALUES = new Set(["off", "false", "0", "no"]);
/** 空渲染结果；探针组件用它表示「不占任何行」。 */
const NO_LINES: string[] = [];
/** 配置命令里 `key=value` 的最大切分段数。 */
const ASSIGNMENT_PART_LIMIT = 2;

/** 不渲染任何内容的组件，用于挂载探针并取得 TUI 句柄。 */
const NO_CONTENT_COMPONENT: Component = {
	/** 永远返回空行集，不占用任何屏幕行。 */
	render: () => NO_LINES,
	/** 无缓存状态，无需清理。 */
	invalidate: () => {},
};
/** 提示来源标签与颜色。 */
const NOTICE_TAG = "clean";
const NOTICE_COLOR: NoticeColor = "muted";
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
/** 渲染折叠头时用的弱化色函数。 */
type HeaderStyle = (text: string) => string;

/** 本扩展的运行期状态。 */
interface Runtime {
	state: CleanModeState;
	config: CleanModeConfig;
	/** 当前一次运行的开始时间戳（毫秒）。 */
	runStartedAtMs?: number;
	/** 取得 TUI 句柄后用于触发重绘。 */
	tui?: TUI;
	/** 渲染折叠头用的着色函数。 */
	styleHeader: HeaderStyle;
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
	/** transcript 末尾补丁；活动行靠它内联进对话流。 */
	transcriptTail?: TranscriptTail;
	/** 每轮耗时账本，把耗时绑定到具体的最终答案消息上。 */
	runDurations: RunDurationLedger;
}

/** 主题不可用时的默认着色：原样返回文本。 */
function defaultHeaderStyle(text: string): string {
	return text;
}

/**
 * 每轮耗时账本。
 *
 * 耗时按「折叠头承载者组件」存，因此历史轮次的折叠头不会跟着最新一轮变化；
 * 承载者是每轮第一条 assistant 消息，保证耗时头永远在整轮最前面。
 * 内部维护归属标记与两张弱表，调用方只需按轮次调用这四个操作。
 */
interface RunDurationLedger {
	/** 开始新一轮：重开归属认领。 */
	beginRun(): void;
	/** 认领本轮折叠头归属；本轮已被认领时返回 false。 */
	claimOwner(host: object): boolean;
	/** 把本轮耗时绑定到当前承载者上；耗时未知或还没人认领时不做任何事。 */
	bindDuration(durationMs: number | undefined): void;
	/** 查询某个承载者所属那一轮的耗时。 */
	getDuration(host: object): number | undefined;
}

/** 创建耗时账本。 */
function createRunDurationLedger(): RunDurationLedger {
	const durations = new WeakMap<object, number>();
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
		/** 耗时未知或尚无承载者时直接跳过。 */
		bindDuration: (durationMs) => {
			if (durationMs === undefined || !owner) {
				return;
			}
			durations.set(owner, durationMs);
		},
		/** 未登记过的承载者返回 undefined，调用方据此不显示折叠头。 */
		getDuration: (host) => durations.get(host),
	};
}

/** 创建初始运行期状态。 */
function createRuntime(): Runtime {
	return {
		state: createInitialState(),
		config: { ...DEFAULT_CLEAN_MODE_CONFIG },
		styleHeader: defaultHeaderStyle,
		actionGroups: createActionGroupState(),
		activity: createActivitySnapshot(),
		activityArea: createActivityAreaRuntime(),
		runDurations: createRunDurationLedger(),
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
			setHiddenThinkingLabel: (label) => ctx.ui.setHiddenThinkingLabel(label),
		},
		requestRender: () => requestRender(runtime),
		attachTranscript: () => {
			// 新挂上补丁的那一次要自己补个重绘：这一帧的活动行才画得出来。
			if (runtime.transcriptTail?.attach()) {
				requestRender(runtime);
			}
		},
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
	};
}

/** 把配置值文本解析成布尔；无法识别时返回 undefined。 */
function parseToggleValue(raw: string): boolean | undefined {
	const normalized = raw.trim().toLowerCase();
	if (CONFIG_ON_VALUES.has(normalized)) {
		return true;
	}
	if (CONFIG_OFF_VALUES.has(normalized)) {
		return false;
	}
	return undefined;
}

/** 可写的布尔配置项 -> 写回函数；新增字段只改这张表。 */
const CONFIG_FIELD_WRITERS: Record<
	string,
	(config: CleanModeConfig, value: boolean) => CleanModeConfig
> = {
	// 总开关。
	enabled: (config, value) => ({ ...config, enabled: value }),
	// 运行中自动展开。
	autoExpandWhileRunning: (config, value) => ({ ...config, autoExpandWhileRunning: value }),
	// 折叠时显示「用时」折叠头。
	showRunHeader: (config, value) => ({ ...config, showRunHeader: value }),
	// 折叠头附带展开提示。
	showExpandHint: (config, value) => ({ ...config, showExpandHint: value }),
};

/** 按字段名写回一个布尔配置项；字段名不受支持时返回 undefined。 */
function withConfigField(
	config: CleanModeConfig,
	key: string,
	value: boolean,
): CleanModeConfig | undefined {
	const writer = CONFIG_FIELD_WRITERS[key];
	return writer ? writer(config, value) : undefined;
}

/** 请求重绘；TUI 句柄尚未取得时静默跳过。 */
function requestRender(runtime: Runtime): void {
	runtime.tui?.requestRender();
}

/** 安装渲染补丁；重复调用是幂等的。 */
function installPatches(runtime: Runtime): void {
	runtime.restorePatches?.();
	runtime.restorePatches = installComponentPatches({
		getState: () => runtime.state,
		getConfig: () => runtime.config,
		styleHeader: (text) => runtime.styleHeader(text),
		onToggle: () => {
			toggleRuntime(runtime);
		},
		getToolRowGroup: (toolCallId) => lookupToolRowGroup(runtime, toolCallId),
		onToggleActionGroup: (groupId) => {
			toggleActionGroup(runtime.actionGroups, groupId);
			requestRender(runtime);
		},
		claimRunHeaderHost: (host) => runtime.runDurations.claimOwner(host),
		getRunDuration: (host) => runtime.runDurations.getDuration(host),
	});
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
 * 尝试把 `key=value` 写入配置：校验字段、保存、重装补丁、重绘并提示结果。
 *
 * 返回 false 表示参数不是可识别的配置赋值，由调用方回显当前配置。
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
		value === undefined ? undefined : withConfigField(runtime.config, (parts[0] ?? "").trim(), value);

	if (!nextConfig) {
		return false;
	}

	runtime.config = nextConfig;
	const result = saveConfig(runtime.config);
	installPatches(runtime);
	requestRender(runtime);
	notifyWithSource({
		ctx,
		source: NOTICE_SOURCE,
		level: result.success ? "info" : "error",
		message: result.success
			? i18n.t("configSaved")
			: i18n.t("configSaveFailed", { error: result.error ?? "" }),
	});
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

/** 处理 `/config:clean-mode key=value`；无参数或无法解析时只回显当前配置。 */
function handleConfigCommand(runtime: Runtime, args: string, ctx: ExtensionCommandContext): void {
	if (applyConfigAssignment(runtime, args, ctx)) {
		return;
	}

	notifyWithSource({
		ctx,
		source: NOTICE_SOURCE,
		level: "info",
		message: JSON.stringify(runtime.config),
	});
}

/** 扩展工厂：注册事件、快捷键与命令。 */
export default function registerCleanMode(pi: ExtensionAPI): void {
	const runtime = createRuntime();
	installNoticeRenderer(pi);

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadConfig();
		runtime.config = loaded.config;
		runtime.styleHeader = (text) => ctx.ui.theme.fg("dim", text);

		// 通过一个不渲染内容的 widget 工厂取得 TUI 句柄，用于后续触发重绘。
		ctx.ui.setWidget(PROBE_WIDGET_KEY, (tui: TUI): Component => {
			runtime.tui = tui;
			return NO_CONTENT_COMPONENT;
		});

		// 补丁与宿主都在这里装配一次，之后事件回调只做取值与复用。
		runtime.transcriptTail = createTranscriptTail({
			getRoot: () => runtime.tui,
			getLines: () => runtime.activityArea.lines,
		});
		runtime.activityHost = createActivityHost(runtime, ctx);

		installPatches(runtime);
		requestRender(runtime);
		debugLog("session_start", `debug file=${debugLogPath()} actionGroups=${runtime.config.enableActionGroups}`);

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
		runtime.state = startRun({ state: runtime.state, config: runtime.config });
		beginActionGroupStep(runtime.actionGroups);
		runtime.runDurations.beginRun();

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
	pi.on("tool_execution_start", async (event, ctx) => {
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

	// 模型思考流式更新：取第一行作为活动区的思考头部。
	pi.on("message_update", async (event) => {
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
		runtime.runDurations.bindDuration(runtime.state.runDurationMs);
		clearActivityArea(runtime.activityArea, requireActivityHost(runtime));
		requestRender(runtime);
	});

	// 组边界跟着「解说」走：带正文解说的 assistant 消息开新组，
	// 连续的纯工具 turn 合并进同一组，这样才能真正收成一行组头。
	pi.on("message_end", async (event) => {
		const isAssistant = isAssistantMessage(event.message);
		const hasText = hasNarrationText(event.message);
		debugLog("message_end", `assistant=${isAssistant} text=${hasText}`);
		if (!isAssistant || !hasText) {
			return;
		}
		beginActionGroupStep(runtime.actionGroups);
		debugLog("message_end", `new group=${runtime.actionGroups.currentGroupId}`);
	});

	// 把每个工具调用登记进当前动作组，供渲染时判断是否收成组头。
	pi.on("tool_call", async (event) => {
		registerActionToolCall(runtime.actionGroups, event.toolCallId);
		debugLog("tool_call", `${event.toolCallId} -> group=${runtime.actionGroups.currentGroupId}`);
	});

	pi.on("session_shutdown", async () => {
		// 清理要先于置空：clearActivityArea 还需要宿主去恢复 Pi 的内置提示。
		clearActivityArea(runtime.activityArea, requireActivityHost(runtime));
		runtime.restorePatches?.();
		runtime.restorePatches = undefined;
		runtime.transcriptTail?.restore();
		runtime.transcriptTail = undefined;
		runtime.activityHost = undefined;
		runtime.tui = undefined;
	});

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: i18n.t("toggleDescription"),
		handler: (ctx) => toggleCollapsed(runtime, ctx),
	});

	pi.registerCommand(TOGGLE_COMMAND, {
		description: i18n.t("toggleDescription"),
		handler: async (_args, ctx) => toggleCollapsed(runtime, ctx),
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
