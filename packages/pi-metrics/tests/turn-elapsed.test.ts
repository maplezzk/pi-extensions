import assert from "node:assert/strict";
import test from "node:test";
import { createElapsedTracker } from "../src/turn-elapsed.ts";

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

test("单轮运行不报总耗时：本轮耗时已经在 tps 指标行里", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  tracker.startRun();
  clock.advance(3_400);
  tracker.startTurn();
  clock.advance(3_400);
  tracker.endTurn();
  clock.advance(1_200);

  assert.equal(tracker.settle(), undefined);
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

  assert.equal(tracker.settle(), 7_400);
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
  // 上一段运行在 agent_settled 时结束并报出总耗时。
  assert.equal(tracker.settle(), 2_000);
  // 新的用户消息开新一段：轮次计数归零，单轮不报总耗时。
  tracker.startRun();
  tracker.startTurn();
  clock.advance(500);
  tracker.endTurn();
  clock.advance(100);

  assert.equal(tracker.settle(), undefined);
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
  assert.equal(tracker.settle(), 7_000);
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

  // 只有一轮真正结束过，不报总耗时。
  assert.equal(tracker.settle(), undefined);
});

test("没有进行中的运行时 runElapsed 返回 0，settle 不报总耗时", () => {
  const clock = createClock();
  const tracker = createElapsedTracker(clock.now);
  assert.equal(tracker.runElapsed(), 0);
  tracker.startTurn();
  clock.advance(2_000);
  tracker.endTurn();

  assert.equal(tracker.settle(), undefined);
});
