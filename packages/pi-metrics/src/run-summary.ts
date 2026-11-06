/**
 * 整段运行的指标汇总
 *
 * 只在 `display: "on-stop"`（默认）下使用：一次运行里的每一轮指标边跑边累加，
 * 等 AI 完全停下（agent_settled）再合成一行，避免多轮工具调用时对话区被刷屏。
 * 累加器只保留聚合量（各字段求和 + 第一个 TTFT），不囤各轮原始记录；
 * 聚合与格式化都是纯逻辑，便于不依赖 Pi 运行时做单元测试。
 */

import { computeRateUsdPerM, formatDone, formatDuration, formatNumber } from "./format-utils.ts";
import { i18n } from "./i18n.ts";

const TPS_DECIMAL_PLACES = 1;
const RATE_DECIMAL_PLACES = 2;
const MS_PER_SECOND = 1_000;

/** 汇总需要的一轮指标；TurnTelemetry 结构上满足这个形状。 */
export interface SummaryTurn {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  timing: {
    /** 该轮从开场到第一个 token 的耗时（毫秒）。 */
    ttftMs: number | null;
    stallMs: number;
    stallCount: number;
  };
  /** 该轮 TPS；null 表示样本不足、无法测得。 */
  tps: number | null;
  /** 该轮列表价成本明细；null 表示 provider 没返回成本。 */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
}

/** 一整段运行的汇总结果。 */
export interface RunSummary {
  /** 参与汇总的轮数。 */
  turns: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /** 按输出 token 加权的混合 TPS；没有可用样本时为 null。 */
  tps: number | null;
  /** 本段第一个可测的 TTFT（毫秒），即用户等到第一个 token 的时间；没有样本时为 null。 */
  ttftMs: number | null;
  stallMs: number;
  stallCount: number;
  /** 各轮列表价成本之和；全部缺失时为 null。 */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  /** 整段每百万 token 的费率；数据不足时为 null。 */
  rateUsdPerMTokens: number | null;
}

/**
 * 整段运行的增量累加器。
 *
 * - 内存只随聚合字段数量增长，不随轮数增长：轮数再多也只留下各字段的求和值。
 * - TPS 按输出 token 加权：整段输出量 ÷ 各轮生成时间之和，不会因为某一轮输出很少就失真。
 *   单轮生成时间由该轮的 `output / tps` 反推，省得再存一份中间量。
 * - TTFT 取本段第一个可测值：用户感知的是「多久看到第一个字」。
 * - 费率只用真正计费的金额折算，避免把列表价和实际账单混在一起。
 */
export interface RunAccumulator {
  /** 累加一轮指标；effectiveCostUsd 是该轮实际计费金额（billed 优先，其次列表价）。 */
  add(turn: SummaryTurn, effectiveCostUsd?: number | null): void;
  /** 替换某一轮迟到到达的计费金额；返回是否真的改变了汇总数据。 */
  replaceBilledCost(previous: number | null, next: number): boolean;
  /** 汇总当前已累加的数据；一轮都没累加过时返回 null。 */
  summarize(): RunSummary | null;
}

/** 是否是可用的计费金额（有限、非负）。 */
function isUsableCost(value: number | null | undefined): value is number {
  return value !== undefined && value !== null && Number.isFinite(value) && value >= 0;
}

/** 造一个空的整段运行累加器。 */
export function createRunAccumulator(): RunAccumulator {
  let turns = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total = 0;
  let stallMs = 0;
  let stallCount = 0;
  let ttftMs: number | null = null;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;
  let hasCost = false;
  let billedTotal = 0;
  let hasBilled = false;
  let measuredOutput = 0;
  let generationMs = 0;

  return {
    /**
     * 累加一轮指标：更新各字段求和、第一个可测 TTFT，以及按输出 token 加权的生成时间。
     * 副作用：turns 递增；进第一个非空 TTFT 后不再被后续轮覆盖。
     */
    add(turn: SummaryTurn, effectiveCostUsd: number | null = null): void {
      turns += 1;
      input += turn.tokens.input;
      output += turn.tokens.output;
      cacheRead += turn.tokens.cacheRead;
      cacheWrite += turn.tokens.cacheWrite;
      total += turn.tokens.total;
      stallMs += turn.timing.stallMs;
      stallCount += turn.timing.stallCount;
      if (ttftMs === null && turn.timing.ttftMs !== null) ttftMs = turn.timing.ttftMs;
      if (turn.cost) {
        costInput += turn.cost.input;
        costOutput += turn.cost.output;
        costCacheRead += turn.cost.cacheRead;
        costCacheWrite += turn.cost.cacheWrite;
        costTotal += turn.cost.total;
        hasCost = true;
      }
      if (isUsableCost(effectiveCostUsd)) {
        billedTotal += effectiveCostUsd;
        hasBilled = true;
      }
      if (turn.tps !== null && turn.tps > 0 && turn.tokens.output > 0) {
        measuredOutput += turn.tokens.output;
        generationMs += (turn.tokens.output / turn.tps) * MS_PER_SECOND;
      }
    },
    /**
     * 用迟到的实际账单替换某一轮先前的计费金额。
     * 副作用：billedTotal 先减旧值再加新值，并把 hasBilled 置为 true；
     * 旧值等于新值时直接返回 false，让调用方跳过重新汇总和重发提示。
     */
    replaceBilledCost(previous: number | null, next: number): boolean {
      const previousCounted = isUsableCost(previous);
      if (previousCounted && previous === next) return false;
      if (previousCounted) billedTotal -= previous;
      billedTotal += next;
      hasBilled = true;
      return true;
    },
    /**
     * 汇总已累加的数据：算出加权 TPS 与整段费率。
     * 一轮都没累加过时返回 null，避免上层发出不带任何指标的空行。
     */
    summarize(): RunSummary | null {
      if (turns === 0) return null;
      const scale = 10 ** TPS_DECIMAL_PLACES;
      const blendedTps = measuredOutput > 0 && generationMs > 0
        ? Math.round((measuredOutput / (generationMs / MS_PER_SECOND)) * scale) / scale
        : null;
      const effectiveCost = hasBilled ? billedTotal : hasCost ? costTotal : null;
      return {
        turns,
        tokens: { input, output, cacheRead, cacheWrite, total },
        tps: blendedTps,
        ttftMs,
        stallMs,
        stallCount,
        cost: hasCost
          ? { input: costInput, output: costOutput, cacheRead: costCacheRead, cacheWrite: costCacheWrite, total: costTotal }
          : null,
        rateUsdPerMTokens: computeRateUsdPerM(effectiveCost, total),
      };
    },
  };
}

/** 合成一行整段汇总：总耗时 · TPS · TTFT · in · out · stall · 费率。 */
export function composeRunSummary(summary: RunSummary, elapsedMs: number | null): string {
  const parts: string[] = [];
  if (elapsedMs !== null && elapsedMs > 0) {
    parts.push(i18n.t("elapsedTotal", { value: formatDone(elapsedMs) }));
  }
  parts.push(summary.tps === null
    ? i18n.t("tpsUnknown")
    : i18n.t("tpsValue", { value: summary.tps.toFixed(TPS_DECIMAL_PLACES) }));
  if (summary.ttftMs !== null) {
    parts.push(i18n.t("tpsTtft", { value: formatDuration(summary.ttftMs / MS_PER_SECOND) }));
  }
  parts.push(i18n.t("tpsInput", { value: formatNumber(summary.tokens.input) }));
  parts.push(i18n.t("tpsOutput", { value: formatNumber(summary.tokens.output) }));
  if (summary.stallMs > 0) {
    parts.push(i18n.t("tpsStall", {
      value: formatDuration(summary.stallMs / MS_PER_SECOND),
      count: summary.stallCount,
    }));
  }
  if (summary.rateUsdPerMTokens !== null) {
    parts.push(i18n.t("tpsRate", { value: summary.rateUsdPerMTokens.toFixed(RATE_DECIMAL_PLACES) }));
  }
  return parts.join(" · ");
}
