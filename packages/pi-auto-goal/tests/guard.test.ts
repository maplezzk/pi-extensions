import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBudget, hasContinueBudget, isJudgeableStopReason } from "../src/guard.ts";

test("预算为 0 表示不限制，否则用满即停", () => {
  assert.equal(hasContinueBudget(0, 99), true);
  assert.equal(hasContinueBudget(2, 1), true);
  assert.equal(hasContinueBudget(2, 2), false);
  assert.equal(hasContinueBudget(2, 3), false);
});

test("预算文案在无上限时写成 ∞", () => {
  assert.equal(formatBudget(2, 1), "1/2");
  assert.equal(formatBudget(0, 3), "3/∞");
});

test("只有正常跑完的结束原因才判定", () => {
  // stop：agent 自己结束本轮；length：输出被长度上限截断，两种都说明这一轮是跑完的。
  assert.equal(isJudgeableStopReason("stop"), true);
  assert.equal(isJudgeableStopReason("length"), true);
});

test("用户打断与请求失败都不判定，避免把打断当成提前停止去催", () => {
  // 真实会话里：Esc 打断会留下 aborted 或 error（内容为空），两者都不是 agent 的决定。
  assert.equal(isJudgeableStopReason("aborted"), false);
  assert.equal(isJudgeableStopReason("error"), false);
  // 缺失结束原因（残缺消息）按最保守处理，不判定。
  assert.equal(isJudgeableStopReason(undefined), false);
  // 未在允许清单内的取值一律不判定。
  assert.equal(isJudgeableStopReason("toolUse"), false);
});
