/**
 * 文件编辑侧边审查器。
 *
 * edit/write 已经执行完成后，提取实际文件变化并并发交给配置的审查模型。
 * 审查失败不回滚文件；只有明确拒绝才会把诊断追加到 Agent 可见的 tool result。
 * 配置文件位于 Pi 的用户扩展配置目录：
 * ~/.pi/agent/extensions/pi-tool-supervisor/config.json
 */

import { complete } from "@earendil-works/pi-ai/compat";
import { NOTICE_TAG_COLOR, createTranslator, installNoticeRenderer, loadCatalog, notifyWithSource, type NoticeColor, type NoticeLevel, type NoticeSource } from "pi-extensions-i18n";
import { createModelRequester } from "pi-model-request";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  appendSupervisorFallbackAudit,
  registerSupervisorFallbackRenderer,
} from "./fallback-renderer.ts";
import {
  isSupervisorToolDisplayMiddlewareActive,
  registerSupervisorToolDisplayMiddleware,
} from "./tool-display-bridge.ts";
import {
  CONDITION_MATCHED_STATUS,
  CONDITION_NOT_MATCHED_STATUS,
  evaluateToolCondition,
  type ToolConditionEvent,
} from "./condition-utils.ts";

import {
  buildCurrentFileContext,
  buildEditFallbackDiff,
  buildFileEditReviewDiff,
  buildMergedReviewPrompt,
  DEFAULT_TYPESAFE_MODEL,
  getPiSupervisorConfigPath,
  getOverallReviewStatus,
  loadFileEditReviewConfig,
  loadReviewRules,
  parseReviewResponse,
  REVIEW_BACKENDS,
  reviewerAppliesToFile,
  reviewerBackend,
  reviewerIsEditorLocal,
  reviewerMatchesTool,
  reviewerModelLabel,
  reviewerTrigger,
  safeSerialize,
  type CurrentFileContext,
  type FileEditReviewAudit,
  type FileEditReviewConfig,
  type FileEditReviewReviewerConfig,
  type FileEditReviewResult,
  type FileEditReviewRule,
  type ReviewBackend,
  type ReviewTrigger,
} from "./review-utils.ts";
import { askTypeSafe, type TypeSafeConnection } from "./typesafe-client.ts";
import { openSupervisorPanel } from "./config-panel.ts";
import {
  buildJudgmentFindings,
  buildJudgmentQuestions,
  buildLocalizationQuestions,
  compileJudgments,
  extractChangedLines,
  MAX_LOCALIZATION_CANDIDATES,
  readJudgmentVerdicts,
  readLocatedLines,
  type JudgmentState,
  type LocatedLine,
  type RuleJudgment,
} from "./judgment.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));
/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
const NOTICE_TAG = "supervisor";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
const AFTER_TRIGGER: ReviewTrigger = "after";
const BEFORE_TRIGGER: ReviewTrigger = "before";
const MILLISECONDS_PER_SECOND = 1000;
const REVIEW_MAX_TOKENS = 1200;
const MAX_REVIEW_PAYLOAD_CHARS = 10_000;
const REJECTED_STATUS = "rejected" as const;
const SKIPPED_STATUS = "skipped" as const;
const EDIT_TOOL = "edit";
const WRITE_TOOL = "write";
const ALL_TOOLS = "*";
const DEFAULT_REVIEW_TOOLS = [EDIT_TOOL, WRITE_TOOL];
/** `REVIEW_BACKENDS` 里的 TypeSafe 取值；用常量避免散落的字面量比较。 */
const TYPE_SAFE_BACKEND: ReviewBackend = REVIEW_BACKENDS[1];
const CONDITION_NOT_MATCHED_MESSAGE_KEY = "conditionNotMatched";
const CONDITION_FAILED_MESSAGE_KEY = "conditionFailed";
type ToolResult = {
  content: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

type FileReviewExecutionContext = {
  event: ToolConditionEvent;
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  ctx: ExtensionContext;
};

type FileSnapshot = {
  filePath: string;
  before?: string;
  after?: string;
  beforeError?: string;
  afterError?: string;
};

type PendingFileReviewCall = {
  toolName: string;
  params: Record<string, unknown>;
  loaded: ReturnType<typeof loadFileEditReviewConfig>;
  snapshot?: FileSnapshot;
  fallbackDiff: string;
  beforeAudit?: FileEditReviewAudit;
  afterReviewers: FileEditReviewReviewerConfig[];
};

type ReviewerConditionSelection = {
  matched: FileEditReviewReviewerConfig[];
  results: FileEditReviewResult[];
};

interface SelectReviewerConditionsOptions {
  reviewers: FileEditReviewReviewerConfig[];
  event: ToolConditionEvent;
  ctx: ExtensionContext;
  timeoutMs: number;
}

/** Builds an audit result for a reviewer whose condition did not run or failed. */
function buildConditionResult(
  reviewer: FileEditReviewReviewerConfig,
  evaluation: Awaited<ReturnType<typeof evaluateToolCondition>>,
): FileEditReviewResult {
  const ruleReference = reviewer.rulesFile
    ? { rulesFile: reviewer.rulesFile }
    : { rulesFiles: reviewer.rulesFiles };
  if (evaluation.status === CONDITION_NOT_MATCHED_STATUS) {
    return {
      name: reviewer.name,
      model: reviewerModelLabel(reviewer),
      ...ruleReference,
      status: SKIPPED_STATUS,
      durationMs: evaluation.durationMs,
      error: i18n.t(CONDITION_NOT_MATCHED_MESSAGE_KEY),
    };
  }

  return {
    name: reviewer.name,
    model: reviewerModelLabel(reviewer),
    ...ruleReference,
    status: REJECTED_STATUS,
    durationMs: evaluation.durationMs,
    summary: i18n.t(CONDITION_FAILED_MESSAGE_KEY, {
      path: evaluation.path ?? reviewer.condition ?? "",
      message: evaluation.error ?? "",
    }),
    error: evaluation.error,
  };
}

/** Selects reviewers by condition without invoking a model for non-matching inputs. */
async function selectReviewersByCondition(
  options: SelectReviewerConditionsOptions,
): Promise<ReviewerConditionSelection> {
  const evaluations = await Promise.all(options.reviewers.map(async (reviewer) => ({
    reviewer,
    evaluation: await evaluateToolCondition({
      conditionPath: reviewer.condition,
      cwd: options.ctx.cwd,
      event: options.event,
      ctx: options.ctx,
      timeoutMs: options.timeoutMs,
    }),
  })));
  return {
    matched: evaluations
      .filter(({ evaluation }) => evaluation.status === CONDITION_MATCHED_STATUS)
      .map(({ reviewer }) => reviewer),
    results: evaluations
      .filter(({ evaluation }) => evaluation.status !== CONDITION_MATCHED_STATUS)
      .map(({ reviewer, evaluation }) => buildConditionResult(reviewer, evaluation)),
  };
}

/** Extracts a file path when the selected tool exposes one. */
function getPath(params: Record<string, unknown>): string | undefined {
  const value = params.file_path ?? params.path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Narrows unknown event payloads without trusting arbitrary tool data. */
function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}


/**
 * 统一提示出口：加来源标签后交给 Pi 的 notify。
 * 沿用原有 `ctx.ui?.notify` 语义：上下文没有 UI 时跳过提示，而不是把异常抛到审查流程里。
 */
function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: NoticeLevel): void {
  if (!ctx.ui) return;
  notifyWithSource({ ctx: { mode: ctx.mode, ui: ctx.ui }, source: NOTICE_SOURCE, level, message });
}

/** Detects tool execution failure without inspecting arbitrary detail fields. */
function isFailedToolResult(result: ToolResult): boolean {
  return result.isError === true || getRecord(result).isError === true;
}

/** Reads a snapshot target and returns explicit errors for missing or inaccessible files. */
async function readOptionalFile(filePath: string): Promise<{ content?: string; error?: string }> {
  try {
    return { content: await readFile(filePath, "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

/** Captures the file state immediately before an edit or write executes. */
async function captureBefore(filePath: string): Promise<{ content?: string; error?: string }> {
  return readOptionalFile(filePath);
}

/** Captures the post-tool file state, using write input only as a narrow fallback. */
async function captureAfter(
  toolName: "edit" | "write",
  filePath: string,
  params: Record<string, unknown>,
): Promise<{ content?: string; error?: string }> {
  const result = await readOptionalFile(filePath);
  if (result.content !== undefined) return result;
  if (toolName === "write" && typeof params.content === "string") {
    return { content: params.content };
  }
  return result;
}

/** Adds one visible parent-cancellation warning without duplicating merged audit warnings. */
function withReviewAbortedWarning(warnings: string[], signal?: AbortSignal): string[] {
  if (!signal?.aborted) return warnings;
  const warning = i18n.t("reviewAborted");
  return warnings.includes(warning) ? warnings : [...warnings, warning];
}

/** Produces an Agent-visible diagnostic only for explicit reviewer rejections. */
function createReviewRejectionDiagnostic(
  audit: FileEditReviewAudit,
): string | undefined {
  const rejected = audit.reviewers.filter((reviewer) => reviewer.status === "rejected");
  if (rejected.length === 0) return undefined;

  const lines: string[] = ["[文件编辑审查未通过，必须立即修正]"];
  lines.push(audit.filePath ? `文件：${audit.filePath}` : `工具：${audit.toolName}`);
  for (const reviewer of rejected) {
    lines.push(`规则审查：${reviewer.name}（${reviewer.rulesFiles?.join(", ") ?? reviewer.rulesFile ?? "未指定规则文件"}）`);
    if (reviewer.summary) lines.push(`结论：${reviewer.summary}`);
    for (const finding of reviewer.findings ?? []) {
      const location = finding.line ? `第 ${finding.line} 行：` : "";
      const ruleGroup = finding.ruleGroup ? `[${finding.ruleGroup}] ` : "";
      lines.push(`- ${ruleGroup}${location}${finding.message}`);
    }
  }
  lines.push("请先修正以上问题，再继续后续任务。不要忽略这条审查结果。");
  return lines.join("\n");
}

/** 一次审查任务：引擎无关的输入，由 runReviewer 按 reviewer 配置的 backend 分发。 */
interface RunReviewerOptions {
  context: FileReviewExecutionContext;
  config: FileEditReviewConfig;
  reviewer: FileEditReviewReviewerConfig;
  rules: FileEditReviewRule[];
  toolName: string;
  filePath?: string;
  diff: string;
  currentFileContext?: CurrentFileContext;
  trigger?: ReviewTrigger;
  /** 修改前的文件内容；只有 TypeSafe 行定位会用到，其它 backend 忽略。 */
  beforeContent?: string;
  /** 修改后的文件内容；只有 TypeSafe 行定位会用到，其它 backend 忽略。 */
  afterContent?: string;
}

/** Executes one reviewer with parent cancellation and timeout fail-open behavior. */
async function reviewWithModel(options: RunReviewerOptions): Promise<FileEditReviewResult> {
  const { context, config, reviewer, rules, toolName, filePath, diff, currentFileContext, trigger = AFTER_TRIGGER } = options;
  const startedAt = performance.now();
  const base = {
    name: reviewer.name,
    model: reviewerModelLabel(reviewer),
    rulesFiles: rules.map((rule) => rule.reviewer.rulesFile).filter((file): file is string => Boolean(file)),
  };
  const failed = (error: string): FileEditReviewResult => ({
    ...base,
    status: "failed",
    durationMs: Math.round(performance.now() - startedAt),
    error,
  });
  /** Reports parent cancellation as a skipped review rather than a provider failure. */
  const createAbortedResult = (): FileEditReviewResult => ({
    ...base,
    status: SKIPPED_STATUS,
    durationMs: Math.round(performance.now() - startedAt),
    error: i18n.t("reviewAborted"),
  });
  if (context.signal?.aborted) return createAbortedResult();
  if (!reviewer.model) return failed(i18n.t("modelMissing"));
  const separator = reviewer.model.indexOf("/");
  const modelProvider = reviewer.model.slice(0, separator);
  const modelId = reviewer.model.slice(separator + 1);
  const model = context.ctx.modelRegistry.find(modelProvider, modelId);
  if (!model) {
    return failed(`审查模型不存在：${reviewer.model}`);
  }

  const controller = new AbortController();
  /** Propagates the parent abort signal to the reviewer request. */
  const abortFromParent = () => controller.abort();
  context.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * MILLISECONDS_PER_SECOND);
  try {
    // 审查请求由扩展自己发出：鉴权与 provider 会话头交给共享请求器，与 Pi 核心行为一致。
    const request = createModelRequester(context.ctx, {
      base: complete,
      authError: (error) => new Error(`审查模型鉴权失败：${error}`),
    });
    if (context.signal?.aborted) return createAbortedResult();
    const response = await request(
      model,
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildMergedReviewPrompt({ toolName, filePath, diff, currentFileContext, rules, trigger }) }],
          timestamp: Date.now(),
        }],
      },
      {
        maxTokens: REVIEW_MAX_TOKENS,
        signal: controller.signal,
      },
    );
    if (context.signal?.aborted) return createAbortedResult();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? `审查模型结束原因：${response.stopReason}`);
    }
    const text = response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    const parsed = parseReviewResponse(text);
    return {
      ...base,
      status: parsed.passed ? "passed" : "rejected",
      summary: parsed.summary,
      findings: parsed.findings,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    if (context.signal?.aborted) return createAbortedResult();
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", abortFromParent);
  }
}

/**
 * 从 config.json 取 TypeSafe 连接设置。
 *
 * config 里没配的字段留空，由连接层回退到环境变量；key 不回显、不写日志。
 */
function typeSafeConnection(config: FileEditReviewConfig): TypeSafeConnection {
  const typesafe = config.typesafe;
  return {
    ...(typesafe?.apiKey === undefined ? {} : { apiKey: typesafe.apiKey }),
    ...(typesafe?.endpoint === undefined ? {} : { endpoint: typesafe.endpoint }),
  };
}

/**
 * 用 TypeSafe 判断后端执行一次审查。
 *
 * 一条规则 = 一个 Noul 问题，一次请求批量问完（同一份 state 下 TypeSafe 并行回答）；
 * 有条款命中时再做一次 Choice 请求，把问题定位到具体新增行。
 * 阈值和阻断与否都由本模块决定，模型只提供概率；没有分级，命中即阻断。
 */
async function reviewWithJudgments(options: RunReviewerOptions): Promise<FileEditReviewResult> {
  const {
    context, config, reviewer, rules, toolName, filePath, diff,
    currentFileContext, trigger = AFTER_TRIGGER, beforeContent, afterContent,
  } = options;
  const startedAt = performance.now();
  const base = {
    name: reviewer.name,
    model: reviewerModelLabel(reviewer),
    rulesFiles: rules.map((rule) => rule.reviewer.rulesFile).filter((file): file is string => Boolean(file)),
  };
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  if (context.signal?.aborted) {
    return { ...base, status: SKIPPED_STATUS, durationMs: elapsedMs(), error: i18n.t("reviewAborted") };
  }

  const compiled = compileJudgments(rules);
  const unparsableRules = compiled.errors.map((entry) => `${entry.rulesFile}: ${entry.message}`);
  if (compiled.judgments.length === 0) {
    return {
      ...base,
      status: "failed",
      durationMs: elapsedMs(),
      error: unparsableRules.length > 0 ? unparsableRules.join(" | ") : i18n.t("noJudgments"),
    };
  }

  const typesafeModel = reviewer.typesafeModel ?? DEFAULT_TYPESAFE_MODEL;
  const connection = typeSafeConnection(config);
  const timeoutMs = config.timeoutSeconds * MILLISECONDS_PER_SECOND;
  const state: JudgmentState = {
    tool: toolName,
    trigger,
    diff,
    ...(filePath ? { file: filePath } : {}),
    ...(currentFileContext
      ? { current_file: currentFileContext.content, current_file_truncated: currentFileContext.truncated }
      : {}),
  };

  let answers: Record<string, { type?: string; noul?: number }>;
  try {
    const response = await askTypeSafe({
      state,
      questions: buildJudgmentQuestions(compiled.judgments),
      model: typesafeModel,
      timeoutMs,
      ...connection,
      signal: context.signal,
    });
    answers = response.answers;
  } catch (error) {
    if (context.signal?.aborted) {
      return { ...base, status: SKIPPED_STATUS, durationMs: elapsedMs(), error: i18n.t("reviewAborted") };
    }
    return {
      ...base,
      status: "failed",
      durationMs: elapsedMs(),
      error: error instanceof Error ? error.message : String(error),
      ...(compiled.warnings.length > 0 ? { warnings: compiled.warnings } : {}),
    };
  }

  const { verdicts, unanswered } = readJudgmentVerdicts(compiled.judgments, answers);
  // 没有分级：条款定义了就要遵守，命中即阻断，也就要做行定位。
  const hits = verdicts.filter((verdict) => verdict.hit);
  const localization = await locateJudgmentLines({
    context,
    judgments: hits.map((verdict) => verdict.judgment),
    diff,
    beforeContent,
    afterContent,
    timeoutMs,
    typesafeModel,
    connection,
  });
  // 缺答案和切不出条款的文件不能当成通过：它们列进 failed 和 warnings。
  const unresolved = [
    ...unparsableRules,
    ...(unanswered.length > 0
      ? [i18n.t("unansweredJudgments", {
        count: unanswered.length,
        ids: unanswered.map((judgment) => judgment.id).join(", "),
      })]
      : []),
  ];
  const status = hits.length > 0 ? "rejected" : unresolved.length > 0 ? "failed" : "passed";
  const hitDetails = hits.map((verdict) => `${verdict.judgment.ruleName}=${verdict.noul.toFixed(2)}`).join(", ");
  const summary = status === "rejected"
    ? i18n.t("rejectedSummary", { count: hits.length, details: hitDetails })
    : i18n.t("passedSummary");
  const result: FileEditReviewResult = {
    ...base,
    status,
    summary,
    findings: buildJudgmentFindings(hits, localization.located),
    durationMs: elapsedMs(),
    ...(status === "failed" ? { error: unresolved.join(" | ") } : {}),
  };
  const warnings = [...compiled.warnings, ...localization.warnings, ...unresolved];
  return warnings.length > 0 ? { ...result, warnings } : result;
}

/**
 * 命中 error 级规则后再发一次 Choice 请求，把问题定位到具体新增行。
 * 没有修改后的文件内容时跳过定位：此时只有规则级问题可报，不是静默降级。
 */
async function locateJudgmentLines(options: {
  context: FileReviewExecutionContext;
  judgments: RuleJudgment[];
  diff: string;
  beforeContent?: string;
  afterContent?: string;
  timeoutMs: number;
  typesafeModel: string;
  connection: TypeSafeConnection;
}): Promise<{ located: Map<string, LocatedLine>; warnings: string[] }> {
  const { context, judgments, diff, beforeContent, afterContent, timeoutMs, typesafeModel, connection } = options;
  const located = new Map<string, LocatedLine>();
  const warnings: string[] = [];
  if (judgments.length === 0 || afterContent === undefined) return { located, warnings };
  const scan = extractChangedLines(beforeContent, afterContent);
  if (scan.truncated) {
    warnings.push(i18n.t("localizationSkipped", { count: MAX_LOCALIZATION_CANDIDATES }));
    return { located, warnings };
  }
  if (scan.lines.length === 0) return { located, warnings };
  try {
    const response = await askTypeSafe({
      state: {
        diff,
        candidate_lines: Object.fromEntries(scan.lines.map((candidate) => [String(candidate.line), candidate.text])),
      },
      questions: buildLocalizationQuestions(judgments, scan.lines),
      model: typesafeModel,
      timeoutMs,
      ...connection,
      signal: context.signal,
    });
    return { located: readLocatedLines(judgments, response.answers, scan.lines), warnings };
  } catch (error) {
    // 行定位失败不影响规则级结论，但必须在审计里可见。
    if (!context.signal?.aborted) {
      warnings.push(i18n.t("localizationFailed", {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    return { located, warnings };
  }
}

/** 按 reviewer 的 backend 分发；两种引擎的失败语义一致：非阻断，只在审计卡片里可见。 */
async function runReviewer(options: RunReviewerOptions): Promise<FileEditReviewResult> {
  return reviewerBackend(options.reviewer) === TYPE_SAFE_BACKEND
    ? reviewWithJudgments(options)
    : reviewWithModel(options);
}

/** Captures the pre-tool file state and a fallback edit payload. */
async function createSnapshot(
  context: FileReviewExecutionContext,
  toolName: "edit" | "write",
): Promise<{ snapshot?: FileSnapshot; fallbackDiff: string }> {
  const filePath = getPath(context.params);
  if (!filePath) return { fallbackDiff: "无法从工具参数读取文件路径。" };
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(context.ctx.cwd, filePath);
  const before = await captureBefore(absolutePath);
  return {
    snapshot: {
      filePath,
      before: before.content,
      beforeError: before.error,
    },
    fallbackDiff: toolName === "edit" ? buildEditFallbackDiff(context.params) : "",
  };
}

/** Reviews a successful file result while preserving the original tool result on failures. */
async function reviewToolResult(options: {
  context: FileReviewExecutionContext;
  toolName: "edit" | "write";
  config: FileEditReviewConfig;
  configWarnings: string[];
  snapshot: FileSnapshot;
  fallbackDiff: string;
  result: ToolResult;
  afterReviewers?: FileEditReviewReviewerConfig[];
  beforeAudit?: FileEditReviewAudit;
}): Promise<ToolResult> {
  const { context, toolName, config, configWarnings, snapshot, fallbackDiff, result, afterReviewers, beforeAudit } = options;
  const configuredAfterReviewers = afterReviewers ?? config.reviewers.filter((reviewer) => reviewer.enabled !== false && reviewerTrigger(reviewer) === AFTER_TRIGGER && reviewerMatchesTool(reviewer, toolName));
  const beforeReviewers = beforeAudit?.reviewers ?? [];
  const startedAt = performance.now();
  if (context.signal?.aborted) {
    const reviewers = [...beforeReviewers];
    const audit: FileEditReviewAudit = {
      filePath: snapshot.filePath,
      toolName,
      status: reviewers.length > 0 ? getOverallReviewStatus(reviewers) : SKIPPED_STATUS,
      reviewers,
      durationMs: Math.round(performance.now() - startedAt),
      warnings: withReviewAbortedWarning(
        [...configWarnings, ...(beforeAudit?.warnings ?? [])],
        context.signal,
      ),
    };
    return { ...result, details: { ...(result.details ?? {}), fileEditReview: audit } };
  }
  const after = await captureAfter(
    toolName,
    isAbsolute(snapshot.filePath) ? snapshot.filePath : resolve(context.ctx.cwd, snapshot.filePath),
    context.params,
  );
  snapshot.after = after.content;
  snapshot.afterError = after.error;

  const auditBase = {
    filePath: snapshot.filePath,
    toolName,
    warnings: [...configWarnings],
  } satisfies Pick<FileEditReviewAudit, "filePath" | "toolName" | "warnings">;

  if (isFailedToolResult(result)) {
    const skippedAfter = configuredAfterReviewers.map((reviewer) => ({
      name: reviewer.name,
      model: reviewerModelLabel(reviewer),
      status: SKIPPED_STATUS,
      durationMs: 0,
      error: i18n.t("failedAfterReview"),
    }));
    const reviewers = [...beforeReviewers, ...skippedAfter];
    const audit: FileEditReviewAudit = {
      ...auditBase,
      status: getOverallReviewStatus(reviewers),
      trigger: AFTER_TRIGGER,
      reviewers,
      durationMs: Math.round(performance.now() - startedAt),
      warnings: [...configWarnings, ...(beforeAudit?.warnings ?? [])],
    };
    return { ...result, details: { ...(result.details ?? {}), fileEditReview: audit } };
  }

  const diff = buildFileEditReviewDiff(snapshot.filePath, snapshot.before, snapshot.after, fallbackDiff);
  if (!diff) {
    const reviewers = [...beforeReviewers];
    const audit: FileEditReviewAudit = {
      ...auditBase,
      status: reviewers.length > 0 ? getOverallReviewStatus(reviewers) : SKIPPED_STATUS,
      reviewers,
      durationMs: Math.round(performance.now() - startedAt),
      warnings: [...configWarnings, ...(beforeAudit?.warnings ?? []), i18n.t("unchangedFileSkipped")],
    };
    const diagnostic = createReviewRejectionDiagnostic(audit);
    if (diagnostic) notify(context.ctx, diagnostic, "error");
    return {
      ...result,
      details: { ...(result.details ?? {}), fileEditReview: audit },
      content: diagnostic ? [...result.content, { type: "text", text: diagnostic }] : result.content,
    };
  }

  const conditionSelection = await selectReviewersByCondition({
    reviewers: configuredAfterReviewers,
    event: context.event,
    ctx: context.ctx,
    timeoutMs: config.timeoutSeconds * MILLISECONDS_PER_SECOND,
  });
  const selectedReviewers = conditionSelection.matched;
  const conditionResults = conditionSelection.results;

  const currentFileContext = buildCurrentFileContext(snapshot.before, snapshot.after, config.maxFileContextChars);
  const reviewerGroups = selectedReviewers
    .map((reviewer) => {
      const loaded = loadReviewRules(reviewer, context.ctx.cwd, config.maxRuleLines);
      const applicableRules = loaded.rules.filter((rule) =>
        rule.reviewer.enabled !== false &&
        reviewerIsEditorLocal(rule.reviewer) &&
        reviewerAppliesToFile(rule.reviewer, snapshot.filePath),
      );
      return { reviewer, rules: applicableRules, errors: loaded.errors };
    });
  const applicableGroups = reviewerGroups.filter((group) => group.rules.length > 0 || group.errors.length > 0);
  const applicableErrors = applicableGroups.flatMap((group) => group.errors);
  if (applicableGroups.length === 0 && applicableErrors.length === 0) {
    const hasConditionRejection = conditionResults.some((reviewer) => reviewer.status === REJECTED_STATUS);
    if (!beforeAudit && !hasConditionRejection) return result;
    const reviewers = [...beforeReviewers, ...conditionResults];
    const audit: FileEditReviewAudit = {
      ...auditBase,
      status: getOverallReviewStatus(reviewers),
      trigger: AFTER_TRIGGER,
      reviewers,
      durationMs: Math.round(performance.now() - startedAt),
      warnings: [...configWarnings, ...(beforeAudit?.warnings ?? [])],
    };
    const diagnostic = createReviewRejectionDiagnostic(audit);
    if (diagnostic) notify(context.ctx, diagnostic, "error");
    return {
      ...result,
      details: { ...(result.details ?? {}), fileEditReview: audit },
      content: diagnostic ? [...result.content, { type: "text", text: diagnostic }] : result.content,
    };
  }
  const warnings = [
    ...configWarnings,
    ...(beforeAudit?.warnings ?? []),
    ...applicableGroups.flatMap((group) => group.rules.flatMap((rule) => rule.warning ? [rule.warning] : [])),
  ];
  const reviewResults = await Promise.all([
    ...conditionResults,
    ...applicableGroups.map((group) =>
      runReviewer({
        context,
        config,
        reviewer: group.reviewer,
        rules: group.rules,
        toolName,
        filePath: snapshot.filePath,
        diff,
        currentFileContext,
        beforeContent: snapshot.before,
        afterContent: snapshot.after,
      }),
    ),
    ...applicableErrors.map((error) => Promise.resolve(error)),
  ]);
  const auditWarnings = withReviewAbortedWarning(
    [...warnings, ...reviewResults.flatMap((result) => result.warnings ?? [])],
    context.signal,
  );
  const audit: FileEditReviewAudit = {
    ...auditBase,
    status: getOverallReviewStatus(reviewResults),
    trigger: AFTER_TRIGGER,
    reviewers: [...beforeReviewers, ...reviewResults],
    durationMs: Math.round(performance.now() - startedAt),
    warnings: auditWarnings,
  };
  const diagnostic = createReviewRejectionDiagnostic(audit);
  if (diagnostic) {
    notify(context.ctx, diagnostic, "error");
  }
  return {
    ...result,
    details: { ...(result.details ?? {}), fileEditReview: audit },
    content: diagnostic
      ? [...result.content, { type: "text", text: diagnostic }]
      : result.content,
  };
}

/** Executes matching before reviewers and returns the visible audit used for blocking. */
async function runBeforeReview(options: {
  context: FileReviewExecutionContext;
  loaded: ReturnType<typeof loadFileEditReviewConfig>;
  filePath?: string;
  fallbackDiff: string;
}): Promise<FileEditReviewAudit | undefined> {
  const { context, loaded, filePath, fallbackDiff } = options;
  const configuredReviewers = loaded.config.reviewers.filter((reviewer) =>
    reviewer.enabled !== false && reviewerTrigger(reviewer) === BEFORE_TRIGGER && reviewerMatchesTool(reviewer, context.toolName),
  );
  if (configuredReviewers.length === 0) return undefined;
  const startedAt = performance.now();
  const conditionSelection = await selectReviewersByCondition({
    reviewers: configuredReviewers,
    event: context.event,
    ctx: context.ctx,
    timeoutMs: loaded.config.timeoutSeconds * MILLISECONDS_PER_SECOND,
  });
  const reviewers = conditionSelection.matched;
  const results: FileEditReviewResult[] = [...conditionSelection.results];
  if (reviewers.length === 0) {
    return {
      status: getOverallReviewStatus(results),
      filePath,
      toolName: context.toolName,
      trigger: BEFORE_TRIGGER,
      reviewers: results,
      durationMs: Math.round(performance.now() - startedAt),
      warnings: withReviewAbortedWarning([...loaded.warnings], context.signal),
    };
  }
  const isFileTool = context.toolName === EDIT_TOOL || context.toolName === WRITE_TOOL;
  const selectedFilePath = isFileTool ? getPath(context.params) : undefined;
  const serializedPayload = selectedFilePath
    ? { text: buildFileEditReviewDiff(selectedFilePath, undefined, typeof context.params.content === "string" ? context.params.content : undefined, fallbackDiff) }
    : safeSerialize(context.params, MAX_REVIEW_PAYLOAD_CHARS);
  const warnings = [...loaded.warnings];
  // 逐个 reviewer 并发执行，但保持 results 的顺序与配置顺序一致。
  const perReviewer = await Promise.all(reviewers.map(async (reviewer) => {
    const loadedRules = loadReviewRules(reviewer, context.ctx.cwd, loaded.config.maxRuleLines);
    const rules = loadedRules.rules.filter((rule) => {
      if (rule.reviewer.enabled === false || !reviewerIsEditorLocal(rule.reviewer)) return false;
      return selectedFilePath
        ? reviewerAppliesToFile(rule.reviewer, selectedFilePath)
        : (rule.reviewer.filePatterns ?? []).length === 0;
    });
    const produced: FileEditReviewResult[] = [...loadedRules.errors];
    if (rules.length > 0 && serializedPayload.error) {
      produced.push({
        name: reviewer.name,
        model: reviewerModelLabel(reviewer),
        status: "failed",
        durationMs: 0,
        error: serializedPayload.error,
      });
    } else if (rules.length > 0) {
      produced.push(await runReviewer({
        context,
        config: loaded.config,
        reviewer,
        rules,
        toolName: context.toolName,
        filePath: selectedFilePath,
        diff: serializedPayload.text ?? "",
        trigger: BEFORE_TRIGGER,
        // before 阶段只有 write 拿得到修改后的文件内容，edit 没有新文件可定位。
        afterContent: typeof context.params.content === "string" ? context.params.content : undefined,
      }));
    } else if (loadedRules.errors.length === 0) {
      produced.push({
        name: reviewer.name,
        model: reviewerModelLabel(reviewer),
        status: "skipped",
        durationMs: 0,
        error: i18n.t("noApplicableRules"),
      });
    }
    return {
      produced,
      reviewerWarnings: [
        ...rules.flatMap((rule) => rule.warning ? [rule.warning] : []),
        ...produced.flatMap((result) => result.warnings ?? []),
      ],
    };
  }));
  for (const entry of perReviewer) {
    results.push(...entry.produced);
    warnings.push(...entry.reviewerWarnings);
  }
  return { status: getOverallReviewStatus(results), filePath, toolName: context.toolName, trigger: BEFORE_TRIGGER, reviewers: results, durationMs: Math.round(performance.now() - startedAt), warnings: withReviewAbortedWarning(warnings, context.signal) };
}

/** Prepares snapshots, before audits, and after reviewer state for one tool call. */
async function prepareFileReviewCall(
  context: FileReviewExecutionContext,
): Promise<PendingFileReviewCall> {
  const loaded = loadFileEditReviewConfig();
  const pending: PendingFileReviewCall = {
    toolName: context.toolName,
    params: { ...context.params },
    loaded,
    fallbackDiff: "",
    afterReviewers: [],
  };
  if (!loaded.config.enabled) {
    if (loaded.warnings.length > 0) {
      notify(context.ctx, loaded.warnings.join(" | "), "warning");
    }
    return pending;
  }

  if (context.signal?.aborted) return pending;

  const isFileTool = context.toolName === EDIT_TOOL || context.toolName === WRITE_TOOL;
  const filePath = isFileTool ? getPath(context.params) : undefined;
  if (isFileTool && filePath && loaded.config.reviewers.some((reviewer) =>
    reviewer.enabled && reviewerMatchesTool(reviewer, context.toolName) && reviewerAppliesToFile(reviewer, filePath))) {
    const prepared = await createSnapshot(context, context.toolName as typeof EDIT_TOOL | typeof WRITE_TOOL);
    pending.snapshot = prepared.snapshot;
    pending.fallbackDiff = prepared.fallbackDiff;
  }
  pending.afterReviewers = loaded.config.reviewers.filter((reviewer) =>
    reviewer.enabled !== false && reviewerTrigger(reviewer) === AFTER_TRIGGER && reviewerMatchesTool(reviewer, context.toolName),
  );
  pending.beforeAudit = await runBeforeReview({ context, loaded, filePath, fallbackDiff: pending.fallbackDiff });
  return pending;
}

/** Processes generic tool results with input/result review and before-audit merging. */
async function processGenericReviewResult(context: FileReviewExecutionContext, pending: PendingFileReviewCall, result: ToolResult): Promise<ToolResult> {
  if (pending.afterReviewers.length === 0 && !pending.beforeAudit) return result;
  const startedAt = performance.now();
  const configuredReviewers = pending.afterReviewers;
  const results: FileEditReviewResult[] = [];
  if (isFailedToolResult(result)) {
    results.push(...configuredReviewers.map((reviewer) => ({
      name: reviewer.name,
      model: reviewerModelLabel(reviewer),
      status: SKIPPED_STATUS,
      durationMs: 0,
      error: i18n.t("failedAfterReview"),
    })));
  } else {
    const conditionSelection = await selectReviewersByCondition({
      reviewers: configuredReviewers,
      event: context.event,
      ctx: context.ctx,
      timeoutMs: pending.loaded.config.timeoutSeconds * MILLISECONDS_PER_SECOND,
    });
    results.push(...conditionSelection.results);
    const reviewers = conditionSelection.matched;
    const serializedPayload = safeSerialize(
      { input: pending.params, result: { content: result.content, details: result.details, isError: result.isError } },
      MAX_REVIEW_PAYLOAD_CHARS,
    );
    for (const reviewer of reviewers) {
      const loadedRules = loadReviewRules(reviewer, context.ctx.cwd, pending.loaded.config.maxRuleLines);
      const rules = loadedRules.rules.filter((rule) => rule.reviewer.enabled !== false && reviewerIsEditorLocal(rule.reviewer) && (rule.reviewer.filePatterns ?? []).length === 0);
      results.push(...loadedRules.errors);
      if (rules.length > 0 && serializedPayload.error) {
        results.push({ name: reviewer.name, model: reviewerModelLabel(reviewer), status: "failed", durationMs: 0, error: serializedPayload.error });
      } else if (rules.length > 0) {
        results.push(await runReviewer({ context, config: pending.loaded.config, reviewer, rules, toolName: context.toolName, diff: serializedPayload.text ?? "", trigger: AFTER_TRIGGER }));
      } else if (loadedRules.errors.length === 0) {
        results.push({ name: reviewer.name, model: reviewerModelLabel(reviewer), status: "skipped", durationMs: 0, error: i18n.t("noApplicableGenericRules") });
      }
    }
  }
  const reviewersWithBefore = [...(pending.beforeAudit?.reviewers ?? []), ...results];
  const afterDurationMs = Math.round(performance.now() - startedAt);
  const warnings = withReviewAbortedWarning(
    [
      ...pending.loaded.warnings,
      ...(pending.beforeAudit?.warnings ?? []),
      ...results.flatMap((result) => result.warnings ?? []),
    ],
    context.signal,
  );
  const audit: FileEditReviewAudit = { status: getOverallReviewStatus(reviewersWithBefore), toolName: context.toolName, trigger: AFTER_TRIGGER, reviewers: reviewersWithBefore, durationMs: (pending.beforeAudit?.durationMs ?? 0) + afterDurationMs, warnings };
  const diagnostic = createReviewRejectionDiagnostic({ ...audit, filePath: context.toolName });
  if (diagnostic) notify(context.ctx, diagnostic, "error");
  return { ...result, details: { ...(result.details ?? {}), fileEditReview: audit }, content: diagnostic ? [...result.content, { type: "text", text: diagnostic }] : result.content };
}

/** Completes the file review lifecycle and applies the configured output bound. */
async function processFileReviewResult(
  context: FileReviewExecutionContext,
  pending: PendingFileReviewCall,
  result: ToolResult,
): Promise<ToolResult> {
  const { loaded } = pending;
  if (pending.beforeAudit && pending.beforeAudit.status === REJECTED_STATUS) {
    return { ...result, details: { ...(result.details ?? {}), fileEditReview: pending.beforeAudit } };
  }
  if (!pending.snapshot) return processGenericReviewResult(context, pending, result);
  return reviewToolResult({
    context,
    toolName: pending.toolName as typeof EDIT_TOOL | typeof WRITE_TOOL,
    config: loaded.config,
    configWarnings: loaded.warnings,
    snapshot: pending.snapshot,
    fallbackDiff: pending.fallbackDiff,
    result,
    afterReviewers: pending.afterReviewers,
    beforeAudit: pending.beforeAudit,
  });
}

/** 把配置写回 config.json，并在重新加载出现警告时显式提示（不静默降级）。 */
async function saveFileEditReviewConfig(
  ctx: ExtensionCommandContext,
  config: FileEditReviewConfig,
  configPath: string,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const saved = loadFileEditReviewConfig(configPath);
  if (saved.warnings.length > 0) {
    notify(ctx, i18n.t("savedWarnings", { warnings: saved.warnings.join(" ") }), "warning");
  }
}

/**
 * 新增 reviewer：依次问出名称、引擎、模型、规则文件，凑齐后返回配置对象。
 * 任一步取消或校验失败就返回 undefined，由调用方放弃这次新增。
 */
async function askNewReviewer(
  ctx: ExtensionCommandContext,
  reviewers: FileEditReviewReviewerConfig[],
): Promise<FileEditReviewReviewerConfig | undefined> {
  const name = (await ctx.ui.input(i18n.t("reviewerName"), `reviewer-${reviewers.length + 1}`))?.trim();
  if (!name) return undefined;
  const backend = await ctx.ui.select(i18n.t("backendInput"), [i18n.t("backendModel"), i18n.t("backendTypesafe")]);
  if (!backend) return undefined;
  const isTypesafe = backend === i18n.t("backendTypesafe");
  if (isTypesafe) {
    const model = await ctx.ui.input(i18n.t("typesafeModelInput"), DEFAULT_TYPESAFE_MODEL);
    if (model === undefined) return undefined;
    const rulesFiles = await askRuleFiles(ctx);
    if (!rulesFiles) return undefined;
    return {
      name,
      backend: TYPE_SAFE_BACKEND,
      typesafeModel: model.trim() || DEFAULT_TYPESAFE_MODEL,
      rulesFiles,
      enabled: true,
      tools: [...DEFAULT_REVIEW_TOOLS],
      trigger: AFTER_TRIGGER,
    };
  }
  const model = (await ctx.ui.input(i18n.t("modelInput"), "llm-proxy/LOW"))?.trim();
  if (!model || !/^[^/\s]+\/[^/\s]+$/.test(model)) {
    if (model !== undefined) notify(ctx, i18n.t("modelInvalid"), "error");
    return undefined;
  }
  const rulesFiles = await askRuleFiles(ctx);
  if (!rulesFiles) return undefined;
  return { name, model, rulesFiles, enabled: true, tools: [...DEFAULT_REVIEW_TOOLS], trigger: AFTER_TRIGGER };
}

/** 向新增流程要规则文件列表；至少一项，取消或留空都返回 undefined。 */
async function askRuleFiles(ctx: ExtensionCommandContext): Promise<string[] | undefined> {
  const value = await ctx.ui.input(i18n.t("listInput"), "");
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) {
    notify(ctx, i18n.t("listRequired"), "error");
    return undefined;
  }
  return items;
}

/**
 * 打开配置面板。
 *
 * 面板改一项就写盘一次，所以面板里改完就是运行期生效的配置，不需要 /reload。
 * 重新加载产生的警告照常提示，不静默吞掉。
 */
async function runReviewConfigPanel(ctx: ExtensionCommandContext, configPath: string): Promise<void> {
  /** 当前配置副本；面板读写都基于它，每次改动先同步更新它再排队写盘。 */
  let config = loadFileEditReviewConfig().config;
  /**
   * 写盘队列。
   *
   * SettingsList 的 onChange 是同步回调，无法 await，所以写盘按顺序排成一条链。
   * 内存里的 config 同步更新（面板下一次读到的就是最新值），磁盘写入按顺序跟上；
   * 面板关闭后等这条链清空，保证最后一次改动已经落盘（不静默丢改动）。
   */
  let pendingWrite: Promise<void> = Promise.resolve();
  /** 同步更新内存配置，排队写盘。 */
  const persist = (next: FileEditReviewConfig): Promise<void> => {
    config = next;
    pendingWrite = pendingWrite.then(() => saveFileEditReviewConfig(ctx, next, configPath));
    return pendingWrite;
  };
  const loaded = loadFileEditReviewConfig();
  if (loaded.warnings.length > 0) {
    notify(ctx, i18n.t("configWarnings", { warnings: loaded.warnings.join(" ") }), "warning");
  }

  await openSupervisorPanel(ctx, {
    getConfig: () => config,
    getModels: () => ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, model: model.id })),
    onChange: (next) => {
      void persist(next);
    },
    onAddReviewer: async (current) => {
      const reviewer = await askNewReviewer(ctx, current.reviewers);
      if (!reviewer) return undefined;
      await persist({ ...current, reviewers: [...current.reviewers, reviewer] });
      return reviewer;
    },
  });
  // 面板已关，但可能还有排队的写盘；等它们完成再返回。
  await pendingWrite;
}

function registerReviewConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("commandDescription"),
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        notify(ctx, i18n.t("interactiveOnly"), "warning");
        return;
      }
      await runReviewConfigPanel(ctx, getPiSupervisorConfigPath());
    },
  };
  for (const name of ["config:tool-supervisor", "pi-tool-supervisor"] as const) {
    pi.registerCommand(name, command);
  }
}

export default function piSupervisorExtension(pi: ExtensionAPI) {
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  const pendingCalls = new Map<string, PendingFileReviewCall>();
  const disposeToolDisplayMiddleware = registerSupervisorToolDisplayMiddleware();
  registerSupervisorFallbackRenderer(pi);
  pi.on("tool_call", async (event, ctx) => {
    const context: FileReviewExecutionContext = {
      event,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      params: event.input,
      signal: ctx.signal,
      ctx,
    };
    const pending = await prepareFileReviewCall(context);
    pendingCalls.set(event.toolCallId, pending);
    if (pending.beforeAudit?.status === REJECTED_STATUS) {
      const diagnostic = createReviewRejectionDiagnostic(pending.beforeAudit);
      if (diagnostic) notify(ctx, diagnostic, "error");
      pendingCalls.delete(event.toolCallId);
      appendSupervisorFallbackAudit(pi, event.toolName, { fileEditReview: pending.beforeAudit });
      return { block: true, reason: diagnostic ?? i18n.t("beforeReviewRejectedFallback", { toolName: event.toolName }) };
    }
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const pending = pendingCalls.get(event.toolCallId);
    if (!pending) return;
    pendingCalls.delete(event.toolCallId);
    const result = await processFileReviewResult(
      {
        event,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        params: pending.params,
        signal: ctx.signal,
        ctx,
      },
      pending,
      {
        content: event.content,
        details: event.details as Record<string, unknown> | undefined,
        isError: event.isError,
      },
    );
    if (!isSupervisorToolDisplayMiddlewareActive(event.toolName)) {
      appendSupervisorFallbackAudit(pi, event.toolName, result.details);
    }
    return {
      content: result.content as ToolResultEvent["content"],
      details: result.details,
      isError: result.isError,
    };
  });
  pi.on("agent_end", () => pendingCalls.clear());
  pi.on("session_shutdown", () => disposeToolDisplayMiddleware());
  registerReviewConfigCommand(pi);
}
