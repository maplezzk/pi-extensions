/**
 * pi-distill 工具输出提炼扩展
 *
 * 通过 Pi 的工具事件处理所有可扩展工具的结果，并在会话启动时原地扩展
 * 最终生效工具的参数 schema。不注册同名工具，也不争夺工具所有权。
 *
 * 所有工具统一使用 outputRequest：严格传入 RAW 时返回原始输出；其他非空
 * outputRequest 表示调用提炼模型，具体保留内容由 outputRequest 决定。
 * 提炼结果超过 maxChars 时写入临时文件，只返回文件路径；最终返回内容
 * 超过 maxOutputChars 时同样写入临时文件，只把文件指针交给 Agent。
 *
 * 配置文件优先；旧环境变量继续兼容：
 * - ~/.pi/agent/extensions/pi-distill/config.json
 * - PI_DISTILL_MODEL=provider/model
 * - PI_DISTILL_MIN_CHARS=触发提炼的最小输出字符数，默认 200
 * - PI_DISTILL_MAX_CHARS=提炼结果超过此字符数时写入文件，默认 100000
 * - PI_DISTILL_MAX_OUTPUT_CHARS=最终返回内容超过此字符数时写入文件，默认 10000
 * - PI_DISTILL_TIMEOUT_SECONDS=模型调用最长等待秒数，默认 10
 * - PI_DISTILL_TIMEOUT_RETRY_COUNT=提炼超时后的额外重试次数，默认 1；0 表示不重试
 * - PI_DISTILL_ERROR_RETRY_COUNT=其他异常后的额外重试次数，默认 1；0 表示不重试
 * - PI_DISTILL_MISSED_COMPRESSION_RATIO=长输出提醒倍数，默认 10
 * - 旧 PI_BASH_SUMMARY_* 变量作为兼容回退
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";
import {
  appendDistillFallbackAudit,
  registerDistillFallbackRenderer,
} from "./fallback-renderer.ts";
import {
  isDistillToolDisplayMiddlewareActive,
  registerDistillToolDisplayMiddleware,
} from "./tool-display-bridge.ts";
import { getTextContent, hasNonTextContent, limitReturnedToolResult } from "./output-limit.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import {
  buildSummaryPrompt,
  buildSummarySystemPrompt,
  buildSummaryUserPrompt,
  decideOutputSummary,
  getDistillConfigPath,
  isRawSummary,
  isDistillToolEnabled,
  loadDistillConfig,
  MIN_EFFECTIVE_COMPRESSION_RATIO,
  shouldFallbackToOriginal,
  type BashSummaryConfig,
  type DistillConfigFile,
  type DistillRenderConfig,
  type DistillToolConfig,
  type OutputSummaryDecision,
} from "./summary-utils.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

type ToolResult = {
  content: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  details?: {
    fullOutputPath?: string;
    [key: string]: unknown;
  };
};

type DistillExecutionContext = {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  originalUserPrompt?: string;
  signal?: AbortSignal;
  ctx: ExtensionContext;
};

type PendingDistillCall = {
  enabled: boolean;
  outputRequest: string;
  originalUserPrompt?: string;
  startedAt: number;
};

type OutputRequestSchemaState = {
  hadProperties: boolean;
  hadOutputRequest: boolean;
  originalOutputRequest?: unknown;
  hadRequired: boolean;
  originalRequired?: unknown;
};

const outputRequestSchemaStates = new WeakMap<object, OutputRequestSchemaState>();

type ToolResultEventPatch = {
  content?: ToolResultEvent["content"];
  details?: unknown;
  isError?: boolean;
};

export const OUTPUT_REQUEST_DESCRIPTION = i18n.t("outputRequestDescription");
const OUTPUT_REQUEST_SYSTEM_GUIDELINE = i18n.t("outputRequestSystemGuideline");

type SummaryDecisionMode = "RAW" | "SUMMARY";
type SummaryReasonCode =
  | "VERBATIM_REQUEST"
  | "SELECTED_INFORMATION"
  | "FIELD_EXTRACTION"
  | "ERROR_EXTRACTION"
  | "SECURITY_BOUNDARY"
  | "OTHER";

type SummaryDecision = {
  mode: SummaryDecisionMode;
  reasonCode: SummaryReasonCode;
  reason: string;
};

type SummaryUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

type SummaryResult = {
  text: string;
  summaryChars: number;
  summaryFilePath?: string;
  summaryModel: string;
  decision: SummaryDecision;
  usage?: SummaryUsage;
  attempts?: number;
};

type SummaryCompletion = (...args: Parameters<typeof complete>) => ReturnType<typeof complete>;

class SummaryAttemptError extends Error {
  constructor(message: string, readonly usage?: SummaryUsage) {
    super(message);
    this.name = "SummaryAttemptError";
  }
}

class SummaryRetryError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly usage?: SummaryUsage,
  ) {
    super(message);
    this.name = "SummaryRetryError";
  }
}

type SummaryDiagnostics = {
  toolExecutionMs?: number;
  summaryDurationMs?: number;
  summaryAttempts?: number;
  summaryInputTokens?: number;
  summaryOutputTokens?: number;
  summaryReasoningTokens?: number;
  summaryCacheReadTokens?: number;
  summaryCacheWriteTokens?: number;
  summaryTotalTokens?: number;
  summaryCost?: number;
  /** 原始输出与最终摘要的 Token 数是按 Pi 的 chars/4 规则估算的。 */
  estimatedOriginalOutputTokens?: number;
  estimatedSummaryTokens?: number;
  estimatedTokensSaved?: number;
  outputSummaryIntent?: string;
  outputSummaryPrompt?: string;
  outputSummaryRender?: DistillRenderConfig;
  outputSummaryStatus?: string;
  outputSummaryAnomalies?: string[];
  outputSummaryAdvice?: string;
  /** 仅供 TUI 展示的底层错误，不追加到 Agent 可见 content。 */
  outputSummaryError?: string;
  outputSummaryDecisionMode?: SummaryDecisionMode;
  outputSummaryReasonCode?: SummaryReasonCode;
  outputSummaryReason?: string;
  summaryModel?: string;
  originalOutputChars?: number;
  summaryChars?: number;
  compressionRatio?: number;
  compressionSavedPercent?: number;
  summaryTriggerMinChars?: number;
  summaryTriggerMaxChars?: number | null;
  summaryResultMaxChars?: number;
  missedCompressionRatio?: number;
};

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSummaryUsage(value: unknown): SummaryUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage: SummaryUsage = {
    input: toFiniteNumber(record.input),
    output: toFiniteNumber(record.output),
    reasoning: toFiniteNumber(record.reasoning),
    cacheRead: toFiniteNumber(record.cacheRead),
    cacheWrite: toFiniteNumber(record.cacheWrite),
    totalTokens: toFiniteNumber(record.totalTokens),
  };
  if (record.cost && typeof record.cost === "object" && !Array.isArray(record.cost)) {
    const cost = record.cost as Record<string, unknown>;
    usage.cost = {
      input: toFiniteNumber(cost.input),
      output: toFiniteNumber(cost.output),
      reasoning: toFiniteNumber(cost.reasoning),
      cacheRead: toFiniteNumber(cost.cacheRead),
      cacheWrite: toFiniteNumber(cost.cacheWrite),
      total: toFiniteNumber(cost.total),
    };
  }
  return Object.values(usage).some((entry) => typeof entry === "number") || usage.cost !== undefined
    ? usage
    : undefined;
}

function mergeSummaryUsage(first: SummaryUsage | undefined, second: SummaryUsage | undefined): SummaryUsage | undefined {
  if (!first && !second) return undefined;
  const merged: SummaryUsage = {};
  for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const value = (first?.[key] ?? 0) + (second?.[key] ?? 0);
    if ((first?.[key] !== undefined || second?.[key] !== undefined) && Number.isFinite(value)) {
      merged[key] = value;
    }
  }
  if (first?.cost || second?.cost) {
    merged.cost = {};
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const) {
      const value = (first?.cost?.[key] ?? 0) + (second?.cost?.[key] ?? 0);
      if ((first?.cost?.[key] !== undefined || second?.cost?.[key] !== undefined) && Number.isFinite(value)) {
        merged.cost[key] = value;
      }
    }
  }
  return merged;
}

function getSummaryUsageDiagnostics(usage: SummaryUsage | undefined): Pick<
  SummaryDiagnostics,
  "summaryInputTokens" | "summaryOutputTokens" | "summaryReasoningTokens" | "summaryCacheReadTokens" | "summaryCacheWriteTokens" | "summaryTotalTokens" | "summaryCost"
> {
  return {
    summaryInputTokens: usage?.input,
    summaryOutputTokens: usage?.output,
    summaryReasoningTokens: usage?.reasoning,
    summaryCacheReadTokens: usage?.cacheRead,
    summaryCacheWriteTokens: usage?.cacheWrite,
    summaryTotalTokens: usage?.totalTokens,
    summaryCost: usage?.cost?.total,
  };
}

const ESTIMATED_CHARS_PER_TOKEN = 4;

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

function getTokenCompressionDiagnostics(
  originalOutput: string,
  finalOutput: string,
): Pick<SummaryDiagnostics, "estimatedOriginalOutputTokens" | "estimatedSummaryTokens" | "estimatedTokensSaved"> {
  const estimatedOriginalOutputTokens = estimateTextTokens(originalOutput);
  const estimatedSummaryTokens = estimateTextTokens(finalOutput);
  return {
    estimatedOriginalOutputTokens,
    estimatedSummaryTokens,
    estimatedTokensSaved: Math.max(0, estimatedOriginalOutputTokens - estimatedSummaryTokens),
  };
}

type DistillSessionStats = {
  startedAt: number;
  toolResults: number;
  summarizedResults: number;
  fallbackResults: number;
  failedResults: number;
  rawResults: number;
  skippedResults: number;
  nonTextResults: number;
  summaryAttempts: number;
  retryCount: number;
  originalOutputChars: number;
  summaryChars: number;
  summaryDurationMs: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryReasoningTokens: number;
  summaryCacheReadTokens: number;
  summaryCacheWriteTokens: number;
  summaryTotalTokens: number;
  hasSummaryTokenUsage: boolean;
  estimatedOriginalOutputTokens: number;
  estimatedSummaryTokens: number;
  estimatedTokensSaved: number;
  summaryCost: number;
  hasSummaryCost: boolean;
};

function createDistillSessionStats(): DistillSessionStats {
  return {
    startedAt: Date.now(),
    toolResults: 0,
    summarizedResults: 0,
    fallbackResults: 0,
    failedResults: 0,
    rawResults: 0,
    skippedResults: 0,
    nonTextResults: 0,
    summaryAttempts: 0,
    retryCount: 0,
    originalOutputChars: 0,
    summaryChars: 0,
    summaryDurationMs: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    summaryReasoningTokens: 0,
    summaryCacheReadTokens: 0,
    summaryCacheWriteTokens: 0,
    summaryTotalTokens: 0,
    hasSummaryTokenUsage: false,
    estimatedOriginalOutputTokens: 0,
    estimatedSummaryTokens: 0,
    estimatedTokensSaved: 0,
    summaryCost: 0,
    hasSummaryCost: false,
  };
}

function getDetailNumber(details: Record<string, unknown> | undefined, key: string): number | undefined {
  return toFiniteNumber(details?.[key]);
}

function recordDistillSessionResult(
  stats: DistillSessionStats,
  details: Record<string, unknown> | undefined,
): void {
  stats.toolResults += 1;
  const status = typeof details?.outputSummaryStatus === "string"
    ? details.outputSummaryStatus
    : undefined;
  if (status === "summarized") stats.summarizedResults += 1;
  else if (status === "summary-fallback") stats.fallbackResults += 1;
  else if (status === "summary-failed") stats.failedResults += 1;
  else if (status === "full-output") stats.rawResults += 1;
  else if (status === "non-text-output") stats.nonTextResults += 1;
  else stats.skippedResults += 1;

  stats.summaryAttempts += getDetailNumber(details, "summaryAttempts") ?? 0;
  const attempts = getDetailNumber(details, "summaryAttempts");
  if (attempts !== undefined) stats.retryCount += Math.max(0, attempts - 1);
  stats.originalOutputChars += getDetailNumber(details, "originalOutputChars") ?? 0;
  stats.summaryChars += getDetailNumber(details, "summaryChars") ?? 0;
  stats.summaryDurationMs += getDetailNumber(details, "summaryDurationMs") ?? 0;
  stats.summaryInputTokens += getDetailNumber(details, "summaryInputTokens") ?? 0;
  stats.summaryOutputTokens += getDetailNumber(details, "summaryOutputTokens") ?? 0;
  stats.summaryReasoningTokens += getDetailNumber(details, "summaryReasoningTokens") ?? 0;
  stats.summaryCacheReadTokens += getDetailNumber(details, "summaryCacheReadTokens") ?? 0;
  stats.summaryCacheWriteTokens += getDetailNumber(details, "summaryCacheWriteTokens") ?? 0;
  const summaryTotalTokens = getDetailNumber(details, "summaryTotalTokens");
  if (summaryTotalTokens !== undefined) {
    stats.summaryTotalTokens += summaryTotalTokens;
  }
  if (
    getDetailNumber(details, "summaryInputTokens") !== undefined
    || getDetailNumber(details, "summaryOutputTokens") !== undefined
    || getDetailNumber(details, "summaryTotalTokens") !== undefined
  ) {
    stats.hasSummaryTokenUsage = true;
  }
  stats.estimatedOriginalOutputTokens += getDetailNumber(details, "estimatedOriginalOutputTokens") ?? 0;
  stats.estimatedSummaryTokens += getDetailNumber(details, "estimatedSummaryTokens") ?? 0;
  stats.estimatedTokensSaved += getDetailNumber(details, "estimatedTokensSaved") ?? 0;
  const cost = getDetailNumber(details, "summaryCost");
  if (cost !== undefined) {
    stats.summaryCost += cost;
    stats.hasSummaryCost = true;
  }
}

export function formatCompactCount(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const formatScaled = (scaled: number): string => {
    const rounded = Math.round(scaled * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };
  if (absolute >= 1_000_000) return `${sign}${formatScaled(absolute / 1_000_000)}m`;
  if (absolute >= 1_000) return `${sign}${formatScaled(absolute / 1_000)}k`;
  return String(Math.round(value));
}

export function formatSessionDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(1).replace(/\.0$/, "")}min`;
}

function formatDistillSessionStats(stats: DistillSessionStats): string {
  const compressionRatio = stats.summaryChars > 0
    ? (stats.originalOutputChars / stats.summaryChars).toFixed(2)
    : "-";
  const cost = stats.hasSummaryCost ? stats.summaryCost.toFixed(6) : i18n.t("statsUnavailable");
  const summaryOperations = stats.summarizedResults
    + stats.fallbackResults
    + stats.failedResults
    + stats.rawResults;
  const averageDurationMs = summaryOperations > 0
    ? Math.round(stats.summaryDurationMs / summaryOperations)
    : 0;
  const tokenUsage = stats.hasSummaryTokenUsage
    ? {
        input: formatCompactCount(stats.summaryInputTokens),
        output: formatCompactCount(stats.summaryOutputTokens),
        reasoning: formatCompactCount(stats.summaryReasoningTokens),
        cacheRead: formatCompactCount(stats.summaryCacheReadTokens),
        cacheWrite: formatCompactCount(stats.summaryCacheWriteTokens),
        total: formatCompactCount(stats.summaryTotalTokens),
      }
    : {
        input: i18n.t("statsUnavailable"),
        output: i18n.t("statsUnavailable"),
        reasoning: i18n.t("statsUnavailable"),
        cacheRead: i18n.t("statsUnavailable"),
        cacheWrite: i18n.t("statsUnavailable"),
        total: i18n.t("statsUnavailable"),
      };
  return i18n.t("statsReport", {
    toolResults: formatCompactCount(stats.toolResults),
    summarizedResults: formatCompactCount(stats.summarizedResults),
    fallbackResults: formatCompactCount(stats.fallbackResults),
    failedResults: formatCompactCount(stats.failedResults),
    rawResults: formatCompactCount(stats.rawResults),
    skippedResults: formatCompactCount(stats.skippedResults),
    nonTextResults: formatCompactCount(stats.nonTextResults),
    summaryAttempts: formatCompactCount(stats.summaryAttempts),
    retryCount: formatCompactCount(stats.retryCount),
    originalOutputChars: formatCompactCount(stats.originalOutputChars),
    summaryChars: formatCompactCount(stats.summaryChars),
    compressionRatio,
    estimatedOriginalOutputTokens: formatCompactCount(stats.estimatedOriginalOutputTokens),
    estimatedSummaryTokens: formatCompactCount(stats.estimatedSummaryTokens),
    estimatedTokensSaved: formatCompactCount(stats.estimatedTokensSaved),
    summaryDuration: formatSessionDuration(stats.summaryDurationMs),
    summaryAverageDuration: formatSessionDuration(averageDurationMs),
    summaryInputTokens: tokenUsage.input,
    summaryOutputTokens: tokenUsage.output,
    summaryReasoningTokens: tokenUsage.reasoning,
    summaryCacheReadTokens: tokenUsage.cacheRead,
    summaryCacheWriteTokens: tokenUsage.cacheWrite,
    summaryTotalTokens: tokenUsage.total,
    summaryCost: cost,
  });
}

function attachDiagnostics(result: ToolResult, diagnostics: SummaryDiagnostics): ToolResult {
  return {
    ...result,
    details: {
      ...(result.details ?? {}),
      ...diagnostics,
    },
  };
}

function getCompressionDiagnostics(
  intent: string,
  originalOutputChars: number,
  summaryChars: number,
): Pick<SummaryDiagnostics, "compressionRatio" | "compressionSavedPercent" | "outputSummaryAnomalies" | "outputSummaryAdvice"> {
  const compressionRatio = summaryChars > 0 ? originalOutputChars / summaryChars : undefined;
  const compressionSavedPercent = compressionRatio === undefined
    ? undefined
    : Math.max(0, 1 - summaryChars / originalOutputChars) * 100;
  const anomalies: string[] = [];

  if (intent === "full") {
    anomalies.push("unexpected-compression");
  }
  if (compressionRatio !== undefined && compressionRatio < MIN_EFFECTIVE_COMPRESSION_RATIO) {
    anomalies.push("ineffective-compression");
  }

  return {
    compressionRatio,
    compressionSavedPercent,
    outputSummaryAnomalies: anomalies.length > 0 ? anomalies : undefined,
    outputSummaryAdvice: anomalies.length > 0
      ? "Warning: summarization ran but saved little context, which may indicate the wrong handling mode. Use strict RAW when the exact original is required; use a clearer, more compression-oriented prompt when summarization is intended."
      : undefined,
  };
}

function getSkippedSummaryDiagnostics(
  decision: OutputSummaryDecision,
  outputChars: number | undefined,
  config: BashSummaryConfig,
): Pick<SummaryDiagnostics, "outputSummaryAnomalies" | "outputSummaryAdvice" | "missedCompressionRatio"> {
  if (
    outputChars === undefined ||
    outputChars < config.minChars * config.missedCompressionRatio
  ) {
    return {};
  }

  if (decision.intent === "none") {
    return {
      missedCompressionRatio: config.missedCompressionRatio,
      outputSummaryAnomalies: ["missed-compression"],
      outputSummaryAdvice:
        `Warning: this output has ${outputChars} chars, reaching ${config.missedCompressionRatio}x the summary threshold, but no summary prompt was provided. Use a non-RAW prompt unless the exact original is required; use strict RAW in that case.`,
    };
  }

  if (decision.intent === "full") {
    return {
      missedCompressionRatio: config.missedCompressionRatio,
      outputSummaryAdvice:
        `This output has ${outputChars} chars, reaching ${config.missedCompressionRatio}x the summary threshold. RAW handling was selected, so the original was preserved without summarization. Use a compression-oriented prompt next time if the exact original is not required; use strict RAW in that case.`,
    };
  }

  return {};
}

function buildAgentDiagnosticText(diagnostics: SummaryDiagnostics): string | undefined {
  if (!diagnostics.outputSummaryAdvice && !diagnostics.outputSummaryAnomalies?.length) {
    return undefined;
  }

  const lines = [
    diagnostics.outputSummaryAnomalies?.length
      ? "[Output handling error — action required]"
      : "[Output handling diagnostics]",
  ];
  if (diagnostics.originalOutputChars !== undefined) {
    lines.push(`Original chars: ${diagnostics.originalOutputChars}`);
  }
  if (diagnostics.summaryChars !== undefined) {
    lines.push(`Summary chars: ${diagnostics.summaryChars}`);
  }
  if (diagnostics.compressionRatio !== undefined) {
    lines.push(`Compression ratio: ${diagnostics.compressionRatio.toFixed(2)}x`);
  }
  if (diagnostics.compressionSavedPercent !== undefined) {
    lines.push(`Context saved: ${diagnostics.compressionSavedPercent.toFixed(1)}%`);
  }
  if (diagnostics.missedCompressionRatio !== undefined) {
    lines.push(`Long-output threshold: ${diagnostics.missedCompressionRatio.toFixed(1)}x`);
  }
  if (diagnostics.outputSummaryAnomalies?.length) {
    lines.push(`Anomalies: ${diagnostics.outputSummaryAnomalies.join(", ")}`);
  }
  if (diagnostics.outputSummaryAdvice) {
    lines.push(`Advice: ${diagnostics.outputSummaryAdvice}`);
  }
  return lines.join("\n");
}

async function getCompleteOutput(result: ToolResult): Promise<string> {
  const fullOutputPath = result.details?.fullOutputPath;
  if (fullOutputPath) {
    return readFile(fullOutputPath, "utf8");
  }
  return getTextContent(result);
}

async function writeSummaryFile(summary: string): Promise<string> {
  const directory = join(tmpdir(), "pi-distill");
  await mkdir(directory, { recursive: true });
  const filePath = join(
    directory,
    `summary-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  await writeFile(filePath, summary, "utf8");
  return filePath;
}

function parseSummaryResponse(text: string, summaryModel: string): SummaryResult {
  const normalizedText = unwrapJsonCodeFence(text);
  let payload: unknown;
  try {
    payload = JSON.parse(normalizedText);
  } catch (error) {
    throw new Error(`Summarizer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Summarizer response must be a JSON object");
  }
  const record = payload as Record<string, unknown>;
  const decision = record.decision;
  const summary = record.summary;
  if (!decision || typeof decision !== "object" || typeof summary !== "string") {
    throw new Error("Summarizer response must contain decision and summary");
  }
  const decisionRecord = decision as Record<string, unknown>;
  const mode = decisionRecord.mode;
  const reasonCode = decisionRecord.reasonCode;
  const reason = decisionRecord.reason;
  const validReasonCodes: SummaryReasonCode[] = [
    "VERBATIM_REQUEST",
    "SELECTED_INFORMATION",
    "FIELD_EXTRACTION",
    "ERROR_EXTRACTION",
    "SECURITY_BOUNDARY",
    "OTHER",
  ];
  if (mode !== "RAW" && mode !== "SUMMARY") {
    throw new Error("Summarizer decision.mode must be RAW or SUMMARY");
  }
  if (!validReasonCodes.includes(reasonCode as SummaryReasonCode)) {
    throw new Error("Summarizer decision.reasonCode is invalid");
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 160) {
    throw new Error("Summarizer decision.reason must be 1-160 characters");
  }
  if (mode === "RAW" && summary !== "") {
    throw new Error("Summarizer RAW decision must have an empty summary");
  }
  if (mode === "SUMMARY" && summary.trim().length === 0) {
    throw new Error("Summarizer SUMMARY decision must have a non-empty summary");
  }

  const parsedDecision: SummaryDecision = {
    mode,
    reasonCode: reasonCode as SummaryReasonCode,
    reason,
  };
  return {
    text: summary,
    summaryChars: summary.length,
    summaryModel,
    decision: parsedDecision,
  };
}

/** 兼容模型用 Markdown JSON 代码围栏包裹结构化响应的常见输出格式。 */
function unwrapJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(`{3,})[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i);
  return match?.[2]?.trim() ?? trimmed;
}

async function summarizeOutput(
  prompt: string,
  output: string,
  config: BashSummaryConfig,
  context: DistillExecutionContext,
  signal: AbortSignal,
  completion: SummaryCompletion = complete,
): Promise<SummaryResult> {
  const model = config.modelProvider && config.modelId
    ? context.ctx.modelRegistry.find(config.modelProvider, config.modelId)
    : context.ctx.model;
  if (!model) {
    throw new Error(
      "No model is available in the current session. Select a session model or set PI_BASH_SUMMARY_MODEL=provider/model.",
    );
  }

  const auth = await context.ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (auth.ok === false) throw new Error(`Summarizer authentication failed: ${auth.error}`);

  const response = await completion(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{
            type: "text",
            text: [
              buildSummarySystemPrompt(),
              "",
              buildSummaryUserPrompt(prompt, output, context.originalUserPrompt),
            ].join("\n"),
          }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens: Math.max(256, Math.ceil(config.maxChars / 2)),
      signal,
    },
  );

  const usage = normalizeSummaryUsage(response.usage);
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new SummaryAttemptError(
      response.errorMessage ?? `Summarizer stopped with reason: ${response.stopReason}`,
      usage,
    );
  }

  const rawResponse = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();

  if (!rawResponse) throw new SummaryAttemptError("Summarizer returned no text", usage);
  const summaryModel = `${model.provider}/${model.id}`;
  let parsed: SummaryResult;
  try {
    parsed = parseSummaryResponse(rawResponse, summaryModel);
  } catch (error) {
    throw new SummaryAttemptError(error instanceof Error ? error.message : String(error), usage);
  }
  if (parsed.decision.mode === "RAW") return { ...parsed, usage };
  if (parsed.summaryChars <= config.maxChars) return { ...parsed, usage };

  const summaryFilePath = await writeSummaryFile(parsed.text);
  return {
    ...parsed,
    text: `Summary exceeded ${config.maxChars} chars and was written to: ${summaryFilePath}`,
    summaryFilePath,
    usage,
  };
}

async function summarizeOutputWithRetries(
  prompt: string,
  output: string,
  config: BashSummaryConfig,
  context: DistillExecutionContext,
  completion: SummaryCompletion,
): Promise<SummaryResult> {
  let timeoutRetries = 0;
  let errorRetries = 0;
  let attempts = 0;
  let totalUsage: SummaryUsage | undefined;

  while (true) {
    if (context.signal?.aborted) {
      throw new SummaryRetryError("Summarization aborted", attempts, totalUsage);
    }

    const attemptController = new AbortController();
    const abortFromParent = () => attemptController.abort();
    context.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (context.signal?.aborted) attemptController.abort();
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        attemptController.abort();
      },
      config.timeoutSeconds * 1000,
    );
    attempts += 1;

    try {
      const result = await summarizeOutput(
        prompt,
        output,
        config,
        context,
        attemptController.signal,
        completion,
      );
      totalUsage = mergeSummaryUsage(totalUsage, result.usage);
      return {
        ...result,
        usage: totalUsage,
        attempts,
      };
    } catch (error) {
      totalUsage = mergeSummaryUsage(
        totalUsage,
        error instanceof SummaryAttemptError || error instanceof SummaryRetryError
          ? error.usage
          : undefined,
      );
      if (context.signal?.aborted) {
        throw new SummaryRetryError("Summarization aborted", attempts, totalUsage);
      }
      const retryLimit = timedOut ? config.timeoutRetryCount : config.errorRetryCount;
      const retriesUsed = timedOut ? timeoutRetries : errorRetries;
      if (retriesUsed >= retryLimit) {
        throw new SummaryRetryError(
          error instanceof Error ? error.message : String(error),
          attempts,
          totalUsage,
        );
      }
      if (timedOut) timeoutRetries += 1;
      else errorRetries += 1;
      console.warn(i18n.t("retryingSummary", {
        kind: i18n.t(timedOut ? "retryKindTimeout" : "retryKindError"),
        retry: retriesUsed + 1,
        limit: retryLimit,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abortFromParent);
    }
  }
}

function getOutputRequest(params: Record<string, unknown>): string {
  return typeof params.outputRequest === "string"
    ? params.outputRequest.trim()
    : "";
}

export async function processToolResult(
  context: DistillExecutionContext,
  result: ToolResult,
  toolExecutionMs: number,
  completion: SummaryCompletion = complete,
): Promise<ToolResult> {
  const prompt = getOutputRequest(context.params);
  const loaded = loadDistillConfig();
  const config = loaded.config;
  const outputSummaryRender = { ...loaded.render };
  // Pi may persist raw tool output before this hook runs. This second limit
  // protects the post-distillation result, including RAW and fallbacks.
  const maxReturnedChars = config?.maxOutputChars ?? 10_000;
  const finish = (candidate: ToolResult) => limitReturnedToolResult(candidate, maxReturnedChars);
  if (loaded.warnings.length > 0) {
    console.warn(`[pi-distill] ${loaded.warnings.join(" | ")}`);
  }

  if (config && loaded.enabled && !isDistillToolEnabled(config, context.toolName)) return result;

  if (hasNonTextContent(result)) {
    return attachDiagnostics(result, {
      toolExecutionMs,
      outputSummaryPrompt: prompt || undefined,
      outputSummaryRender,
      outputSummaryStatus: "non-text-output",
    });
  }

  if (!config || !loaded.enabled) {
    const diagnostics: SummaryDiagnostics = {
      toolExecutionMs,
      outputSummaryPrompt: prompt || undefined,
      outputSummaryRender,
      outputSummaryStatus: loaded.enabled ? "disabled" : "disabled-by-config",
      outputSummaryAdvice: loaded.warnings.length > 0
        ? `Distill is disabled: ${loaded.warnings.join(" ")}`
        : loaded.enabled
          ? "Distill is disabled: invalid configuration. Check /config:distill."
          : "Distill is disabled by configuration.",
    };
    const agentDiagnostic = buildAgentDiagnosticText(diagnostics);
    return finish({
      ...attachDiagnostics(result, diagnostics),
      content: agentDiagnostic
        ? [...result.content, { type: "text", text: agentDiagnostic }]
        : result.content,
    });
  }

  let output: string;
  try {
    output = await getCompleteOutput(result);
  } catch (error) {
    console.warn(
      `[tool-output-summary] ${context.toolName} could not read the full output; returning the original result: ${error instanceof Error ? error.message : String(error)}`,
    );
    return finish(attachDiagnostics(result, {
      toolExecutionMs,
      outputSummaryPrompt: prompt || undefined,
      outputSummaryRender,
      outputSummaryStatus: "diagnostic-failed",
      summaryTriggerMinChars: config.minChars,
      summaryTriggerMaxChars: null,
      summaryResultMaxChars: config.maxChars,
      missedCompressionRatio: config.missedCompressionRatio,
    }));
  }

  const decision = decideOutputSummary(prompt, output, config, result.isError === true);
  if (!decision.shouldSummarize) {
    const skippedDiagnostics = getSkippedSummaryDiagnostics(decision, output.length, config);
    const diagnostics: SummaryDiagnostics = {
      toolExecutionMs,
      originalOutputChars: output.length,
      outputSummaryIntent: decision.intent,
      outputSummaryPrompt: prompt || undefined,
      outputSummaryRender,
      outputSummaryStatus: decision.reason,
      summaryTriggerMinChars: config.minChars,
      summaryTriggerMaxChars: null,
      summaryResultMaxChars: config.maxChars,
      missedCompressionRatio: config.missedCompressionRatio,
      ...getTokenCompressionDiagnostics(output, output),
      ...skippedDiagnostics,
    };
    const candidate = {
      ...attachDiagnostics(result, diagnostics),
      content: result.content,
    };
    return finish(candidate);
  }

  const summaryStartedAt = performance.now();
  try {
    const summarized = await summarizeOutputWithRetries(
      prompt,
      output,
      config,
      context,
      completion,
    );
    const summaryDurationMs = Math.round(performance.now() - summaryStartedAt);
    if (summarized.decision.mode === "RAW") {
      // RAW 是总结模型的控制哨兵，不是要交给 Agent 的正文；原文仍通过同一条 final limiter。
      const rawDecision: OutputSummaryDecision = {
        intent: "full",
        shouldSummarize: false,
        reason: "full-output",
      };
      const rawDiagnostics = getSkippedSummaryDiagnostics(rawDecision, output.length, config);
      const diagnostics: SummaryDiagnostics = {
        originalOutputChars: output.length,
        summaryChars: output.length,
        summaryAttempts: summarized.attempts,
        ...getSummaryUsageDiagnostics(summarized.usage),
        ...getTokenCompressionDiagnostics(output, output),
        compressionRatio: 1,
        compressionSavedPercent: 0,
        ...rawDiagnostics,
      };
      const candidate = {
        ...attachDiagnostics(result, {
          toolExecutionMs,
          summaryDurationMs,
          outputSummaryIntent: "full",
          outputSummaryPrompt: prompt || undefined,
          outputSummaryRender,
          outputSummaryStatus: "full-output",
          summaryTriggerMinChars: config.minChars,
          summaryTriggerMaxChars: null,
          summaryResultMaxChars: config.maxChars,
          missedCompressionRatio: config.missedCompressionRatio,
          summaryModel: summarized.summaryModel,
          outputSummaryDecisionMode: summarized.decision.mode,
          outputSummaryReasonCode: summarized.decision.reasonCode,
          outputSummaryReason: summarized.decision.reason,
          ...diagnostics,
        }),
        content: [{ type: "text", text: output }],
      };
      return finish(candidate);
    }
    const compressionDiagnostics = getCompressionDiagnostics(
      decision.intent,
      output.length,
      summarized.summaryChars,
    );
    const summaryDiagnostics: SummaryDiagnostics = {
      originalOutputChars: output.length,
      summaryChars: summarized.summaryChars,
      summaryAttempts: summarized.attempts,
      ...getSummaryUsageDiagnostics(summarized.usage),
      ...getTokenCompressionDiagnostics(output, summarized.text),
      ...compressionDiagnostics,
    };
    const agentDiagnostic = buildAgentDiagnosticText(summaryDiagnostics);

    if (shouldFallbackToOriginal(output.length, summarized.summaryChars)) {
      return finish({
        ...attachDiagnostics(result, {
          toolExecutionMs,
          summaryDurationMs,
          outputSummaryIntent: decision.intent,
          outputSummaryPrompt: prompt || undefined,
          outputSummaryRender,
          outputSummaryStatus: "summary-fallback",
          summaryTriggerMinChars: config.minChars,
          summaryTriggerMaxChars: null,
          summaryResultMaxChars: config.maxChars,
          missedCompressionRatio: config.missedCompressionRatio,
          summaryModel: summarized.summaryModel,
          outputSummaryDecisionMode: summarized.decision.mode,
          outputSummaryReasonCode: summarized.decision.reasonCode,
          outputSummaryReason: summarized.decision.reason,
          ...summaryDiagnostics,
          ...getTokenCompressionDiagnostics(output, output),
        }),
        content: [{ type: "text", text: output }],
      });
    }

    return finish({
      // 输出处理参数只影响结果上下文，不改变原工具的业务执行。
      // 异常诊断额外作为文本传给 Agent；普通成功总结不增加噪音。
      content: [
        { type: "text", text: summarized.text },
        ...(agentDiagnostic ? [{ type: "text", text: agentDiagnostic }] : []),
      ],
      details: {
        ...(result.details ?? {}),
        toolExecutionMs,
        summaryDurationMs,
        outputSummaryIntent: decision.intent,
        outputSummaryPrompt: prompt || undefined,
        outputSummaryRender,
        outputSummaryStatus: "summarized",
        summaryTriggerMinChars: config.minChars,
        summaryTriggerMaxChars: null,
        summaryResultMaxChars: config.maxChars,
        missedCompressionRatio: config.missedCompressionRatio,
        summaryModel: summarized.summaryModel,
        outputSummaryDecisionMode: summarized.decision.mode,
        outputSummaryReasonCode: summarized.decision.reasonCode,
        outputSummaryReason: summarized.decision.reason,
        summaryText: summarized.text,
        summaryFilePath: summarized.summaryFilePath,
        ...summaryDiagnostics,
      },
    });
  } catch (error) {
    const summaryDurationMs = Math.round(performance.now() - summaryStartedAt);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const retryError = error instanceof SummaryRetryError ? error : undefined;
    // 总结链路任何异常都必须保留原始结果，不能把异常文本替换给 AI。
    console.warn(
      `[tool-output-summary] ${context.toolName} summarization failed; returning the original result: ${errorMessage}`,
    );
    const diagnostics: SummaryDiagnostics = {
      toolExecutionMs,
      summaryDurationMs,
      originalOutputChars: output.length,
      summaryAttempts: retryError?.attempts,
      ...getSummaryUsageDiagnostics(retryError?.usage),
      outputSummaryIntent: decision.intent,
      outputSummaryPrompt: prompt || undefined,
      outputSummaryRender,
      outputSummaryStatus: "summary-failed",
      summaryTriggerMinChars: config.minChars,
      summaryTriggerMaxChars: null,
      summaryResultMaxChars: config.maxChars,
      missedCompressionRatio: config.missedCompressionRatio,
      ...getTokenCompressionDiagnostics(output, output),
      outputSummaryAnomalies: ["summary-failed"],
      outputSummaryAdvice: `Summarization failed; the original output was preserved. Check model configuration or authentication. Requests still running after ${config.timeoutSeconds}s are treated as timed out.`,
      outputSummaryError: errorMessage,
    };
    const agentDiagnostic = buildAgentDiagnosticText(diagnostics);
    const candidate = {
      ...attachDiagnostics(result, diagnostics),
      content: agentDiagnostic
        ? [...result.content, { type: "text", text: agentDiagnostic }]
        : result.content,
    };
    return finish(candidate);
  }
}

function restoreOutputRequestParameter(parameters: Record<string, unknown>): boolean {
  const state = outputRequestSchemaStates.get(parameters);
  if (!state) return false;

  const properties = parameters.properties;
  if (state.hadOutputRequest) {
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      (properties as Record<string, unknown>).outputRequest = state.originalOutputRequest;
    }
  } else if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    delete (properties as Record<string, unknown>).outputRequest;
    if (!state.hadProperties && Object.keys(properties).length === 0) {
      delete parameters.properties;
    }
  }

  if (state.hadRequired) parameters.required = state.originalRequired;
  else delete parameters.required;
  outputRequestSchemaStates.delete(parameters);
  return true;
}

function extendOutputRequestParameter(tool: ToolInfo, enabled: boolean): boolean {
  const parameters = tool.parameters as unknown as Record<string, unknown> | undefined;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    console.warn(`[pi-distill] Could not extend the ${tool.name} parameter schema; outputRequest is unavailable.`);
    return false;
  }

  if (!enabled) return restoreOutputRequestParameter(parameters);

  if (parameters.type !== "object") {
    console.warn(`[pi-distill] Could not extend the ${tool.name} parameter schema; outputRequest is unavailable.`);
    return false;
  }

  const hadProperties = Object.prototype.hasOwnProperty.call(parameters, "properties");
  const properties = parameters.properties;
  if (properties === undefined) {
    parameters.properties = {};
  } else if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    console.warn(`[pi-distill] Could not extend the ${tool.name} parameter schema; outputRequest is unavailable.`);
    return false;
  }

  if (!outputRequestSchemaStates.has(parameters)) {
    const currentProperties = parameters.properties as Record<string, unknown> | undefined;
    outputRequestSchemaStates.set(parameters, {
      hadProperties,
      hadOutputRequest: Boolean(currentProperties && Object.prototype.hasOwnProperty.call(currentProperties, "outputRequest")),
      originalOutputRequest: currentProperties?.outputRequest,
      hadRequired: Object.prototype.hasOwnProperty.call(parameters, "required"),
      originalRequired: Array.isArray(parameters.required)
        ? [...parameters.required]
        : parameters.required,
    });
  }

  (parameters.properties as Record<string, unknown>).outputRequest = {
    type: "string",
    description: OUTPUT_REQUEST_DESCRIPTION,
  };
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string =>
        typeof value === "string" && value !== "outputRequest")
    : [];
  parameters.required = [...required, "outputRequest"];
  return true;
}

export function extendDistillToolParameters(
  pi: Pick<ExtensionAPI, "getAllTools">,
  loaded = loadDistillConfig(),
): number {
  let extended = 0;
  for (const tool of pi.getAllTools()) {
    const enabled = loaded.enabled && Boolean(loaded.config) && isDistillToolEnabled(loaded.config, tool.name);
    if (extendOutputRequestParameter(tool, enabled) && enabled) extended += 1;
  }
  return extended;
}

function toToolResultEventResult(result: ToolResult): ToolResultEventPatch {
  return {
    content: result.content as ToolResultEvent["content"],
    details: result.details,
    isError: result.isError,
  };
}

type DistillUiConfig = Required<Pick<DistillConfigFile, "enabled" | "model" | "minChars" | "maxChars" | "maxOutputChars" | "timeoutSeconds" | "timeoutRetryCount" | "errorRetryCount" | "missedCompressionRatio" | "summarizeErrors">> & {
  tools: DistillToolConfig;
  render: DistillRenderConfig;
};

function getDistillUiConfig(): DistillUiConfig {
  const loaded = loadDistillConfig();
  const config = loaded.config;
  return {
    enabled: loaded.enabled,
    model: config?.modelProvider && config.modelId
      ? `${config.modelProvider}/${config.modelId}`
      : "",
    minChars: config?.minChars ?? 200,
    maxChars: config?.maxChars ?? 100_000,
    maxOutputChars: config?.maxOutputChars ?? 10_000,
    timeoutSeconds: config?.timeoutSeconds ?? 10,
    timeoutRetryCount: config?.timeoutRetryCount ?? 1,
    errorRetryCount: config?.errorRetryCount ?? 1,
    missedCompressionRatio: config?.missedCompressionRatio ?? 10,
    summarizeErrors: config?.summarizeErrors ?? true,
    tools: Object.fromEntries(
      Object.entries(config?.tools ?? {}).map(([toolName, override]) => [toolName, { ...override }]),
    ),
    render: { ...loaded.render },
  };
}

async function editDistillNumber(
  ctx: ExtensionCommandContext,
  title: string,
  current: number,
): Promise<number | undefined> {
  const value = await ctx.ui.input(title, String(current));
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim()) || Number(value) <= 0) {
    ctx.ui.notify(i18n.t("positiveInteger"), "error");
    return undefined;
  }
  return Number(value);
}

async function editDistillNonNegativeInteger(
  ctx: ExtensionCommandContext,
  title: string,
  current: number,
): Promise<number | undefined> {
  const value = await ctx.ui.input(title, String(current));
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    ctx.ui.notify(i18n.t("nonNegativeInteger"), "error");
    return undefined;
  }
  return parsed;
}

async function editDistillModel(
  ctx: ExtensionCommandContext,
  current: string,
): Promise<string | undefined> {
  const value = await ctx.ui.input(
    i18n.t("modelInput"),
    current || "llm-proxy/LOW",
  );
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized && !/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    ctx.ui.notify(i18n.t("modelInvalid"), "error");
    return undefined;
  }
  return normalized;
}

async function saveDistillConfigFile(
  ctx: ExtensionCommandContext,
  config: DistillUiConfig,
  configPath: string,
  onSaved?: () => void,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const saved = loadDistillConfig();
  if (saved.warnings.length > 0) {
    ctx.ui.notify(i18n.t("savedWarnings", { warnings: saved.warnings.join(" ") }), "warning");
  }
  onSaved?.();
}

function getConfigurableToolNames(pi: Pick<ExtensionAPI, "getAllTools">): string[] {
  return [...new Set(
    pi.getAllTools()
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0),
  )].sort();
}

async function runDistillToolConfigUi(
  ctx: ExtensionCommandContext,
  pi: Pick<ExtensionAPI, "getAllTools">,
  config: DistillUiConfig,
  configPath: string,
  onSaved: () => void,
): Promise<void> {
  const toolNames = getConfigurableToolNames(pi);
  if (toolNames.length === 0) {
    ctx.ui.notify(i18n.t("noConfigurableTools"), "warning");
    return;
  }

  while (true) {
    const choices = toolNames.map((toolName) => i18n.t("toolStatus", {
      tool: toolName,
      value: isDistillToolEnabled(config, toolName) ? i18n.t("on") : i18n.t("off"),
    }));
    const choice = await ctx.ui.select(i18n.t("toolSettingsTitle"), choices);
    if (choice === undefined) return;
    const index = choices.indexOf(choice);
    if (index < 0) return;
    const toolName = toolNames[index];
    config.tools[toolName] = { enabled: !isDistillToolEnabled(config, toolName) };
    await saveDistillConfigFile(ctx, config, configPath, onSaved);
  }
}

async function runDistillConfigUi(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  configPath: string,
  onSaved: () => void,
): Promise<void> {
  const loaded = loadDistillConfig();
  if (loaded.warnings.length > 0) {
    ctx.ui.notify(i18n.t("configWarnings", { warnings: loaded.warnings.join(" ") }), "warning");
  }
  const config = getDistillUiConfig();

  while (true) {
    const choices = [
      i18n.t("status", { value: config.enabled ? i18n.t("on") : i18n.t("off") }),
      i18n.t("model", { value: config.model || i18n.t("currentModel") }),
      i18n.t("minOutput", { value: config.minChars }),
      i18n.t("summaryLimit", { value: config.maxChars }),
      i18n.t("finalLimit", { value: config.maxOutputChars }),
      i18n.t("timeout", { value: config.timeoutSeconds }),
      i18n.t("timeoutRetryCount", { value: config.timeoutRetryCount }),
      i18n.t("errorRetryCount", { value: config.errorRetryCount }),
      i18n.t("threshold", { value: config.missedCompressionRatio }),
      i18n.t("summarizeErrors", { value: config.summarizeErrors ? i18n.t("on") : i18n.t("off") }),
      i18n.t("auditRenderer", { value: config.render.enabled ? i18n.t("on") : i18n.t("off") }),
      i18n.t("showOutputRequest", { value: config.render.showPrompt ? i18n.t("on") : i18n.t("off") }),
      i18n.t("showSummary", { value: config.render.showResult ? i18n.t("on") : i18n.t("off") }),
      i18n.t("toolOverrides"),
    ];
    const choice = await ctx.ui.select(i18n.t("settingsTitle"), choices);
    if (choice === undefined) return;

    if (choice === choices[0]) {
      config.enabled = !config.enabled;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[1]) {
      const value = await editDistillModel(ctx, config.model);
      if (value !== undefined) {
        config.model = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[2]) {
      const value = await editDistillNumber(ctx, i18n.t("minOutputTitle"), config.minChars);
      if (value !== undefined) {
        config.minChars = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[3]) {
      const value = await editDistillNumber(ctx, i18n.t("summaryLimitTitle"), config.maxChars);
      if (value !== undefined) {
        config.maxChars = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[4]) {
      const value = await editDistillNumber(ctx, i18n.t("finalLimitTitle"), config.maxOutputChars);
      if (value !== undefined) {
        config.maxOutputChars = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[5]) {
      const value = await editDistillNumber(ctx, i18n.t("timeoutTitle"), config.timeoutSeconds);
      if (value !== undefined) {
        config.timeoutSeconds = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[6]) {
      const value = await editDistillNonNegativeInteger(
        ctx,
        i18n.t("timeoutRetryCountTitle"),
        config.timeoutRetryCount,
      );
      if (value !== undefined) {
        config.timeoutRetryCount = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[7]) {
      const value = await editDistillNonNegativeInteger(
        ctx,
        i18n.t("errorRetryCountTitle"),
        config.errorRetryCount,
      );
      if (value !== undefined) {
        config.errorRetryCount = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[8]) {
      const value = await editDistillNumber(ctx, i18n.t("thresholdTitle"), config.missedCompressionRatio);
      if (value !== undefined) {
        config.missedCompressionRatio = value;
        await saveDistillConfigFile(ctx, config, configPath, onSaved);
      }
    } else if (choice === choices[9]) {
      config.summarizeErrors = !config.summarizeErrors;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[10]) {
      config.render.enabled = !config.render.enabled;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[11]) {
      config.render.showPrompt = !config.render.showPrompt;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[12]) {
      config.render.showResult = !config.render.showResult;
      await saveDistillConfigFile(ctx, config, configPath, onSaved);
    } else if (choice === choices[13]) {
      await runDistillToolConfigUi(ctx, pi, config, configPath, onSaved);
    }
  }
}

function registerDistillConfigCommand(pi: ExtensionAPI, onSaved: () => void): void {
  const command = {
    description: i18n.t("commandDescription"),
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("interactiveOnly"), "warning");
        return;
      }
      await runDistillConfigUi(ctx, pi, getDistillConfigPath(), onSaved);
    },
  };
  for (const name of ["config:distill", "pi-distill"] as const) {
    pi.registerCommand(name, command);
  }
}

function registerDistillStatsCommand(
  pi: ExtensionAPI,
  getStats: () => DistillSessionStats,
): void {
  pi.registerCommand("distill:stats", {
    description: i18n.t("statsCommandDescription"),
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("interactiveOnly"), "warning");
        return;
      }
      ctx.ui.notify(formatDistillSessionStats(getStats()), "info");
    },
  });
}

export default function piDistillExtension(pi: ExtensionAPI) {
  const pendingCalls = new Map<string, PendingDistillCall>();
  let sessionStats = createDistillSessionStats();
  let originalUserPrompt = "";
  const disposeToolDisplayMiddleware = registerDistillToolDisplayMiddleware();
  registerDistillFallbackRenderer(pi);
  const extendParameters = () => {
    try {
      extendDistillToolParameters(pi, loadDistillConfig());
    } catch (error) {
      console.warn(`[pi-distill] Failed to extend the outputRequest parameter: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  pi.on("session_start", () => {
    sessionStats = createDistillSessionStats();
    extendParameters();
  });
  pi.on("before_agent_start", (event) => {
    originalUserPrompt = typeof event.prompt === "string" ? event.prompt : "";
    extendParameters();
    return {
      systemPrompt: [
        typeof event.systemPrompt === "string" ? event.systemPrompt : "",
        `<output-prompt-contract>\n${OUTPUT_REQUEST_SYSTEM_GUIDELINE}\n</output-prompt-contract>`,
      ].filter((value) => value.length > 0).join("\n\n"),
    };
  });
  pi.on("tool_call", (event) => {
    const loaded = loadDistillConfig();
    const enabled = loaded.enabled
      && Boolean(loaded.config)
      && isDistillToolEnabled(loaded.config, event.toolName);
    pendingCalls.set(event.toolCallId, {
      enabled,
      outputRequest: enabled ? getOutputRequest(event.input) : "",
      originalUserPrompt,
      startedAt: performance.now(),
    });
    // outputRequest 只控制结果处理，不能泄漏给底层内置工具。
    delete (event.input as Record<string, unknown>).outputRequest;
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const pending = pendingCalls.get(event.toolCallId);
    pendingCalls.delete(event.toolCallId);
    if (pending && !pending.enabled) {
      const untouchedResult: ToolResult = {
        content: event.content,
        details: event.details as Record<string, unknown> | undefined,
        isError: event.isError,
      };
      recordDistillSessionResult(sessionStats, untouchedResult.details);
      return toToolResultEventResult(untouchedResult);
    }
    const outputRequest = pending?.outputRequest ?? getOutputRequest(event.input);
    const result = await processToolResult(
      {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        params: { ...event.input, outputRequest },
        originalUserPrompt: pending?.originalUserPrompt ?? originalUserPrompt,
        ctx,
      },
      {
        content: event.content,
        details: event.details as Record<string, unknown> | undefined,
        isError: event.isError,
      },
      pending ? Math.round(performance.now() - pending.startedAt) : 0,
    );
    recordDistillSessionResult(sessionStats, result.details);
    if (!isDistillToolDisplayMiddlewareActive(event.toolName)) {
      appendDistillFallbackAudit(pi, event.toolName, result.details, loadDistillConfig().render);
    }
    return toToolResultEventResult(result);
  });
  pi.on("agent_end", () => pendingCalls.clear());
  pi.on("session_shutdown", () => disposeToolDisplayMiddleware());
  registerDistillStatsCommand(pi, () => sessionStats);
  registerDistillConfigCommand(pi, extendParameters);
}
