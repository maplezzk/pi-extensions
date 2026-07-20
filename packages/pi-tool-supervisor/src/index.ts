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
  type FileEditReviewAudit,
  type FileEditReviewConfig,
  type FileEditReviewReviewerConfig,
  type FileEditReviewResult,
  type FileEditReviewRule,
} from "./review-utils.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

type ToolResult = {
  content: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

type FileReviewExecutionContext = {
  toolName: "edit" | "write";
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
  toolName: "edit" | "write";
  params: Record<string, unknown>;
  loaded: ReturnType<typeof loadFileEditReviewConfig>;
  snapshot?: FileSnapshot;
  fallbackDiff: string;
};

function getPath(params: Record<string, unknown>): string | undefined {
  const value = params.file_path ?? params.path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getTextContent(result: ToolResult): string {
  return result.content
    .filter((content) => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text ?? "")
    .join("\n");
}

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
    console.warn(`[pi-tool-supervisor] 超长工具结果写入临时文件失败，已截断返回：${message}`);
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

function isFailedToolResult(result: ToolResult): boolean {
  return result.isError === true || getRecord(result).isError === true;
}

async function readOptionalFile(filePath: string): Promise<{ content?: string; error?: string }> {
  try {
    return { content: await readFile(filePath, "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

async function captureBefore(filePath: string): Promise<{ content?: string; error?: string }> {
  return readOptionalFile(filePath);
}

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

async function reviewWithModel(
  context: FileReviewExecutionContext,
  config: FileEditReviewConfig,
  reviewer: FileEditReviewRule["reviewer"],
  rules: FileEditReviewRule[],
  toolName: "edit" | "write",
  filePath: string,
  diff: string,
): Promise<FileEditReviewResult> {
  const startedAt = performance.now();
  const base = {
    name: reviewer.name,
    model: reviewer.model,
    rulesFiles: rules.map((rule) => rule.reviewer.rulesFile).filter((file): file is string => Boolean(file)),
  };
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
  const abortFromParent = () => controller.abort();
  context.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
  try {
    const auth = await context.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) throw new Error(`审查模型鉴权失败：${auth.error}`);
    const response = await complete(
      model,
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildMergedReviewPrompt(toolName, filePath, diff, rules) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        maxTokens: 1200,
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

async function reviewToolResult(
  context: FileReviewExecutionContext,
  toolName: "edit" | "write",
  config: FileEditReviewConfig,
  configPath: string,
  configWarnings: string[],
  snapshot: FileSnapshot,
  fallbackDiff: string,
  result: ToolResult,
): Promise<ToolResult> {
  const startedAt = performance.now();
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
    const audit: FileEditReviewAudit = {
      ...auditBase,
      status: "skipped",
      reviewers: [],
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

  const reviewerGroups = config.reviewers
    .filter((reviewer) => reviewer.enabled !== false)
    .map((reviewer) => {
      const loaded = loadReviewRules(reviewer, context.ctx.cwd, config.maxRuleLines);
      const applicableRules = loaded.rules.filter((rule) =>
        rule.reviewer.enabled !== false &&
        reviewerIsEditorLocal(rule.reviewer) &&
        reviewerAppliesToFile(rule.reviewer, snapshot.filePath),
      );
      return { reviewer, rules: applicableRules, errors: loaded.errors };
    });
  const applicableGroups = reviewerGroups.filter((group) => group.rules.length > 0);
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
      reviewWithModel(context, config, group.reviewer, group.rules, toolName, snapshot.filePath, diff),
    ),
    ...applicableErrors.map((error) => Promise.resolve(error)),
  ]);
  const audit: FileEditReviewAudit = {
    ...auditBase,
    status: getOverallReviewStatus(reviewResults),
    reviewers: reviewResults,
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

async function prepareFileReviewCall(
  context: FileReviewExecutionContext,
): Promise<PendingFileReviewCall> {
  const loaded = loadFileEditReviewConfig();
  const pending: PendingFileReviewCall = {
    toolName: context.toolName,
    params: { ...context.params },
    loaded,
    fallbackDiff: "",
  };
  if (!loaded.config.enabled) {
    if (loaded.warnings.length > 0) {
      console.warn(`[pi-tool-supervisor] ${loaded.warnings.join(" | ")}`);
    }
    return pending;
  }

  const filePath = getPath(context.params);
  if (!filePath || !loaded.config.reviewers.some((reviewer) =>
    reviewer.enabled && reviewerAppliesToFile(reviewer, filePath))) {
    return pending;
  }
  const prepared = await createSnapshot(context, context.toolName);
  pending.snapshot = prepared.snapshot;
  pending.fallbackDiff = prepared.fallbackDiff;
  return pending;
}

async function processFileReviewResult(
  context: FileReviewExecutionContext,
  pending: PendingFileReviewCall,
  result: ToolResult,
): Promise<ToolResult> {
  const { loaded } = pending;
  const finish = (candidate: ToolResult) =>
    limitReturnedToolResult(candidate, loaded.config.maxOutputChars);
  if (!pending.snapshot) return finish(result);
  return finish(await reviewToolResult(
    context,
    pending.toolName,
    loaded.config,
    loaded.configPath,
    loaded.warnings,
    pending.snapshot,
    pending.fallbackDiff,
    result,
  ));
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
      const value = await inputList(ctx, i18n.t("listInputOptional"), reviewer.filePatterns ?? [], false);
      if (value !== undefined) reviewer.filePatterns = value;
    } else if (choice === choices[5]) {
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
  reviewers.push({ name: name.trim(), model, rulesFiles, enabled: true });
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
  pi.registerCommand("pi-tool-supervisor", {
    description: i18n.t("commandDescription"),
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("interactiveOnly"), "warning");
        return;
      }
      await runReviewConfigUi(ctx, getPiSupervisorConfigPath());
    },
  });
}

export default function piSupervisorExtension(pi: ExtensionAPI) {
  const pendingCalls = new Map<string, PendingFileReviewCall>();
  const disposeToolDisplayMiddleware = registerSupervisorToolDisplayMiddleware();
  registerSupervisorFallbackRenderer(pi);
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const context: FileReviewExecutionContext = {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      params: event.input,
      ctx,
    };
    pendingCalls.set(event.toolCallId, await prepareFileReviewCall(context));
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const pending = pendingCalls.get(event.toolCallId) ?? {
      toolName: event.toolName,
      params: { ...event.input },
      loaded: loadFileEditReviewConfig(),
      fallbackDiff: "",
    };
    pendingCalls.delete(event.toolCallId);
    const result = await processFileReviewResult(
      {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        params: pending.params,
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
