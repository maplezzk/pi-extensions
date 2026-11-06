import assert from "node:assert/strict";
import test from "node:test";
import { createElapsedTracker, shouldReportTotalRun } from "../src/turn-elapsed.ts";

/** 可控时钟：让计时测试不依赖真实时间。 */
function createClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    /** 当前时刻（毫秒）。 */
    now: () => current,
    /** 前进指定毫秒。 */
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("单轮运行不单独报总耗时：本轮耗时已经在指标行里", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  tracker.startRun();
  clock.advance(3_400);
  tracker.startTurn();
  clock.advance(3_400);
  tracker.endTurn();
  clock.advance(1_200);

  const settlement = tracker.currentRun();
  assert.ok(settlement);
  assert.equal(settlement.turns, 1);
  assert.equal(settlement.elapsedMs, 8_000);
  assert.equal(shouldReportTotalRun(settlement), false);
});

test("多轮运行在停下时报一次总耗时", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  tracker.startRun();
  clock.advance(2_000);
  tracker.startTurn();
  clock.advance(2_000);
  tracker.endTurn();
  tracker.startTurn();
  clock.advance(3_000);
  tracker.endTurn();
  clock.advance(400);

  const settlement = tracker.currentRun();
  assert.ok(settlement);
  assert.deepEqual(settlement, { elapsedMs: 7_400, turns: 2 });
  assert.equal(shouldReportTotalRun(settlement), true);
});

test("新的一条用户消息开新的一段运行，轮次计数归零", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  tracker.startRun();
  tracker.startTurn();
  clock.advance(1_000);
  tracker.endTurn();
  tracker.startTurn();
  clock.advance(1_000);
  tracker.endTurn();
  // 上一段运行在 agent_settled 时结算并复位。
  assert.deepEqual(tracker.currentRun(), { elapsedMs: 2_000, turns: 2 });
  tracker.resetRun();
  // 新的用户消息开新一段：轮次计数归零，单轮不算值得单独报总耗时。
  tracker.startRun();
  tracker.startTurn();
  clock.advance(500);
  tracker.endTurn();
  clock.advance(100);

  const settlement = tracker.currentRun();
  assert.ok(settlement);
  assert.equal(settlement.turns, 1);
  assert.equal(shouldReportTotalRun(settlement), false);
});

test("运行中重复调用 startRun 不会重置起点（steer/followUp 保留原起点）", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  tracker.startRun();
  clock.advance(5_000);
  tracker.startRun();
  tracker.startTurn();
  clock.advance(1_000);
  tracker.endTurn();
  tracker.startTurn();
  clock.advance(1_000);
  tracker.endTurn();

  assert.equal(tracker.runElapsed(), 7_000);
  assert.deepEqual(tracker.currentRun(), { elapsedMs: 7_000, turns: 2 });
});

test("agent_end 清掉本轮状态：被清掉的那轮不计入轮数", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  tracker.startRun();
  tracker.startTurn();
  tracker.clearTurn();
  clock.advance(1_000);
  tracker.endTurn();
  tracker.startTurn();
  clock.advance(1_000);
  tracker.endTurn();

  // 只有一轮真正结束过，不值得单独报总耗时。
  const settlement = tracker.currentRun();
  assert.ok(settlement);
  assert.equal(settlement.turns, 1);
  assert.equal(shouldReportTotalRun(settlement), false);
});

test("没有进行中的运行时 runElapsed 返回 0，currentRun 没有可结算数据", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  assert.equal(tracker.runElapsed(), 0);
  assert.equal(tracker.currentRun(), undefined);
  tracker.startTurn();
  clock.advance(2_000);
  tracker.endTurn();

  assert.equal(tracker.currentRun(), undefined);
});

test("复位后可以马上开始下一段运行，起点不会被旧数据污染", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  tracker.startRun();
  clock.advance(4_000);
  tracker.resetRun();
  tracker.startRun();
  clock.advance(300);

  assert.equal(tracker.runElapsed(), 300);
});
