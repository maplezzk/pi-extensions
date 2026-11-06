/**
 * 折叠状态的纯状态迁移。
 *
 * 不持有任何实例引用与定时器，输入输出都是普通对象，方便单测覆盖
 * 开始运行、结束运行、手动切换与自动收起被压制这几种路径。
 */

import type { CleanModeConfig, CleanModeState } from "./types.js";

/** 开始一次 agent 运行所需的输入。 */
export interface StartRunInput {
	state: CleanModeState;
	config: CleanModeConfig;
}

/** 结束一次 agent 运行所需的输入。 */
export interface SettleRunInput {
	state: CleanModeState;
	config: CleanModeConfig;
	/** 运行结束时间戳（毫秒）。 */
	nowMs: number;
	/** 运行开始时间戳；缺失表示未记录到开始时间。 */
	startedAtMs?: number;
}

/** 从会话恢复（或重载）时重建历史所需的输入。 */
export interface RestoreHistoryInput {
	state: CleanModeState;
	config: CleanModeConfig;
}

/** 创建初始状态：默认展开，等待第一次运行。 */
export function createInitialState(): CleanModeState {
	return {
		collapsed: false,
		runSettled: false,
		userOverrodeThisRun: false,
	};
}

/**
 * 把恢复出来的历史轮次当成已经结束的一轮。
 *
 * 历史消息不会重放 `agent_start` / `agent_settled`：`/resume`、`/reload`、`/fork` 之后
 * 状态还停在 `createInitialState()` 的展开态，于是整段历史原样铺开，看起来像根本
 * 没开清爽模式（折叠只在 `state.collapsed` 为真时生效）。这里直接按「已结束」处理。
 *
 * 只改折叠态：耗时与步数不在会话里，历史轮次的耗时横条仍然不会出现。
 * 下一轮真正开始运行时 `agent_start` 会重新展开，不受这里影响。
 */
export function restoreHistory(input: RestoreHistoryInput): CleanModeState {
	const { state, config } = input;
	return {
		...state,
		collapsed: config.enabled ? true : state.collapsed,
		runSettled: true,
	};
}

/**
 * 判断运行结束后是否应自动收起。
 *
 * 关闭总开关、关闭自动展开、或用户本次已手动干预时都不自动收起。
 */
function shouldAutoCollapseAfterRun(state: CleanModeState, config: CleanModeConfig): boolean {
	if (!config.enabled || !config.autoExpandWhileRunning) {
		return false;
	}
	return !state.userOverrodeThisRun;
}

/** 计算运行结束后的折叠态：需要自动收起时收起，否则保持用户当前选择。 */
function resolveCollapsedAfterRun(state: CleanModeState, config: CleanModeConfig): boolean {
	if (shouldAutoCollapseAfterRun(state, config)) {
		return true;
	}
	return state.collapsed;
}

/** 计算运行耗时：开始时间不可用时沿用已有耗时，否则取非负差值。 */
function resolveRunDuration(
	startedAtMs: number | undefined,
	nowMs: number,
	fallbackMs?: number,
): number | undefined {
	if (typeof startedAtMs !== "number") {
		return fallbackMs;
	}
	return Math.max(0, nowMs - startedAtMs);
}

/**
 * 开始一次运行：清掉上一轮的耗时与最终组件，并按配置决定是否先展开。
 *
 * 自动展开是必要的默认行为——否则整个运行期间用户只能看到空白，
 * 直到最终答案出现。
 */
export function startRun(input: StartRunInput): CleanModeState {
	const { state, config } = input;
	const autoExpand = config.enabled && config.autoExpandWhileRunning;

	return {
		...state,
		collapsed: autoExpand ? false : state.collapsed,
		runDurationMs: undefined,
		runSettled: false,
		userOverrodeThisRun: false,
	};
}

/**
 * 结束一次运行：记录耗时并决定是否自动收起。
 *
 * 只有当用户在本次运行中没手动干预过时才自动收起；手动展开过就尊重用户选择。
 */
export function settleRun(input: SettleRunInput): CleanModeState {
	const { state, config, nowMs, startedAtMs } = input;

	return {
		...state,
		collapsed: resolveCollapsedAfterRun(state, config),
		runDurationMs: resolveRunDuration(startedAtMs, nowMs, state.runDurationMs),
		runSettled: true,
	};
}

/** 切换折叠状态；byUser 为真时记为手动干预，压制本次运行的自动收起。 */
export function applyCollapsed(
	state: CleanModeState,
	collapsed: boolean,
	byUser: boolean,
): CleanModeState {
	return {
		...state,
		collapsed,
		userOverrodeThisRun: byUser || state.userOverrodeThisRun,
	};
}
