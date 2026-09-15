import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInterruptedNotice,
  buildNotCompletedNotice,
  buildSendFailedNotice,
  buildVerdictNotice,
  formatConfidence,
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

test("早停干预：一行结论带进度，理由与已发送内容收进展开细节", () => {
  const notice = buildVerdictNotice(CONTINUE, "继续干");
  assert.equal(notice.color, "warning");
  assert.equal(notice.level, "warning");
  assert.match(notice.text, /催促|continuation/);
  assert.match(notice.text, /1\/2/);
  // 一行里不放理由，避免提示块变厚。
  assert.doesNotMatch(notice.text, /只改了/);
  assert.match(notice.details.join("\n"), /只改了 1\/5 个文件/);
  assert.match(notice.details.join("\n"), /继续干/);
});

test("判定为可以停止：理由默认显示在结论下面一行，不用展开", () => {
  const notice = buildVerdictNotice({ kind: "stop", reason: "已完成", confidence: 0.923 });
  assert.equal(notice.color, "success");
  assert.equal(notice.level, "info");
  const [headline, reasonLine] = notice.text.split("\n");
  assert.match(headline, /判定可停止|stop accepted/);
  // 置信度写成整数百分比，用户不用猜 0.9 是秒数还是把握程度。
  assert.match(headline, /置信度 92%|confidence 92%/);
  assert.doesNotMatch(notice.text, /0\.9/);
  // 理由单独一行且默认可见：判「可停止」时这是唯一的排查依据。
  assert.match(reasonLine, /理由|Reason/);
  assert.match(reasonLine, /已完成/);
  assert.equal(notice.details.length, 0);
});

test("判定理由是多行输出时压成一行，不把提示块撑开", () => {
  const notice = buildVerdictNotice({ kind: "stop", reason: "已完成\n且已自检", confidence: 0.9 });
  const lines = notice.text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /已完成 且已自检/);
});

test("置信度换算成整数百分比，越界与非法值收敛到 0-100", () => {
  assert.equal(formatConfidence(0.923), "92%");
  assert.equal(formatConfidence(0.9), "90%");
  assert.equal(formatConfidence(1), "100%");
  assert.equal(formatConfidence(0), "0%");
  assert.equal(formatConfidence(1.4), "100%");
  assert.equal(formatConfidence(-0.2), "0%");
  assert.equal(formatConfidence(Number.NaN), "0%");
});

test("预算用尽与判定失败：结论色不同，细节各自说明原因", () => {
  const budget = buildVerdictNotice({ kind: "skipped", code: "budget", used: 2, limit: 2, budget: "2/2" });
  assert.equal(budget.color, "dim");
  assert.equal(budget.level, "info");
  assert.match(budget.text, /2\/2/);
  assert.match(budget.details.join("\n"), /上限|exhausted/);

  const failed = buildVerdictNotice({ kind: "failed", error: "判定模型请求失败：boom" });
  assert.equal(failed.color, "error");
  assert.equal(failed.level, "error");
  assert.match(failed.text, /判定失败|judge failed/);
  // 失败详情放在展开细节里，不占正文。
  assert.match(failed.details.join("\n"), /boom/);
});

test("用户打断时明确写成「未判定」，与「判定为可停止」区分开", () => {
  const interrupted = buildInterruptedNotice();
  assert.equal(interrupted.color, "dim");
  assert.match(interrupted.text, /已打断|interrupted/);
  assert.match(interrupted.text, /未判定|not judged/);
  assert.match(interrupted.details.join("\n"), /没有调用判定模型|not called/);

  const skipped = buildVerdictNotice({ kind: "skipped", code: "canceled", used: 0, limit: 2, budget: "0/2" });
  assert.equal(skipped.text, interrupted.text);
});

test("非正常结束（失败或残缺）用另一条文案，不冒充「已打断」", () => {
  const notCompleted = buildNotCompletedNotice("error");
  assert.equal(notCompleted.color, "dim");
  assert.match(notCompleted.text, /未正常结束|did not finish/);
  assert.doesNotMatch(notCompleted.text, /已打断|interrupted/);
  assert.match(notCompleted.details.join("\n"), /error/);

  const missing = buildNotCompletedNotice(undefined);
  assert.match(missing.details.join("\n"), /缺失|missing/);
});

test("催促发送失败必须显式报错，并带出原始错误", () => {
  const failed = buildSendFailedNotice("session is gone");
  assert.equal(failed.color, "error");
  assert.equal(failed.level, "error");
  assert.match(failed.text, /发送失败|send failed/);
  assert.match(failed.details.join("\n"), /session is gone/);
});

test("结论色映射到提示级别：红→error、黄→warning、其余→info", () => {
  assert.equal(verdictNoticeLevel("error"), "error");
  assert.equal(verdictNoticeLevel("warning"), "warning");
  assert.equal(verdictNoticeLevel("success"), "info");
  assert.equal(verdictNoticeLevel("dim"), "info");
});

test("每个结论都只给一条提示：正文一行 + 细节若干行", () => {
  const notices = [
    buildVerdictNotice(CONTINUE, "继续干"),
    buildVerdictNotice({ kind: "stop", reason: "已完成", confidence: 0.9 }),
    buildVerdictNotice({ kind: "skipped", code: "budget", used: 1, limit: 1, budget: "1/1" }),
    buildVerdictNotice({ kind: "failed", error: "boom" }),
    buildInterruptedNotice(),
    buildNotCompletedNotice("aborted"),
    buildSendFailedNotice("boom"),
  ];
  for (const notice of notices) {
    assert.equal(typeof notice.text, "string");
    assert.ok(notice.text.length > 0);
    // 详情可以为空（判「可停止」时理由已经在正文里），非空时不允许出现空行。
    assert.ok(notice.details.every((line) => line.trim() !== ""));
  }
});
