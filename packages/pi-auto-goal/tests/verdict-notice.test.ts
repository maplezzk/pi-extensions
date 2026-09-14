import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInterruptedLine,
  buildNotCompletedLine,
  buildVerdictLine,
  verdictNoticeLevel,
} from "../src/verdict-notice.ts";
import type { StopOutcome } from "../src/evaluate.ts";

/** 判定为提前停止并成功发送催促时的结果。 */
const CONTINUE: StopOutcome = {
  kind: "continue",
  message: "继续干",
  reason: "只改了 1/5 个文件",
  confidence: 0.97,
  budget: "1/2",
};

test("判定为早停催停时用 warning 色并带上干预进度", () => {
  const line = buildVerdictLine(CONTINUE);
  assert.equal(line.color, "warning");
  assert.match(line.text, /催促|continued/);
  assert.match(line.text, /1\/2/);
});

test("判定为可以停止时用 success 色并带上置信度", () => {
  const line = buildVerdictLine({ kind: "stop", reason: "已完成", confidence: 0.923 });
  assert.equal(line.color, "success");
  assert.match(line.text, /停止合理|stop accepted/);
  // 置信度只保留一位小数：结论行是会话区里的一行字，不需要无意义精度。
  assert.match(line.text, /0\.9/);
  assert.doesNotMatch(line.text, /0\.923/);
});

test("预算用尽时用 dim 色，判定失败时用 error 色", () => {
  const budget = buildVerdictLine({ kind: "skipped", code: "budget", used: 2, limit: 2, budget: "2/2" });
  assert.equal(budget.color, "dim");
  assert.match(budget.text, /2\/2/);

  const failed = buildVerdictLine({ kind: "failed", error: "判定模型请求失败：boom" });
  assert.equal(failed.color, "error");
  assert.match(failed.text, /判定失败|judge failed/);
});

test("用户打断时明确写成「未判定」，与「判定为可停止」区分开", () => {
  const interrupted = buildInterruptedLine();
  assert.equal(interrupted.color, "dim");
  assert.match(interrupted.text, /已打断|interrupted/);
  assert.match(interrupted.text, /未判定|not judged/);

  const skipped = buildVerdictLine({ kind: "skipped", code: "canceled", used: 0, limit: 2, budget: "0/2" });
  assert.equal(skipped.text, interrupted.text);
});

test("非正常结束（失败或残缺）用另一条文案，不冒充「已打断」", () => {
  const notCompleted = buildNotCompletedLine();
  assert.equal(notCompleted.color, "dim");
  assert.match(notCompleted.text, /未正常结束|did not finish/);
  assert.doesNotMatch(notCompleted.text, /已打断|interrupted/);
});

test("结论行只放结论，不把失败详情塞进去", () => {
  const line = buildVerdictLine({ kind: "failed", error: "判定模型返回无法解析的响应：xxx" });
  assert.doesNotMatch(line.text, /xxx/);
});

test("结论色映射到提示级别：红→error、黄→warning、其余→info", () => {
  assert.equal(verdictNoticeLevel("error"), "error");
  assert.equal(verdictNoticeLevel("warning"), "warning");
  assert.equal(verdictNoticeLevel("success"), "info");
  assert.equal(verdictNoticeLevel("dim"), "info");
});
