import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStatusLine, colorizeText } from "../src/status-line.ts";
import type { StopOutcome } from "../src/evaluate.ts";

/** 测试用主题：把颜色名包成可断言的标记，不依赖真实 ANSI。 */
const THEME = {
  /** 把颜色名与文本包成 `<color>text</>`，便于断言调用时用的颜色。 */
  fg: (color: string, text: string) => `<${color}>${text}</>`,
};

/** 判定为提前停止并成功发送催促时的结果。 */
const CONTINUE: StopOutcome = {
  kind: "continue",
  message: "继续干",
  reason: "只改了 1/5 个文件",
  confidence: 0.97,
  budget: "1/2",
};

test("判定为早停催停时用 warning 色并带上干预进度", () => {
  const line = buildStatusLine(CONTINUE);
  assert.equal(line?.color, "warning");
  assert.match(line?.text ?? "", /催促|continued/);
  assert.match(line?.text ?? "", /1\/2/);
});

test("判定为可以停止时用 success 色并带上置信度", () => {
  const line = buildStatusLine({ kind: "stop", reason: "已完成", confidence: 0.923 });
  assert.equal(line?.color, "success");
  assert.match(line?.text ?? "", /停止合理|stop accepted/);
  // 置信度只保留一位小数，避免页脚宽度被无意义精度占掉。
  assert.match(line?.text ?? "", /0\.9/);
  assert.doesNotMatch(line?.text ?? "", /0\.923/);
});

test("预算用尽时用 dim 色，判定失败时用 error 色", () => {
  const budget = buildStatusLine({ kind: "skipped", code: "budget", used: 2, limit: 2, budget: "2/2" });
  assert.equal(budget?.color, "dim");
  assert.match(budget?.text ?? "", /2\/2/);

  const failed = buildStatusLine({ kind: "failed", error: "判定模型请求失败：boom" });
  assert.equal(failed?.color, "error");
  assert.match(failed?.text ?? "", /判定失败|judge failed/);
});

test("状态行只放结论，不把失败详情塞进页脚", () => {
  const line = buildStatusLine({ kind: "failed", error: "判定模型返回无法解析的响应：xxx" });
  assert.doesNotMatch(line?.text ?? "", /xxx/);
});

test("只有 TUI 模式给状态行上色，其他模式保持纯文本", () => {
  const line = { text: "⚖ 已催促 1/2", color: "warning" } as const;
  assert.equal(colorizeText(line, "tui", THEME), "<warning>⚖ 已催促 1/2</>");
  assert.equal(colorizeText(line, "rpc", THEME), "⚖ 已催促 1/2");
  assert.equal(colorizeText(line, "print", THEME), "⚖ 已催促 1/2");
});
