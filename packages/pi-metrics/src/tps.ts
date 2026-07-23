/**
 * Token generation metrics for Pi.
 *
 * This is the TPS portion of pi-tps, maintained inside pi-metrics so the
 * elapsed-time HUD and generation telemetry share one lifecycle.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";

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

export function formatNumber(num: number): string {
  if (num < 1_000) return String(num);

  const [value, suffix] = num >= 1_000_000_000
    ? [num / 1_000_000_000, "B"]
    : num >= 1_000_000
      ? [num / 1_000_000, "M"]
      : [num / 1_000, "K"];
  const formatted = value.toFixed(1);
  return formatted.endsWith(".0") ? `${value.toFixed(0)}${suffix}` : `${formatted}${suffix}`;
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const units = [
    ["y", 365 * 24 * 60 * 60],
    ["mo", 30 * 24 * 60 * 60],
    ["w", 7 * 24 * 60 * 60],
    ["d", 24 * 60 * 60],
    ["h", 60 * 60],
    ["m", 60],
    ["s", 1],
  ] as const;
  const parts: Array<{ value: number; label: string }> = [];
  let remaining = Math.round(totalSeconds);

  for (const [label, seconds] of units) {
    if (remaining >= seconds) {
      parts.push({ value: Math.floor(remaining / seconds), label });
      remaining %= seconds;
    }
  }

  if (parts.length === 1) {
    const first = units.findIndex(([label]) => label === parts[0].label);
    let next = first + 1;
    if (parts[0].label === "mo") next++;
    if (parts[0].label === "y") next += 2;
    if (next < units.length) parts.push({ value: 0, label: units[next][0] });
  }

  return parts.slice(0, 2).map(({ value, label }) => `${value}${label}`).join(" ");
}

export function computeRateUsdPerM(costUsd: number | null, totalTokens: number): number | null {
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) return null;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  const rate = costUsd / (totalTokens / 1_000_000);
  return Number.isFinite(rate) && rate >= 0 ? Math.round(rate * 100) / 100 : null;
}

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
      schedule(() => ctx.ui.notify(composeDisplayString(data as unknown as TurnTelemetry), "info"));
      return;
    }
    if (typeof data.message === "string") {
      schedule(() => ctx.ui.notify(data.message as string, "info"));
      return;
    }
  }
}

function openDirectory(directory: string): void {
  try {
    execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [directory], {
      stdio: "ignore",
    });
  } catch {
    // Opening an export directory is optional; the path is still reported.
  }
}

function exportEntries(
  entries: SessionEntryLike[],
  full: boolean,
  filterType: string | null,
  directoryName: "pi-telemetry" | "pi-sessions",
  prefix: "pi-telemetry" | "pi-session",
  sessionId: string,
): { filepath: string; count: number } {
  const isStructural = (entry: SessionEntryLike) =>
    entry.type === "model_change" || entry.type === "branch_summary";
  const exported = entries.filter(
    (entry) => isStructural(entry) ||
      (entry.type === "custom" && (!filterType || entry.customType === filterType)),
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const exportedIds = new Set(exported.map((entry) => entry.id));
  const rechainParentId = (entry: SessionEntryLike): string | null => {
    let parentId = entry.parentId ?? null;
    while (parentId) {
      if (exportedIds.has(parentId)) return parentId;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return null;
  };
  const rechained = exported.map((entry) => ({ ...entry, parentId: rechainParentId(entry) }));
  const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const directory = join(cacheBase, directoryName);
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scope = [full ? "full" : "branch", filterType?.replace(/[^a-zA-Z0-9_-]/g, "-")]
    .filter(Boolean)
    .join("-");
  const filepath = join(directory, `${prefix}-${scope}-${sessionId.slice(0, 8)}-${timestamp}.jsonl`);
  writeFileSync(filepath, `${rechained.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  openDirectory(directory);
  return { filepath, count: exported.length };
}

export default function tpsExtension(pi: ExtensionAPI): void {
  let currentTiming: TurnTiming | null = null;
  let pendingNeuralwattBilledCost: { turnIndex: number; costUsd: number } | null = null;
  let lastCommittedTurn: {
    turnIndex: number;
    telemetry: TurnTelemetry;
    billedApplied: boolean;
    ctx: ExtensionContext;
  } | null = null;
  let cachedEntries: Array<{ type?: string; customType?: string }> = [];
  const tpsCaps = new Map<string, number>();
  const restoreTimers = new Set<ReturnType<typeof setTimeout>>();
  let unsubscribeNeuralwatt: (() => void) | undefined;

  const clearState = () => {
    currentTiming = null;
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    cachedEntries = [];
    for (const timer of restoreTimers) clearTimeout(timer);
    restoreTimers.clear();
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
    cachedEntries.push({ type: "custom", customType: "tps" });
    if (committed.ctx.hasUI) committed.ctx.ui.notify(composeDisplayString(corrected), "info");
  });

  pi.on("session_shutdown", () => {
    unsubscribeNeuralwatt?.();
    unsubscribeNeuralwatt = undefined;
    clearState();
  });

  pi.on("session_start", (_event, ctx) => {
    clearState();
    cachedEntries = ctx.sessionManager.getEntries();
    restoreTPSNotification(ctx, scheduleRestore);
  });

  pi.on("session_tree", (_event: SessionTreeEvent, ctx) => {
    pendingNeuralwattBilledCost = null;
    lastCommittedTurn = null;
    cachedEntries = ctx.sessionManager.getEntries();
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
    if (ctx.hasUI) ctx.ui.notify(composeDisplayString(telemetry), "info");
    cachedEntries.push({ type: "custom", customType: "tps" });
  });

  pi.registerCommand("tps-export", {
    description: i18n.t("tpsExportDescription"),
    getArgumentCompletions: (argumentPrefix: string) => {
      if ("--full".startsWith(argumentPrefix)) return [{ value: "--full", label: i18n.t("tpsFullFlag") }];
      const types = new Set<string>();
      for (const entry of cachedEntries) {
        if (entry.type === "custom" && entry.customType) types.add(entry.customType);
      }
      return [...types]
        .filter((customType) => customType.startsWith(argumentPrefix))
        .map((customType) => ({ value: customType, label: customType }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const full = tokens.includes("--full");
      const filterType = tokens.filter((token) => token !== "--full").join(" ") || null;
      const entries = (full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch()) as SessionEntryLike[];
      const isStructural = (entry: SessionEntryLike) => entry.type === "model_change" || entry.type === "branch_summary";
      const matching = entries.filter((entry) => isStructural(entry) ||
        (entry.type === "custom" && (!filterType || entry.customType === filterType)));
      if (matching.length === 0) {
        ctx.ui.notify(i18n.t("tpsNoEntries", { scope: full ? i18n.t("tpsAllEntries") : i18n.t("tpsCurrentBranch") }), "warning");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
      const result = exportEntries(entries, full, filterType, "pi-telemetry", "pi-telemetry", sessionId);
      ctx.ui.notify(i18n.t("tpsExported", { count: result.count, filepath: result.filepath }), "info");
    },
  });

  pi.registerCommand("session-export", {
    description: i18n.t("sessionExportDescription"),
    getArgumentCompletions: (argumentPrefix: string) =>
      "--full".startsWith(argumentPrefix) ? [{ value: "--full", label: i18n.t("tpsFullFlag") }] : [],
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const full = args.trim().split(/\s+/).includes("--full");
      const entries = (full ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch()) as SessionEntryLike[];
      if (entries.length === 0) {
        ctx.ui.notify(i18n.t("tpsNoEntries", { scope: full ? i18n.t("tpsAllEntries") : i18n.t("tpsCurrentBranch") }), "warning");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
      const result = exportEntries(entries, full, null, "pi-sessions", "pi-session", sessionId);
      ctx.ui.notify(i18n.t("tpsExported", { count: result.count, filepath: result.filepath }), "info");
    },
  });
}
