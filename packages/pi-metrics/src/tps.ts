/**
 * Token generation metrics for Pi.
 *
 * This is the TPS portion of pi-tps, maintained inside pi-metrics so the
 * elapsed-time HUD and generation telemetry share one lifecycle.
 *
 * 两种显示时机：
 * - `live`：每轮结束即出一行指标。
 * - `on-stop`（默认）：每轮只记 `tps` session entry 和事件，不动对话区；等整段运行
 *   `agent_settled` 后把各轮合成一行汇总（总耗时、混合 TPS、TTFT、in/out、成本）。
 */

import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { notifyWithSource } from "pi-extensions-i18n";
import { DEFAULT_METRICS_CONFIG, type MetricsDisplay } from "./config.ts";
import { computeRateUsdPerM, formatDuration, formatNumber } from "./format-utils.ts";
import { i18n } from "./i18n.ts";
import { NOTICE_SOURCE } from "./notice.ts";
import { composeRunSummary, createRunAccumulator, type RunAccumulator } from "./run-summary.ts";
import type { ElapsedTracker } from "./turn-elapsed.ts";

interface TurnStartEvent {
  type: "turn_start";
  turnIndex: number;
  timestamp: number;
}

interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
}

interface MessageEvent {
  type: string;
  message: unknown;
}

interface SessionTreeEvent {
  type: "session_tree";
  newLeafId: string | null;
  oldLeafId: string | null;
}

interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface TurnTelemetry {
  model: { provider: string; modelId: string };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  timing: {
    ttftMs: number | null;
    totalMs: number;
    generationMs: number;
    streamMs: number | null;
    stallMs: number;
    stallCount: number;
    messageCount: number;
  };
  tps: number | null;
  isPrimaryBranch: boolean;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  rateUsdPerMTokens: number | null;
  timestamp: number;
}

interface TurnTiming {
  turnIndex: number;
  turnStartMs: number;
  turnStartTimestamp: number;
  lastUpdateMs: number;
  firstTokenMs: number | null;
  currentMessageStartMs: number | null;
  assistantMessages: AssistantMessage[];
  totalGenerationMs: number;
  updateCount: number;
  firstStreamUpdateMs: number | null;
  lastStreamUpdateMs: number;
  stallMs: number;
  stallCount: number;
  inStall: boolean;
  messageCount: number;
  isToolCall: boolean;
  isPrimaryBranch: boolean;
}

interface SessionEntryLike {
  id: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  timestamp?: number | string;
  [key: string]: unknown;
}

const STALL_THRESHOLD_MS = 500;
const NEURALWATT_ENERGY_EVENT = "neuralwatt:turn-energy";

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  if (candidate.role !== "assistant" || typeof candidate.usage !== "object" || candidate.usage === null) {
    return false;
  }
  const usage = candidate.usage as Record<string, unknown>;
  return typeof usage.input === "number" && typeof usage.output === "number";
}

function findEnergyCostFromSession(ctx: ExtensionContext, turnStartTimestamp: number): number | null {
  const entries = ctx.sessionManager?.getEntries?.() as SessionEntryLike[] | undefined;
  if (!entries) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== "neuralwatt-energy") continue;
    const entryTimestamp = parseEntryTimestamp(entry.timestamp);
    if (Number.isFinite(entryTimestamp) && entryTimestamp < turnStartTimestamp) return null;
    const data = entry.data as Record<string, unknown> | null | undefined;
    const cost = data?.cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return cost;
  }
  return null;
}

function parseEntryTimestamp(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.parse(value);
}

function buildTelemetry(
  timing: TurnTiming,
  turnEndMs: number,
  billedCost: number | null,
): TurnTelemetry | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;
  let hasCost = false;
  let model: { provider: string; modelId: string } | null = null;

  for (const message of timing.assistantMessages) {
    const usage = message.usage;
    input += usage.input || 0;
    output += usage.output || 0;
    cacheRead += usage.cacheRead || 0;
    cacheWrite += usage.cacheWrite || 0;
    totalTokens += usage.totalTokens || 0;
    if (usage.cost) {
      costInput += usage.cost.input || 0;
      costOutput += usage.cost.output || 0;
      costCacheRead += usage.cost.cacheRead || 0;
      costCacheWrite += usage.cost.cacheWrite || 0;
      costTotal += usage.cost.total || 0;
      hasCost = true;
    }
    if (!model && message.provider && message.model) {
      model = { provider: message.provider, modelId: message.model };
    }
  }

  if (output <= 0 || timing.firstTokenMs === null || !model) return null;

  const totalMs = turnEndMs - timing.turnStartMs;
  const streamMs = timing.updateCount > 0 && timing.firstStreamUpdateMs !== null
    ? timing.lastStreamUpdateMs - timing.firstStreamUpdateMs
    : null;
  const averageGap = streamMs !== null && timing.updateCount > 1
    ? streamMs / (timing.updateCount - 1)
    : 0;

  const primary =
    streamMs !== null &&
    streamMs >= 1 &&
    timing.updateCount >= 5 &&
    averageGap >= 1 &&
    timing.stallMs < streamMs &&
    streamMs - timing.stallMs >= 200 &&
    timing.stallMs < streamMs - timing.stallMs;

  let tps: number | null;
  let isPrimaryBranch = false;
  if (primary) {
    tps = Math.round((output / ((streamMs! - timing.stallMs) / 1000)) * 10) / 10;
    isPrimaryBranch = true;
  } else if (timing.updateCount >= 2 && timing.totalGenerationMs >= 200) {
    let effectiveMs = timing.totalGenerationMs - timing.stallMs;
    if (effectiveMs < 200 || timing.stallMs > timing.totalGenerationMs * 0.85) {
      effectiveMs = Math.max(timing.totalGenerationMs - timing.stallMs / 2, 200);
    } else {
      effectiveMs = Math.max(effectiveMs, 200);
    }
    tps = Math.round((output / (effectiveMs / 1000)) * 10) / 10;
  } else {
    tps = null;
  }

  if (tps !== null && tps > 10_000) {
    tps = null;
    isPrimaryBranch = false;
  }

  const listPriceCost = hasCost && Number.isFinite(costTotal) && costTotal > 0 ? costTotal : null;
  const effectiveCost = billedCost ?? listPriceCost;
  return {
    model,
    tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
    timing: {
      ttftMs: timing.firstTokenMs - timing.turnStartMs,
      totalMs,
      generationMs: timing.totalGenerationMs,
      streamMs,
      stallMs: timing.stallMs,
      stallCount: timing.stallCount,
      messageCount: timing.messageCount,
    },
    tps,
    isPrimaryBranch,
    cost: listPriceCost === null
      ? null
      : { input: costInput, output: costOutput, cacheRead: costCacheRead, cacheWrite: costCacheWrite, total: costTotal },
    rateUsdPerMTokens: computeRateUsdPerM(effectiveCost, totalTokens),
    timestamp: Date.now(),
  };
}

function composeDisplayString(telemetry: TurnTelemetry): string {
  const parts = [
    telemetry.tps === null
      ? i18n.t("tpsUnknown")
      : i18n.t("tpsValue", { value: telemetry.tps.toFixed(1) }),
  ];
  if (telemetry.timing.ttftMs !== null) {
    parts.push(i18n.t("tpsTtft", { value: formatDuration(telemetry.timing.ttftMs / 1000) }));
  }
  parts.push(formatDuration(telemetry.timing.totalMs / 1000));
  parts.push(i18n.t("tpsInput", { value: formatNumber(telemetry.tokens.input) }));
  parts.push(i18n.t("tpsOutput", { value: formatNumber(telemetry.tokens.output) }));
  if (telemetry.timing.stallMs > 0) {
    parts.push(i18n.t("tpsStall", {
      value: formatDuration(telemetry.timing.stallMs / 1000),
      count: telemetry.timing.stallCount,
    }));
  }
  if (telemetry.rateUsdPerMTokens !== null) {
    parts.push(i18n.t("tpsRate", { value: telemetry.rateUsdPerMTokens.toFixed(2) }));
  }
  return parts.join(" · ");
}

function restoreTPSNotification(
  ctx: ExtensionContext,
  schedule: (callback: () => void) => void,
): void {
  if (!ctx.hasUI) return;
  const entries = ctx.sessionManager.getBranch() as SessionEntryLike[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== "tps") continue;
    const data = entry.data as Record<string, unknown> | null | undefined;
    if (!data) continue;
    if (typeof data.model === "object" && data.model !== null) {
      schedule(() => notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: composeDisplayString(data as unknown as TurnTelemetry) }));
      return;
    }
    if (typeof data.message === "string") {
      schedule(() => notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: data.message as string }));
      return;
    }
  }
}

/** `on-stop` 模式下与汇总相关的运行状态。 */
interface SummaryState {
  /** 本段运行的增量累加器；只保留聚合量，不囤各轮原始记录。 */
  accumulator: RunAccumulator;
  /** 发提示用的上下文。 */
  ctx: ExtensionContext;
  /** 汇总行里的整段耗时（毫秒）；运行时钟没数据时为 null。 */
  elapsedMs: number | null;
  /** 最后累加的一轮下标；没有轮时为 null。 */
  turnIndex: number | null;
  /** 最后一轮已计入的计费金额，替换旧值时要用它扣减。 */
  effectiveCostUsd: number | null;
}

/** tps 模块的可注入依赖：显示时机，以及 on-stop 模式下共用的运行时钟。 */
export interface TpsOptions {
  /** 显示时机；`live` 每轮一行，`on-stop` 只在整段停下后汇总一行。 */
  display?: MetricsDisplay;
  /** 共享的运行时钟；只在 `on-stop` 模式下用于汇总行的总耗时。 */
  tracker?: ElapsedTracker;
}

/**
 * 注册 TPS 指标事件：按 `display` 决定每轮实时出一行，还是整段停下后汇总出一行。
 */
export default function tpsExtension(pi: ExtensionAPI, options: TpsOptions = {}): void {
  const display = options.display ?? DEFAULT_METRICS_CONFIG.display;
  let currentTiming: TurnTiming | null = null;
  let pendingNeuralwattBilledCost: { turnIndex: number; costUsd: number } | null = null;
  let lastCommittedTurn: {
    turnIndex: number;
    telemetry: TurnTelemetry;
    billedApplied: boolean;
    ctx: ExtensionContext;
  } | null = null;
  /** `on-stop` 模式下本段运行的累加器，agent_settled 时出一个汇总行。 */
  let runAccumulator: RunAccumulator = createRunAccumulator();
  /** 本段运行最后累加的那一轮；只有它能收到迟到的账单。 */
  let lastRunTurn: { turnIndex: number; effectiveCostUsd: number | null } | null = null;
  /** 最近一次已经发出的汇总；账单迟到时用它重算并重发。 */
  let lastSummary: SummaryState | null = null;
  const tpsCaps = new Map<string, number>();
  const restoreTimers = new Set<ReturnType<typeof setTimeout>>();
  let unsubscribeNeuralwatt: (() => void) | undefined;

  const clearState = () => {
    currentTiming = null;
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    runAccumulator = createRunAccumulator();
    lastRunTurn = null;
    lastSummary = null;
    for (const timer of restoreTimers) clearTimeout(timer);
    restoreTimers.clear();
  };

  /**
   * 账单在汇总之后才到达时修正已发的那一行：
   * 只可能落在本段运行的最后一轮，因此用累加器替换该轮的计费金额并重发一行更正，
   * 不重发单轮指标；金额没变化时跳过重发。
   */
  const applyLateBilledCost = (turnIndex: number, costUsd: number): void => {
    const summary = lastSummary;
    // 只有已发出的那一行里的最后一轮可能收到迟到账单，其他轮一律忽略。
    if (!summary || summary.turnIndex !== turnIndex) return;
    if (!summary.accumulator.replaceBilledCost(summary.effectiveCostUsd, costUsd)) return;
    summary.effectiveCostUsd = costUsd;
    const aggregate = summary.accumulator.summarize();
    if (aggregate === null || !summary.ctx.hasUI) return;
    notifyWithSource({
      ctx: summary.ctx,
      source: NOTICE_SOURCE,
      level: "info",
      message: composeRunSummary(aggregate, summary.elapsedMs),
    });
  };

  const scheduleRestore = (callback: () => void) => {
    const timer = setTimeout(() => {
      restoreTimers.delete(timer);
      callback();
    }, 0);
    restoreTimers.add(timer);
  };

  unsubscribeNeuralwatt = pi.events?.on(NEURALWATT_ENERGY_EVENT, (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const data = payload as Record<string, unknown>;
    const turnIndex = typeof data.turnIndex === "number" ? data.turnIndex : null;
    const costUsd = typeof data.costUsd === "number" ? data.costUsd : null;
    if (turnIndex === null || costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) return;

    if (currentTiming) {
      if (currentTiming.turnIndex === turnIndex) {
        pendingNeuralwattBilledCost = { turnIndex, costUsd };
      }
      return;
    }

    const committed = lastCommittedTurn;
    if (!committed || committed.billedApplied || committed.turnIndex !== turnIndex) return;
    committed.billedApplied = true;
    const correctedRate = computeRateUsdPerM(costUsd, committed.telemetry.tokens.total);
    if (correctedRate === null || correctedRate === committed.telemetry.rateUsdPerMTokens) return;
    const corrected = { ...committed.telemetry, rateUsdPerMTokens: correctedRate };
    committed.telemetry = corrected;
    pi.appendEntry("tps", corrected);
    pi.events?.emit("tps:telemetry", corrected);
    if (display === "on-stop") {
      applyLateBilledCost(committed.turnIndex, costUsd);
      return;
    }
    if (committed.ctx.hasUI) notifyWithSource({ ctx: committed.ctx, source: NOTICE_SOURCE, level: "info", message: composeDisplayString(corrected) });
  });

  pi.on("session_shutdown", () => {
    unsubscribeNeuralwatt?.();
    unsubscribeNeuralwatt = undefined;
    clearState();
  });

  pi.on("session_start", (_event, ctx) => {
    clearState();
    restoreTPSNotification(ctx, scheduleRestore);
  });

  pi.on("session_tree", (_event: SessionTreeEvent, ctx) => {
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    runAccumulator = createRunAccumulator();
    lastRunTurn = null;
    lastSummary = null;
    restoreTPSNotification(ctx, scheduleRestore);
  });

  pi.on("turn_start", (event: TurnStartEvent) => {
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    currentTiming = {
      turnIndex: event.turnIndex,
      turnStartMs: performance.now(),
      turnStartTimestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
      lastUpdateMs: performance.now(),
      firstTokenMs: null,
      currentMessageStartMs: null,
      assistantMessages: [],
      totalGenerationMs: 0,
      updateCount: 0,
      firstStreamUpdateMs: null,
      lastStreamUpdateMs: 0,
      stallMs: 0,
      stallCount: 0,
      inStall: false,
      messageCount: 0,
      isToolCall: false,
      isPrimaryBranch: false,
    };
  });

  pi.on("message_start", (event: MessageEvent) => {
    if (!currentTiming || !isAssistantMessage(event.message)) return;
    const now = performance.now();
    currentTiming.currentMessageStartMs = now;
    currentTiming.messageCount++;
    currentTiming.lastUpdateMs = now;
    currentTiming.inStall = false;
  });

  pi.on("message_update", (event: MessageEvent) => {
    if (!currentTiming || !isAssistantMessage(event.message)) return;
    const now = performance.now();
    if (currentTiming.firstTokenMs === null) {
      currentTiming.firstTokenMs = now;
      currentTiming.lastUpdateMs = now;
      return;
    }

    currentTiming.updateCount++;
    if (currentTiming.firstStreamUpdateMs === null) currentTiming.firstStreamUpdateMs = now;
    currentTiming.lastStreamUpdateMs = now;
    const gap = now - currentTiming.lastUpdateMs;
    if (gap >= STALL_THRESHOLD_MS) {
      if (!currentTiming.inStall) currentTiming.stallCount++;
      currentTiming.inStall = true;
      currentTiming.stallMs += gap;
    } else {
      currentTiming.inStall = false;
    }
    currentTiming.lastUpdateMs = now;
  });

  pi.on("tool_execution_start", (_event: ToolExecutionStartEvent) => {
    if (currentTiming) currentTiming.isToolCall = true;
  });

  pi.on("message_end", (event: MessageEvent) => {
    if (!currentTiming || !isAssistantMessage(event.message)) return;
    const now = performance.now();
    if (currentTiming.currentMessageStartMs !== null) {
      currentTiming.totalGenerationMs += now - currentTiming.currentMessageStartMs;
      currentTiming.currentMessageStartMs = null;
    }
    currentTiming.assistantMessages.push(event.message);
    currentTiming.lastUpdateMs = now;
  });

  pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
    if (!currentTiming) return;
    const timing = currentTiming;
    currentTiming = null;
    let billedCost = pendingNeuralwattBilledCost?.turnIndex === event.turnIndex
      ? pendingNeuralwattBilledCost.costUsd
      : null;
    pendingNeuralwattBilledCost = null;
    if (billedCost === null) billedCost = findEnergyCostFromSession(ctx, timing.turnStartTimestamp);
    const telemetry = buildTelemetry(timing, performance.now(), billedCost);
    if (!telemetry) return;

    const modelKey = `${telemetry.model.provider}:${telemetry.model.modelId}`;
    if (telemetry.isPrimaryBranch && telemetry.tps !== null) {
      const currentCap = tpsCaps.get(modelKey);
      if (currentCap === undefined || telemetry.tps > currentCap) tpsCaps.set(modelKey, telemetry.tps);
    }
    if (timing.isToolCall && telemetry.tps !== null) {
      const cap = tpsCaps.get(modelKey);
      telemetry.tps = cap === undefined ? null : Math.min(telemetry.tps, cap);
    }

    lastCommittedTurn = {
      turnIndex: event.turnIndex,
      telemetry,
      billedApplied: billedCost !== null,
      ctx,
    };
    pi.appendEntry("tps", telemetry);
    pi.events?.emit("tps:telemetry", telemetry);
    if (display === "on-stop") {
      // 先累加：整段停下后只出一行汇总，多轮工具调用不会把对话区刷满。
      const effectiveCostUsd = billedCost ?? telemetry.cost?.total ?? null;
      runAccumulator.add(telemetry, effectiveCostUsd);
      lastRunTurn = { turnIndex: event.turnIndex, effectiveCostUsd };
      return;
    }
    if (ctx.hasUI) notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "info", message: composeDisplayString(telemetry) });
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (display !== "on-stop") return;
    // 运行时钟由本模块结算（live 模式下由 turn-elapsed 结算）：先取数再复位，
    // 汇总行里的总耗时就是 spinner 一直在显示的那一段。
    const settlement = options.tracker?.currentRun();
    options.tracker?.resetRun();
    const aggregate = runAccumulator.summarize();
    if (aggregate === null) return;
    const elapsedMs = settlement && settlement.elapsedMs > 0 ? settlement.elapsedMs : null;
    lastSummary = {
      accumulator: runAccumulator,
      ctx,
      elapsedMs,
      turnIndex: lastRunTurn?.turnIndex ?? null,
      effectiveCostUsd: lastRunTurn?.effectiveCostUsd ?? null,
    };
    // 本段运行已经结算：换一个空累加器，下一段运行从零开始。
    runAccumulator = createRunAccumulator();
    lastRunTurn = null;
    if (!ctx.hasUI) return;
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: "info",
      message: composeRunSummary(aggregate, elapsedMs),
    });
  });

}
