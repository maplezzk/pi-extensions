/**
 * 文件编辑侧边审查器。
 *
 * edit/write 已经执行完成后，提取实际文件变化并并发交给配置的审查模型。
 * 审查失败不回滚文件；不通过项会追加到 Agent 可见的 tool result，要求立即修正。
 * 配置文件位于 Pi 的用户扩展配置目录：
 * ~/.pi/agent/extensions/pi-tool-supervisor/config.json
 */

import { complete } from "@earendil-works/pi-ai/compat";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  buildEditFallbackDiff,
  buildFileEditReviewDiff,
  buildMergedReviewPrompt,
  getPiSupervisorConfigPath,
  getOverallReviewStatus,
  loadFileEditReviewConfig,
  loadReviewRules,
  parseReviewResponse,
  reviewerAppliesToFile,
  reviewerIsEditorLocal,
  reviewerMatchesTool,
  reviewerTrigger,
  safeSerialize,
  type FileEditReviewAudit,
  type FileEditReviewConfig,
  type FileEditReviewReviewerConfig,
  type FileEditReviewResult,
  type FileEditReviewRule,
  type ReviewTrigger,
} from "./review-utils.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));
const AFTER_TRIGGER: ReviewTrigger = "after";
const BEFORE_TRIGGER: ReviewTrigger = "before";
const MILLISECONDS_PER_SECOND = 1000;
const REVIEW_MAX_TOKENS = 1200;
const REJECTED_STATUS = "rejected" as const;
const SKIPPED_STATUS = "skipped" as const;
const EDIT_TOOL = "edit";
const WRITE_TOOL = "write";
const ALL_TOOLS = "*";
const DEFAULT_REVIEW_TOOLS = [EDIT_TOOL, WRITE_TOOL];
const REVIEW_TRIGGERS = [BEFORE_TRIGGER, AFTER_TRIGGER];
type ToolResult = {
  content: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

type FileReviewExecutionContext = {
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
  blockedReason?: string;
};

/** Extracts a file path when the selected tool exposes one. */
function getPath(params: Record<string, unknown>): string | undefined {
  const value = params.file_path ?? params.path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reads optional text fields without coercing arbitrary values. */
function getText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Narrows unknown event payloads without trusting arbitrary tool data. */
function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Joins text content for bounded result forwarding. */
function getTextContent(result: ToolResult): string {
  return result.content
    .filter((content) => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text ?? "")
    .join("\n");
}

/** Preserves oversized output in a temp file or visibly truncates it on write failure. */
async function limitReturnedToolResult(result: ToolResult, maxChars: number): Promise<ToolResult> {
  const text = getTextContent(result);
  if (text.length <= maxChars) return result;

  const directory = join(tmpdir(), "pi-tool-supervisor");
  const filePath = join(directory, `tool-output-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, text, "utf8");
    const pointer = `工具结果超过 ${maxChars} 个字符，已写入临时文件：${filePath}`;
    return {
      ...result,
      content: [{ type: "text", text: pointer.slice(0, maxChars) }],
      details: {
        ...(result.details ?? {}),
        outputTruncated: true,
        outputLimitChars: maxChars,
        fullOutputPath: filePath,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-tool-supervisor] ${i18n.t("tempFileWriteFailed", { message })}`);
    return {
      ...result,
      content: [{ type: "text", text: text.slice(0, maxChars) }],
      details: {
        ...(result.details ?? {}),
        outputTruncated: true,
        outputLimitChars: maxChars,
        outputFileError: message,
      },
    };
  }
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

/** Produces visible diagnostics for rejected and failed reviewers. */
function createReviewDiagnostic(
  audit: FileEditReviewAudit,
  configPath?: string,
): string | undefined {
  const rejected = audit.reviewers.filter((reviewer) => reviewer.status === "rejected");
  const failed = audit.reviewers.filter((reviewer) => reviewer.status === "failed");
  const lines: string[] = [];

  if (rejected.length > 0) {
    lines.push("[文件编辑审查未通过，必须立即修正]");
    lines.push(`文件：${audit.filePath}`);
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
  }

  if (failed.length > 0) {
    lines.push("[文件编辑审查未完成，已放行但必须注意]");
    lines.push(`文件：${audit.filePath}`);
    for (const reviewer of failed) {
      lines.push(`- ${reviewer.name}（${reviewer.rulesFiles?.join(", ") ?? reviewer.rulesFile ?? "未指定规则文件"}）：${reviewer.error ?? "审查模型调用失败"}`);
    }
    lines.push(`审查配置：${configPath ?? "未找到"}`);
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Executes one reviewer with parent cancellation and timeout fail-open behavior. */
async function reviewWithModel(options: {
  context: FileReviewExecutionContext;
  config: FileEditReviewConfig;
  reviewer: FileEditReviewRule["reviewer"];
  rules: FileEditReviewRule[];
  toolName: string;
  filePath?: string;
  diff: string;
  trigger?: ReviewTrigger;
}): Promise<FileEditReviewResult> {
  const { context, config, reviewer, rules, toolName, filePath, diff, trigger = AFTER_TRIGGER } = options;
  const startedAt = performance.now();
  const base = {
    name: reviewer.name,
    model: reviewer.model,
    rulesFiles: rules.map((rule) => rule.reviewer.rulesFile).filter((file): file is string => Boolean(file)),
  };
  if (context.signal?.aborted) {
    return {
      ...base,
      status: "skipped",
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
  const separator = reviewer.model.indexOf("/");
  const modelProvider = reviewer.model.slice(0, separator);
  const modelId = reviewer.model.slice(separator + 1);
  const model = context.ctx.modelRegistry.find(modelProvider, modelId);
  if (!model) {
    return {
      ...base,
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      error: `审查模型不存在：${reviewer.model}`,
    };
  }

  const controller = new AbortController();
  /** Propagates the parent abort signal to the reviewer request. */
  const abortFromParent = () => controller.abort();
  context.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * MILLISECONDS_PER_SECOND);
  try {
    const auth = await context.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) throw new Error(`审查模型鉴权失败：${auth.error}`);
    if (context.signal?.aborted) {
      return {
        ...base,
        status: "skipped",
        durationMs: Math.round(performance.now() - startedAt),
      };
    }
    const response = await complete(
      model,
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildMergedReviewPrompt({ toolName, filePath, diff, rules, trigger }) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        maxTokens: REVIEW_MAX_TOKENS,
        signal: controller.signal,
      },
    );
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
    return {
      ...base,
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", abortFromParent);
  }
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
  configPath: string;
  configWarnings: string[];
  snapshot: FileSnapshot;
  fallbackDiff: string;
  result: ToolResult;
  afterReviewers?: FileEditReviewReviewerConfig[];
  beforeAudit?: FileEditReviewAudit;
}): Promise<ToolResult> {
  const { context, toolName, config, configPath, configWarnings, snapshot, fallbackDiff, result, afterReviewers, beforeAudit } = options;
  const selectedReviewers = afterReviewers ?? config.reviewers.filter((reviewer) => reviewer.enabled !== false && reviewerTrigger(reviewer) === AFTER_TRIGGER && reviewerMatchesTool(reviewer, toolName));
  const beforeReviewers = beforeAudit?.reviewers ?? [];
  const startedAt = performance.now();
  if (context.signal?.aborted) {
    const audit: FileEditReviewAudit = {
      filePath: snapshot.filePath,
      toolName,
      status: "skipped",
      reviewers: [],
      durationMs: Math.round(performance.now() - startedAt),
      warnings: [...configWarnings, i18n.t("reviewAborted")],
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
    const skippedAfter = selectedReviewers.map((reviewer) => ({
      name: reviewer.name,
      model: reviewer.model,
      status: SKIPPED_STATUS,
      durationMs: 0,
      error: "工具调用失败，跳过 after 审查。",
    }));
    const reviewers = [...beforeReviewers, ...skippedAfter];
    const audit: FileEditReviewAudit = {
      ...auditBase,
      status: getOverallReviewStatus(reviewers),
      trigger: AFTER_TRIGGER,
      reviewers,
      durationMs: Math.round(performance.now() - startedAt),
    };
    return { ...result, details: { ...(result.details ?? {}), fileEditReview: audit } };
  }

  const diff = buildFileEditReviewDiff(snapshot.filePath, snapshot.before, snapshot.after, fallbackDiff);
  if (!diff) {
    const audit: FileEditReviewAudit = {
      ...auditBase,
      status: "skipped",
      reviewers: [],
      durationMs: Math.round(performance.now() - startedAt),
      warnings: [...configWarnings, "文件内容没有变化，跳过审查。"],
    };
    return { ...result, details: { ...(result.details ?? {}), fileEditReview: audit } };
  }

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
    return result;
  }
  const warnings = [
    ...configWarnings,
    ...applicableGroups.flatMap((group) => group.rules.flatMap((rule) => rule.warning ? [rule.warning] : [])),
  ];
  const reviewResults = await Promise.all([
    ...applicableGroups.map((group) =>
      reviewWithModel({ context, config, reviewer: group.reviewer, rules: group.rules, toolName, filePath: snapshot.filePath, diff }),
    ),
    ...applicableErrors.map((error) => Promise.resolve(error)),
  ]);
  const audit: FileEditReviewAudit = {
    ...auditBase,
    status: getOverallReviewStatus(reviewResults),
    trigger: AFTER_TRIGGER,
    reviewers: [...beforeReviewers, ...reviewResults],
    durationMs: Math.round(performance.now() - startedAt),
    warnings,
  };
  const diagnostic = createReviewDiagnostic(audit, configPath);
  if (diagnostic) {
    console.warn(`[pi-tool-supervisor] ${diagnostic.replaceAll("\n", " | ")}`);
  }
  return {
    ...result,
    details: { ...(result.details ?? {}), fileEditReview: audit },
    content: diagnostic
      ? [...result.content, { type: "text", text: diagnostic }]
      : result.content,
  };
}

/** Prepares pending lifecycle state for matching before and after reviewers. */
/** Executes matching before reviewers and returns the visible audit used for blocking. */
async function runBeforeReview(options: {
  context: FileReviewExecutionContext;
  loaded: ReturnType<typeof loadFileEditReviewConfig>;
  filePath?: string;
  fallbackDiff: string;
}): Promise<FileEditReviewAudit | undefined> {
  const { context, loaded, filePath, fallbackDiff } = options;
  const reviewers = loaded.config.reviewers.filter((reviewer) =>
    reviewer.enabled !== false && reviewerTrigger(reviewer) === BEFORE_TRIGGER && reviewerMatchesTool(reviewer, context.toolName),
  );
  if (reviewers.length === 0) return undefined;
  const startedAt = performance.now();
  const results: FileEditReviewResult[] = [];
  const isFileTool = context.toolName === EDIT_TOOL || context.toolName === WRITE_TOOL;
  const serializedPayload = isFileTool && filePath
    ? { text: buildFileEditReviewDiff(filePath, undefined, typeof context.params.content === "string" ? context.params.content : undefined, fallbackDiff) }
    : safeSerialize(context.params, loaded.config.maxOutputChars);
  const warnings = [...loaded.warnings];
  for (const reviewer of reviewers) {
    const loadedRules = loadReviewRules(reviewer, context.ctx.cwd, loaded.config.maxRuleLines);
    const rules = loadedRules.rules.filter((rule) => {
      if (rule.reviewer.enabled === false || !reviewerIsEditorLocal(rule.reviewer)) return false;
      return isFileTool && filePath
        ? reviewerAppliesToFile(rule.reviewer, filePath)
        : (rule.reviewer.filePatterns ?? []).length === 0;
    });
    warnings.push(...rules.flatMap((rule) => rule.warning ? [rule.warning] : []));
    results.push(...loadedRules.errors);
    if (rules.length > 0 && serializedPayload.error) {
      results.push({
        name: reviewer.name,
        model: reviewer.model,
        status: "failed",
        durationMs: 0,
        error: serializedPayload.error,
      });
    } else if (rules.length > 0) {
      results.push(await reviewWithModel({ context, config: loaded.config, reviewer, rules, toolName: context.toolName, filePath: isFileTool ? filePath : undefined, diff: serializedPayload.text ?? "", trigger: BEFORE_TRIGGER }));
    } else if (loadedRules.errors.length === 0) {
      results.push({ name: reviewer.name, model: reviewer.model, status: "skipped", durationMs: 0, error: "没有适用规则。" });
    }
  }
  return { status: getOverallReviewStatus(results), filePath, toolName: context.toolName, trigger: BEFORE_TRIGGER, reviewers: results, durationMs: Math.round(performance.now() - startedAt), warnings };
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
      console.warn(`[pi-tool-supervisor] ${loaded.warnings.join(" | ")}`);
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
  const reviewers = pending.afterReviewers;
  const results: FileEditReviewResult[] = isFailedToolResult(result)
    ? reviewers.map((reviewer) => ({ name: reviewer.name, model: reviewer.model, status: SKIPPED_STATUS, durationMs: 0, error: "工具调用失败，跳过 after 审查。" }))
    : [];
  if (!isFailedToolResult(result)) {
    const serializedPayload = safeSerialize({ input: pending.params, result: { content: result.content, details: result.details, isError: result.isError } }, pending.loaded.config.maxOutputChars);
    for (const reviewer of reviewers) {
      const loadedRules = loadReviewRules(reviewer, context.ctx.cwd, pending.loaded.config.maxRuleLines);
      const rules = loadedRules.rules.filter((rule) => rule.reviewer.enabled !== false && reviewerIsEditorLocal(rule.reviewer) && (rule.reviewer.filePatterns ?? []).length === 0);
      results.push(...loadedRules.errors);
      if (rules.length > 0 && serializedPayload.error) {
        results.push({ name: reviewer.name, model: reviewer.model, status: "failed", durationMs: 0, error: serializedPayload.error });
      } else if (rules.length > 0) {
        results.push(await reviewWithModel({ context, config: pending.loaded.config, reviewer, rules, toolName: context.toolName, diff: serializedPayload.text ?? "", trigger: AFTER_TRIGGER }));
      } else if (loadedRules.errors.length === 0) results.push({ name: reviewer.name, model: reviewer.model, status: "skipped", durationMs: 0, error: "没有适用的通用工具规则。" });
    }
  }
  const reviewersWithBefore = [...(pending.beforeAudit?.reviewers ?? []), ...results];
  const audit: FileEditReviewAudit = { status: getOverallReviewStatus(reviewersWithBefore), toolName: context.toolName, trigger: AFTER_TRIGGER, reviewers: reviewersWithBefore, durationMs: pending.beforeAudit?.durationMs ?? 0, warnings: [...pending.loaded.warnings] };
  const diagnostic = createReviewDiagnostic({ ...audit, filePath: context.toolName }, pending.loaded.configPath);
  return { ...result, details: { ...(result.details ?? {}), fileEditReview: audit }, content: diagnostic ? [...result.content, { type: "text", text: diagnostic }] : result.content };
}

/** Completes the file review lifecycle and applies the configured output bound. */
async function processFileReviewResult(
  context: FileReviewExecutionContext,
  pending: PendingFileReviewCall,
  result: ToolResult,
): Promise<ToolResult> {
  const { loaded } = pending;
  /** Bounds the returned tool text without changing the original error flag. */
  const finish = (candidate: ToolResult) =>
    limitReturnedToolResult(candidate, loaded.config.maxOutputChars);
  if (pending.beforeAudit && pending.beforeAudit.status === REJECTED_STATUS) {
    return finish({ ...result, details: { ...(result.details ?? {}), fileEditReview: pending.beforeAudit } });
  }
  if (!pending.snapshot) return finish(await processGenericReviewResult(context, pending, result));
  return finish(await reviewToolResult({
    context,
    toolName: pending.toolName as typeof EDIT_TOOL | typeof WRITE_TOOL,
    config: loaded.config,
    configPath: loaded.configPath,
    configWarnings: loaded.warnings,
    snapshot: pending.snapshot,
    fallbackDiff: pending.fallbackDiff,
    result,
    afterReviewers: pending.afterReviewers,
    beforeAudit: pending.beforeAudit,
  }));
}

async function inputPositiveInteger(
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

async function inputModel(
  ctx: ExtensionCommandContext,
  current: string,
): Promise<string | undefined> {
  const value = await ctx.ui.input(i18n.t("modelInput"), current);
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    ctx.ui.notify(i18n.t("modelInvalid"), "error");
    return undefined;
  }
  return normalized;
}

async function inputList(
  ctx: ExtensionCommandContext,
  title: string,
  current: string[],
  required: boolean,
): Promise<string[] | undefined> {
  const value = await ctx.ui.input(title, current.join(", "));
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (required && items.length === 0) {
    ctx.ui.notify(i18n.t("listRequired"), "error");
    return undefined;
  }
  return items;
}

/** Edits reviewer lifecycle fields and persists validated user choices through the caller. */
async function editReviewer(
  ctx: ExtensionCommandContext,
  reviewer: FileEditReviewReviewerConfig,
): Promise<"deleted" | "back"> {
  while (true) {
    const rulesFiles = reviewer.rulesFiles ?? (reviewer.rulesFile ? [reviewer.rulesFile] : []);
    const choices = [
      i18n.t("status", { value: reviewer.enabled === false ? i18n.t("disabled") : i18n.t("enabled") }),
      i18n.t("name", { value: reviewer.name }),
      i18n.t("model", { value: reviewer.model }),
      i18n.t("rules", { value: rulesFiles.join(", ") }),
      i18n.t("tools", { value: (reviewer.tools ?? DEFAULT_REVIEW_TOOLS).join(", ") }),
      i18n.t("triggerConfig", { value: reviewerTrigger(reviewer) }),
      i18n.t("patterns", { value: reviewer.filePatterns?.join(", ") || i18n.t("allFiles") }),
      i18n.t("deleteReviewer"),
      i18n.t("back"),
    ];
    const choice = await ctx.ui.select(i18n.t("editReviewer", { name: reviewer.name }), choices);
    if (choice === undefined || choice === i18n.t("back")) return "back";

    if (choice === choices[0]) {
      reviewer.enabled = reviewer.enabled === false;
    } else if (choice === choices[1]) {
      const value = await ctx.ui.input(i18n.t("reviewerName"), reviewer.name);
      if (value?.trim()) reviewer.name = value.trim();
    } else if (choice === choices[2]) {
      const value = await inputModel(ctx, reviewer.model);
      if (value !== undefined) reviewer.model = value;
    } else if (choice === choices[3]) {
      const value = await inputList(ctx, i18n.t("listInput"), rulesFiles, true);
      if (value !== undefined) {
        delete reviewer.rulesFile;
        reviewer.rulesFiles = value;
      }
    } else if (choice === choices[4]) {
      const value = await inputList(ctx, i18n.t("toolsInput"), reviewer.tools ?? DEFAULT_REVIEW_TOOLS, true);
      if (value !== undefined) reviewer.tools = value.includes(ALL_TOOLS) ? [ALL_TOOLS] : value;
    } else if (choice === choices[5]) {
      const value = await ctx.ui.select(i18n.t("triggerInput"), REVIEW_TRIGGERS);
      if (value) reviewer.trigger = value as ReviewTrigger;
    } else if (choice === choices[6]) {
      const value = await inputList(ctx, i18n.t("listInputOptional"), reviewer.filePatterns ?? [], false);
      if (value !== undefined) reviewer.filePatterns = value;
    } else if (choice === choices[7]) {
      const confirmed = await ctx.ui.confirm(
        i18n.t("deleteTitle"),
        i18n.t("deleteMessage", { name: reviewer.name }),
      );
      if (confirmed) return "deleted";
    }
  }
}

async function saveFileEditReviewConfig(
  ctx: ExtensionCommandContext,
  config: FileEditReviewConfig,
  configPath: string,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const saved = loadFileEditReviewConfig(configPath);
  if (saved.warnings.length > 0) {
    ctx.ui.notify(i18n.t("savedWarnings", { warnings: saved.warnings.join(" ") }), "warning");
  }
}

async function addReviewer(
  ctx: ExtensionCommandContext,
  reviewers: FileEditReviewReviewerConfig[],
): Promise<boolean> {
  const name = await ctx.ui.input(i18n.t("reviewerName"), `reviewer-${reviewers.length + 1}`);
  if (!name?.trim()) return false;
  const model = await inputModel(ctx, "llm-proxy/LOW");
  if (!model) return false;
  const rulesFiles = await inputList(ctx, i18n.t("listInput"), [], true);
  if (!rulesFiles) return false;
  reviewers.push({ name: name.trim(), model, rulesFiles, enabled: true, tools: [...DEFAULT_REVIEW_TOOLS], trigger: AFTER_TRIGGER });
  return true;
}

async function runReviewConfigUi(ctx: ExtensionCommandContext, configPath: string): Promise<void> {
  const loaded = loadFileEditReviewConfig();
  if (loaded.warnings.length > 0) {
    ctx.ui.notify(i18n.t("configWarnings", { warnings: loaded.warnings.join(" ") }), "warning");
  }
  const config: FileEditReviewConfig = {
    ...loaded.config,
    reviewers: loaded.config.reviewers.map((reviewer) => ({ ...reviewer })),
  };

  while (true) {
    const reviewerChoices = config.reviewers.map(
      (reviewer) => `${reviewer.enabled === false ? "○" : "●"} ${reviewer.name} · ${reviewer.model}`,
    );
    const choices = [
      i18n.t("enabledConfig", { value: config.enabled ? i18n.t("enabled") : i18n.t("disabled") }),
      i18n.t("timeoutConfig", { value: config.timeoutSeconds }),
      i18n.t("outputConfig", { value: config.maxOutputChars }),
      i18n.t("rulesConfig", { value: config.maxRuleLines }),
      ...reviewerChoices,
      i18n.t("addReviewer"),
    ];
    const choice = await ctx.ui.select(i18n.t("configTitle"), choices);
    if (choice === undefined) return;

    if (choice === choices[0]) {
      config.enabled = !config.enabled;
      await saveFileEditReviewConfig(ctx, config, configPath);
    } else if (choice === choices[1]) {
      const value = await inputPositiveInteger(ctx, i18n.t("timeoutInput"), config.timeoutSeconds);
      if (value !== undefined) {
        config.timeoutSeconds = value;
        await saveFileEditReviewConfig(ctx, config, configPath);
      }
    } else if (choice === choices[2]) {
      const value = await inputPositiveInteger(ctx, i18n.t("outputInput"), config.maxOutputChars);
      if (value !== undefined) {
        config.maxOutputChars = value;
        await saveFileEditReviewConfig(ctx, config, configPath);
      }
    } else if (choice === choices[3]) {
      const value = await inputPositiveInteger(ctx, i18n.t("rulesInput"), config.maxRuleLines);
      if (value !== undefined) {
        config.maxRuleLines = value;
        await saveFileEditReviewConfig(ctx, config, configPath);
      }
    } else if (choice === choices[4 + config.reviewers.length]) {
      const added = await addReviewer(ctx, config.reviewers);
      if (added) await saveFileEditReviewConfig(ctx, config, configPath);
    } else if (choice.startsWith("● ") || choice.startsWith("○ ")) {
      const index = reviewerChoices.indexOf(choice);
      if (index >= 0) {
        const result = await editReviewer(ctx, config.reviewers[index]);
        if (result === "deleted") config.reviewers.splice(index, 1);
        await saveFileEditReviewConfig(ctx, config, configPath);
      }
    }
  }
}

function registerReviewConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("commandDescription"),
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("interactiveOnly"), "warning");
        return;
      }
      await runReviewConfigUi(ctx, getPiSupervisorConfigPath());
    },
  };
  for (const name of ["config:tool-supervisor", "pi-tool-supervisor"] as const) {
    pi.registerCommand(name, command);
  }
}

export default function piSupervisorExtension(pi: ExtensionAPI) {
  const pendingCalls = new Map<string, PendingFileReviewCall>();
  const disposeToolDisplayMiddleware = registerSupervisorToolDisplayMiddleware();
  registerSupervisorFallbackRenderer(pi);
  pi.on("tool_call", async (event, ctx) => {
    const context: FileReviewExecutionContext = {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      params: event.input,
      signal: ctx.signal,
      ctx,
    };
    const pending = await prepareFileReviewCall(context);
    pendingCalls.set(event.toolCallId, pending);
    if (pending.beforeAudit?.status === REJECTED_STATUS) {
      pendingCalls.delete(event.toolCallId);
      appendSupervisorFallbackAudit(pi, event.toolName, { fileEditReview: pending.beforeAudit });
      return { block: true, reason: createReviewDiagnostic(pending.beforeAudit, pending.loaded.configPath) ?? `工具 ${event.toolName} 未通过前置审查。` };
    }
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const pending = pendingCalls.get(event.toolCallId);
    if (!pending) return;
    pendingCalls.delete(event.toolCallId);
    const result = await processFileReviewResult(
      {
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
