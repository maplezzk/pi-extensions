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
import { installComponentPatches } from "./component-patches.js";
import { i18n } from "./i18n.js";
import { applyCollapsed, createInitialState, settleRun, startRun } from "./run-state.js";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeConfig, type CleanModeState } from "./types.js";

/** 折叠/展开快捷键；f2 未被 Pi 内置键位占用。 */
const TOGGLE_SHORTCUT = "f2";
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
	/** 安装补丁后的还原函数。 */
	restorePatches?: () => void;
}

/** 主题不可用时的默认着色：原样返回文本。 */
function defaultHeaderStyle(text: string): string {
	return text;
}

/** 创建初始运行期状态。 */
function createRuntime(): Runtime {
	return {
		state: createInitialState(),
		config: { ...DEFAULT_CLEAN_MODE_CONFIG },
		styleHeader: defaultHeaderStyle,
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
	});
}

/** 切换折叠状态并提示用户。 */
function toggleCollapsed(runtime: Runtime, ctx: ExtensionContext | ExtensionCommandContext): void {
	const next = !runtime.state.collapsed;
	runtime.state = applyCollapsed(runtime.state, next, true);
	requestRender(runtime);

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

		installPatches(runtime);
		requestRender(runtime);

		if (loaded.diagnostic) {
			notifyWithSource({
				ctx,
				source: NOTICE_SOURCE,
				level: "warning",
				message: i18n.t("loadFailed", { error: loaded.diagnostic }),
			});
		}
	});

	pi.on("agent_start", async () => {
		runtime.runStartedAtMs = Date.now();
		runtime.state = startRun({ state: runtime.state, config: runtime.config });
		requestRender(runtime);
	});

	pi.on("agent_settled", async () => {
		runtime.state = settleRun({
			state: runtime.state,
			config: runtime.config,
			nowMs: Date.now(),
			startedAtMs: runtime.runStartedAtMs,
		});
		runtime.runStartedAtMs = undefined;
		requestRender(runtime);
	});

	pi.on("session_shutdown", async () => {
		runtime.restorePatches?.();
		runtime.restorePatches = undefined;
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

	pi.registerCommand(CONFIG_COMMAND, {
		description: i18n.t("configDescription"),
		handler: async (args, ctx) => handleConfigCommand(runtime, args, ctx),
	});
}
