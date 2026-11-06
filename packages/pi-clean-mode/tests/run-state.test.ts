import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCollapsed, createInitialState, restoreHistory, settleRun, startRun } from "../src/run-state.ts";
import { DEFAULT_CLEAN_MODE_CONFIG, type CleanModeState } from "../src/types.ts";

/** 基准配置。 */
const CONFIG = { ...DEFAULT_CLEAN_MODE_CONFIG };
/** 运行开始时间戳。 */
const RUN_START_MS = 1_000_000;
/** 运行结束时间戳；与开始时间相差 4 分 26 秒。 */
const RUN_END_MS = 1_266_000;
/** 上一轮遗留的耗时，用于验证开始运行时会清掉。 */
const PREVIOUS_DURATION_MS = 999;
/** 缺少开始时间时沿用的已有耗时。 */
const EXISTING_DURATION_MS = 12_000;
/** 早于运行开始的偏移量，用于构造负耗时。 */
const NEGATIVE_OFFSET_MS = 5_000;

/** 校验初始状态是展开且未结束。 */
function assertInitialState(): void {
	const state = createInitialState();
	assert.equal(state.collapsed, false);
	assert.equal(state.runSettled, false);
	assert.equal(state.userOverrodeThisRun, false);
}

/** 校验开始运行会清掉上一轮耗时并保持展开。 */
function assertStartRunResets(): void {
	const previous: CleanModeState = {
		collapsed: true,
		runSettled: true,
		runDurationMs: PREVIOUS_DURATION_MS,
		userOverrodeThisRun: true,
	};
	const next = startRun({ state: previous, config: CONFIG });

	assert.equal(next.collapsed, false);
	assert.equal(next.runSettled, false);
	assert.equal(next.runDurationMs, undefined);
	assert.equal(next.userOverrodeThisRun, false);
}

/** 校验关闭自动展开时不改变当前折叠态。 */
function assertStartRunKeepsCollapsed(): void {
	const previous: CleanModeState = {
		collapsed: true,
		runSettled: true,
		userOverrodeThisRun: false,
	};
	const next = startRun({
		state: previous,
		config: { ...CONFIG, autoExpandWhileRunning: false },
	});
	assert.equal(next.collapsed, true);
}

/** 校验运行结束会记录耗时并自动收起。 */
function assertSettleRecordsDuration(): void {
	const started = startRun({ state: createInitialState(), config: CONFIG });
	const settled = settleRun({
		state: started,
		config: CONFIG,
		nowMs: RUN_END_MS,
		startedAtMs: RUN_START_MS,
	});

	assert.equal(settled.runDurationMs, RUN_END_MS - RUN_START_MS);
	assert.equal(settled.runSettled, true);
	assert.equal(settled.collapsed, true);
}

/** 校验用户手动展开过之后本次运行不再自动收起。 */
function assertManualOverrideWins(): void {
	const started = startRun({ state: createInitialState(), config: CONFIG });
	const overridden = applyCollapsed(started, false, true);
	const settled = settleRun({
		state: overridden,
		config: CONFIG,
		nowMs: RUN_END_MS,
		startedAtMs: RUN_START_MS,
	});

	assert.equal(settled.collapsed, false);
	assert.equal(settled.userOverrodeThisRun, true);
}

/** 校验缺少开始时间时沿用已有耗时。 */
function assertSettleKeepsPreviousDuration(): void {
	const state: CleanModeState = {
		collapsed: false,
		runSettled: false,
		runDurationMs: EXISTING_DURATION_MS,
		userOverrodeThisRun: false,
	};
	const settled = settleRun({ state, config: CONFIG, nowMs: RUN_END_MS });
	assert.equal(settled.runDurationMs, EXISTING_DURATION_MS);
}

/** 校验负耗时被夹到 0。 */
function assertNegativeDurationClampsToZero(): void {
	const settled = settleRun({
		state: createInitialState(),
		config: CONFIG,
		nowMs: RUN_START_MS - NEGATIVE_OFFSET_MS,
		startedAtMs: RUN_START_MS,
	});
	assert.equal(settled.runDurationMs, 0);
}

/** 校验自动收起后用户手动展开仍然生效。 */
function assertExpandAfterAutoCollapse(): void {
	const settled = settleRun({
		state: startRun({ state: createInitialState(), config: CONFIG }),
		config: CONFIG,
		nowMs: RUN_END_MS,
		startedAtMs: RUN_START_MS,
	});
	const expanded = applyCollapsed(settled, false, true);
	assert.equal(expanded.collapsed, false);
}

/** 校验恢复历史时收起：历史轮次没走过 agent_settled，不收起就整段原样铺开。 */
function assertRestoreHistoryCollapses(): void {
	const restored = restoreHistory({ state: createInitialState(), config: CONFIG });
	assert.equal(restored.collapsed, true);
	assert.equal(restored.runSettled, true);
}

/** 校验总开关关闭时恢复历史不动折叠态（反正渲染层也不会折叠）。 */
function assertRestoreHistoryRespectsDisabled(): void {
	const state = createInitialState();
	const restored = restoreHistory({ state, config: { ...CONFIG, enabled: false } });
	assert.equal(restored.collapsed, false);
}

/** 校验恢复历史后新的一轮仍会先展开。 */
function assertRunAfterRestoreExpands(): void {
	const restored = restoreHistory({ state: createInitialState(), config: CONFIG });
	const started = startRun({ state: restored, config: CONFIG });
	assert.equal(started.collapsed, false);
}

test("初始状态是展开且未结束", assertInitialState);
test("开始运行会清掉上一轮耗时并保持展开", assertStartRunResets);
test("关闭自动展开时不改变当前折叠态", assertStartRunKeepsCollapsed);
test("运行结束会记录耗时并自动收起", assertSettleRecordsDuration);
test("用户手动展开过则本次运行不再自动收起", assertManualOverrideWins);
test("缺少开始时间时沿用已有耗时", assertSettleKeepsPreviousDuration);
test("负耗时被夹到 0", assertNegativeDurationClampsToZero);
test("自动收起后用户手动展开仍生效", assertExpandAfterAutoCollapse);
test("恢复历史时收起并视为已结束", assertRestoreHistoryCollapses);
test("总开关关闭时恢复历史不改折叠态", assertRestoreHistoryRespectsDisabled);
test("恢复历史后新的一轮仍会先展开", assertRunAfterRestoreExpands);
