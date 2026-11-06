import assert from "node:assert/strict";
import test from "node:test";
import { composeRunSummary, createRunAccumulator, type SummaryTurn } from "../src/run-summary.ts";

/** 造一轮指标：只填汇总真正会读取的字段，其余置零或 null。 */
function makeTurn(options: {
  input: number;
  output: number;
  tps: number | null;
  ttftMs: number | null;
  costTotal?: number | null;
  stallMs?: number;
  stallCount?: number;
}): SummaryTurn {
  const costTotal = options.costTotal ?? null;
  return {
    tokens: {
      input: options.input,
      output: options.output,
      cacheRead: 0,
      cacheWrite: 0,
      total: options.input + options.output,
    },
    timing: {
      ttftMs: options.ttftMs,
      stallMs: options.stallMs ?? 0,
      stallCount: options.stallCount ?? 0,
    },
    tps: options.tps,
    cost: costTotal === null
      ? null
      : { input: costTotal / 2, output: costTotal / 2, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

test("没有累加任何一轮时不产出汇总", () => {
  assert.equal(createRunAccumulator().summarize(), null);
});

test("多轮汇总求和，TPS 按输出 token 加权，TTFT 取本段第一个可测值", () => {
  const accumulator = createRunAccumulator();
  accumulator.add(makeTurn({ input: 12_000, output: 3_000, tps: 60, ttftMs: 1_200 }));
  accumulator.add(makeTurn({ input: 14_000, output: 3_900, tps: 65, ttftMs: 900 }));

  const summary = accumulator.summarize();
  assert.ok(summary);
  assert.equal(summary.turns, 2);
  assert.deepEqual(summary.tokens, { input: 26_000, output: 6_900, cacheRead: 0, cacheWrite: 0, total: 32_900 });
  assert.equal(summary.ttftMs, 1_200);
  // 3000/60 + 3900/65 = 110s，6900 / 110 ≈ 62.7
  assert.equal(summary.tps, 62.7);
});

test("测不到 TPS 的轮不参与加权，但仍然计入 token 与 stall 合计", () => {
  const accumulator = createRunAccumulator();
  accumulator.add(makeTurn({ input: 500, output: 100, tps: null, ttftMs: 800, stallMs: 0 }));
  accumulator.add(makeTurn({ input: 1_000, output: 1_000, tps: 50, ttftMs: 700, stallMs: 500, stallCount: 1 }));

  const summary = accumulator.summarize();
  assert.ok(summary);
  assert.deepEqual(summary.tokens, { input: 1_500, output: 1_100, cacheRead: 0, cacheWrite: 0, total: 2_600 });
  assert.equal(summary.tps, 50);
  assert.equal(summary.stallMs, 500);
  assert.equal(summary.stallCount, 1);
});

test("费率只用实际计费金额折算，缺账单时回退到列表价", () => {
  const billed = createRunAccumulator();
  billed.add(makeTurn({ input: 400_000, output: 100_000, tps: 80, ttftMs: 500, costTotal: 9 }), 2);
  const billedSummary = billed.summarize();
  assert.ok(billedSummary);
  assert.equal(billedSummary.rateUsdPerMTokens, 4);

  const listPrice = createRunAccumulator();
  listPrice.add(makeTurn({ input: 400_000, output: 100_000, tps: 80, ttftMs: 500, costTotal: 9 }));
  const listSummary = listPrice.summarize();
  assert.ok(listSummary);
  assert.equal(listSummary.rateUsdPerMTokens, 18);
});

test("迟到的实际账单会替换原来的计费金额，同样的金额不再触发重算", () => {
  const accumulator = createRunAccumulator();
  accumulator.add(makeTurn({ input: 400_000, output: 100_000, tps: 80, ttftMs: 500, costTotal: 9 }), 2);

  assert.equal(accumulator.replaceBilledCost(2, 3), true);
  const replaced = accumulator.summarize();
  assert.ok(replaced);
  assert.equal(replaced.rateUsdPerMTokens, 6);

  assert.equal(accumulator.replaceBilledCost(3, 3), false);
});

test("汇总行包含总耗时和各项指标，缺少总耗时时不显示耗时段", () => {
  const accumulator = createRunAccumulator();
  accumulator.add(makeTurn({ input: 26_000, output: 6_900, tps: 62.4, ttftMs: 1_200, costTotal: 20 }), 0.42);

  const summary = accumulator.summarize();
  assert.ok(summary);
  const line = composeRunSummary(summary, 134_300);
  assert.match(line, /TPS 62\.4 tok\/s/);
  assert.match(line, /TTFT 1\.2s/);
  assert.match(line, /in 26K/);
  assert.match(line, /out 6\.9K/);
  assert.match(line, /2m 14\.3s/);
  // 实付 0.42 美元 / 32.9K token ≈ 12.77 美元每百万。
  assert.match(line, /\$12\.77\/M/);

  const withoutElapsed = composeRunSummary(summary, null);
  assert.doesNotMatch(withoutElapsed, /2m 14\.3s/);
});
