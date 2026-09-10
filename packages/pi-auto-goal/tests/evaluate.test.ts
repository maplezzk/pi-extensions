import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AUTO_GOAL_CONFIG, type AutoGoalConfig } from "../src/config.ts";
import { evaluateStop, STOP_SKIP_BUDGET } from "../src/evaluate.ts";
import type { StopVerdict, StopVerdictRequester } from "../src/verdict.ts";
import type { TurnSnapshot } from "../src/session-context.ts";

/** 判定输入快照。 */
const SNAPSHOT: TurnSnapshot = {
  userRequest: "改好 a.ts 并跑测试",
  finalOutput: "已经改好 a.ts。",
  toolTrace: [],
};

/** 返回固定结论的判定流程替身。 */
function fixedJudge(verdict: StopVerdict): StopVerdictRequester {
  return async () => verdict;
}

/** 永久挂起、直到收到中止信号才失败的判定流程替身。 */
const hangingJudge: StopVerdictRequester = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

/** 覆盖默认配置。 */
function configWith(overrides: Partial<AutoGoalConfig> = {}): AutoGoalConfig {
  return { ...DEFAULT_AUTO_GOAL_CONFIG, ...overrides };
}

test("干预次数用尽时跳过判定，不再调用模型", async () => {
  const calls = { count: 0 };
  const judge: StopVerdictRequester = async () => {
    calls.count += 1;
    return { decision: "continue", confidence: 1, reason: "x" };
  };
  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith({ maxAutoContinues: 2 }),
    judge,
    used: 2,
  });

  assert.equal(calls.count, 0);
  assert.equal(outcome.kind, "skipped");
  assert.equal(outcome.kind === "skipped" ? outcome.code : "", STOP_SKIP_BUDGET);
  assert.equal(outcome.kind === "skipped" ? outcome.budget : "", "2/2");
});

test("高置信度的提前停止判定转成待发送的催促消息", async () => {
  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith(),
    judge: fixedJudge({ decision: "continue", confidence: 0.9, reason: "还缺回归测试" }),
    used: 0,
  });

  assert.equal(outcome.kind, "continue");
  if (outcome.kind !== "continue") return;
  assert.match(outcome.message, /还缺回归测试/);
  assert.equal(outcome.budget, "1/2");
  assert.equal(outcome.confidence, 0.9);
});

test("受控实验：强制判定为提前停止，不调用模型并直接催促", async () => {
  let called = false;
  const judge: StopVerdictRequester = async () => {
    called = true;
    return { decision: "stop", confidence: 0, reason: "模型原始判定" };
  };

  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith({
      forcedDecision: "continue",
      continueMessageTemplate: "请按此补齐：{reason}",
    }),
    judge,
    used: 0,
  });

  assert.equal(called, false);
  assert.equal(outcome.kind, "continue");
  if (outcome.kind !== "continue") return;
  assert.match(outcome.reason, /强制判定为提前停止|forced/);
  assert.equal(outcome.message, "请按此补齐：受控实验：强制判定为提前停止");
  assert.equal(outcome.budget, "1/2");
  assert.equal(outcome.confidence, 1);
});


test("自定义催促模板生效，缺少占位符时自动补上理由", async () => {
  const withPlaceholder = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith({ continueMessageTemplate: "继续干活：{reason}" }),
    judge: fixedJudge({ decision: "continue", confidence: 1, reason: "缺验证" }),
    used: 0,
  });
  assert.equal(withPlaceholder.kind === "continue" ? withPlaceholder.message : "", "继续干活：缺验证");

  const withoutPlaceholder = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith({ continueMessageTemplate: "继续干活。" }),
    judge: fixedJudge({ decision: "continue", confidence: 1, reason: "缺验证" }),
    used: 0,
  });
  assert.match(withoutPlaceholder.kind === "continue" ? withoutPlaceholder.message : "", /继续干活。[\s\S]*缺验证/);
});

test("置信度低于阈值时视为可正常停止", async () => {
  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith({ confidenceThreshold: 0.7 }),
    judge: fixedJudge({ decision: "continue", confidence: 0.3, reason: "可能还没完" }),
    used: 0,
  });
  assert.equal(outcome.kind, "stop");
  assert.equal(outcome.kind === "stop" ? outcome.confidence : -1, 0.3);
});

test("判定为 stop 时不干预", async () => {
  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith(),
    judge: fixedJudge({ decision: "stop", confidence: 1, reason: "任务已完成" }),
    used: 1,
  });
  assert.equal(outcome.kind, "stop");
  assert.equal(outcome.kind === "stop" ? outcome.reason : "", "任务已完成");
});

test("受控实验：强制判定为可停止，直接结束不催促", async () => {
  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith({ forcedDecision: "stop" }),
    judge: hangingJudge,
    used: 0,
  });
  assert.equal(outcome.kind, "stop");
  if (outcome.kind !== "stop") return;
  assert.match(outcome.reason, /可停止|acceptable stop|forced acceptable/i);
  assert.equal(outcome.confidence, 1);
});
test("判定失败显式报告错误，不静默当成可停止", async () => {
  const brokenJudge: StopVerdictRequester = async () => {
    throw new Error("provider down");
  };
  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith(),
    judge: brokenJudge,
    used: 0,
  });

  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.error : "", /provider down/);
});

test("判定超时被中止并报告超时文案", async () => {
  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith({ timeoutSeconds: 1 }),
    judge: hangingJudge,
    used: 0,
  });

  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.error : "", /判定请求超过 1 秒|exceeded 1s/);
});

test("上限为 0 表示不限制干预次数", async () => {
  const outcome = await evaluateStop({
    snapshot: SNAPSHOT,
    config: configWith({ maxAutoContinues: 0 }),
    judge: fixedJudge({ decision: "continue", confidence: 1, reason: "还没做完" }),
    used: 99,
  });

  assert.equal(outcome.kind, "continue");
  assert.equal(outcome.kind === "continue" ? outcome.budget : "", "100/∞");
});
