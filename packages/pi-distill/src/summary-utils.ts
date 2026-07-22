import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/summary-utils.json", import.meta.url)));

const DEFAULT_MIN_CHARS = 200;
const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_OUTPUT_CHARS = 10_000;
const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_MISSED_COMPRESSION_RATIO = 10;
const DEFAULT_SUMMARIZE_ERRORS = true;
const DEFAULT_RENDER_ENABLED = true;
const DEFAULT_RENDER_PROMPT = true;
const DEFAULT_RENDER_RESULT = true;
const CONFIG_DIRECTORY = "pi-distill";
const CONFIG_FILE_NAME = "config.json";

export interface BashSummaryConfig {
  /** 未配置时使用当前会话模型。 */
  modelProvider?: string;
  modelId?: string;
  /** 输出达到此字符数后才调用提炼模型。 */
  minChars: number;
  /** 提炼结果达到此字符数后写入文件。 */
  maxChars: number;
  /** 最终返回给 Agent 的内容达到此字符数后写入文件。 */
  maxOutputChars: number;
  /** 模型调用最长等待时间。 */
  timeoutSeconds: number;
  /** 无 prompt 的长输出触发 missed-compression 提醒所需的倍数。 */
  missedCompressionRatio: number;
  /** 工具返回错误结果时是否仍调用提炼模型。 */
  summarizeErrors: boolean;
}

export type DistillConfig = BashSummaryConfig;

export interface DistillRenderConfig {
  enabled: boolean;
  showPrompt: boolean;
  showResult: boolean;
}

export interface DistillConfigFile {
  enabled?: boolean;
  /** provider/model；为空时使用当前会话模型。 */
  model?: string;
  minChars?: number;
  maxChars?: number;
  maxOutputChars?: number;
  timeoutSeconds?: number;
  missedCompressionRatio?: number;
  summarizeErrors?: boolean;
  render?: Partial<DistillRenderConfig>;
}

export interface DistillConfigLoadResult {
  config?: BashSummaryConfig;
  enabled: boolean;
  render: DistillRenderConfig;
  configPath: string;
  warnings: string[];
}

export function resolvePiAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const configuredDir = env.PI_CODING_AGENT_DIR;
  if (!configuredDir) return join(homeDirectory, ".pi", "agent");
  if (configuredDir === "~") return homeDirectory;
  if (configuredDir.startsWith("~/") || configuredDir.startsWith("~\\")) {
    return join(homeDirectory, configuredDir.slice(2));
  }
  return configuredDir;
}

export function getDistillConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolvePiAgentDir(env), "extensions", CONFIG_DIRECTORY, CONFIG_FILE_NAME);
}

/**
 * 解析环境变量配置。保留此函数作为旧调用方的兼容 API；配置文件优先级由
 * loadDistillConfig() 负责处理。
 */
export function parseBashSummaryConfig(
  env: NodeJS.ProcessEnv = process.env,
): BashSummaryConfig | undefined {
  const modelRef = (env.PI_DISTILL_MODEL ?? env.PI_BASH_SUMMARY_MODEL)?.trim();
  const minCharsValue = (env.PI_DISTILL_MIN_CHARS ?? env.PI_BASH_SUMMARY_MIN_CHARS)?.trim();
  const maxCharsValue = (env.PI_DISTILL_MAX_CHARS ?? env.PI_BASH_SUMMARY_MAX_CHARS)?.trim();
  const maxOutputCharsValue = (
    env.PI_DISTILL_MAX_OUTPUT_CHARS ?? env.PI_BASH_SUMMARY_MAX_OUTPUT_CHARS
  )?.trim();
  const timeoutSecondsValue = (
    env.PI_DISTILL_TIMEOUT_SECONDS ?? env.PI_BASH_SUMMARY_TIMEOUT_SECONDS
  )?.trim();
  const missedCompressionRatioValue = (
    env.PI_DISTILL_MISSED_COMPRESSION_RATIO ?? env.PI_BASH_SUMMARY_MISSED_COMPRESSION_RATIO
  )?.trim();
  const summarizeErrorsValue = (
    env.PI_DISTILL_SUMMARIZE_ERRORS ?? env.PI_BASH_SUMMARY_SUMMARIZE_ERRORS
  )?.trim();
  const minChars = minCharsValue
    ? parsePositiveInteger(minCharsValue)
    : DEFAULT_MIN_CHARS;
  const maxChars = maxCharsValue
    ? parsePositiveInteger(maxCharsValue)
    : DEFAULT_MAX_CHARS;
  const maxOutputChars = maxOutputCharsValue
    ? parsePositiveInteger(maxOutputCharsValue)
    : DEFAULT_MAX_OUTPUT_CHARS;
  const timeoutSeconds = timeoutSecondsValue
    ? parsePositiveInteger(timeoutSecondsValue)
    : DEFAULT_TIMEOUT_SECONDS;
  const missedCompressionRatio = missedCompressionRatioValue
    ? parsePositiveNumber(missedCompressionRatioValue)
    : DEFAULT_MISSED_COMPRESSION_RATIO;
  const summarizeErrors = summarizeErrorsValue
    ? parseBoolean(summarizeErrorsValue)
    : DEFAULT_SUMMARIZE_ERRORS;

  if (
    minChars === undefined ||
    maxChars === undefined ||
    timeoutSeconds === undefined ||
    maxOutputChars === undefined ||
    missedCompressionRatio === undefined ||
    summarizeErrors === undefined
  ) {
    console.warn(
      "[pi-distill] Invalid distillation config; distillation disabled. Check PI_DISTILL_MIN_CHARS, PI_DISTILL_MAX_CHARS, PI_DISTILL_MAX_OUTPUT_CHARS, PI_DISTILL_TIMEOUT_SECONDS, PI_DISTILL_MISSED_COMPRESSION_RATIO, and PI_DISTILL_SUMMARIZE_ERRORS (legacy PI_BASH_SUMMARY_* variables remain supported).",
    );
    return undefined;
  }

  if (!modelRef) {
    return {
      minChars,
      maxChars,
      maxOutputChars,
      timeoutSeconds,
      missedCompressionRatio,
      summarizeErrors,
    };
  }

  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) {
    console.warn(
      `[pi-distill] Invalid PI_DISTILL_MODEL; expected provider/model, got: ${modelRef}`,
    );
    return undefined;
  }

  return {
    modelProvider: modelRef.slice(0, separator),
    modelId: modelRef.slice(separator + 1),
    minChars,
    maxChars,
    maxOutputChars,
    timeoutSeconds,
    missedCompressionRatio,
    summarizeErrors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumber(value: string): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string): boolean | undefined {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function parseRenderConfig(
  file: Record<string, unknown> | undefined,
  warnings: string[],
): DistillRenderConfig {
  const render: DistillRenderConfig = {
    enabled: DEFAULT_RENDER_ENABLED,
    showPrompt: DEFAULT_RENDER_PROMPT,
    showResult: DEFAULT_RENDER_RESULT,
  };
  if (!file || !("render" in file)) return render;
  if (!isRecord(file.render)) {
    warnings.push("Config field render must be an object.");
    return render;
  }

  for (const key of ["enabled", "showPrompt", "showResult"] as const) {
    if (!(key in file.render)) continue;
    const value = file.render[key];
    if (typeof value === "boolean") render[key] = value;
    else warnings.push(`Config field render.${key} must be boolean.`);
  }
  return render;
}

function appendFileValueToEnv(
  env: NodeJS.ProcessEnv,
  file: Record<string, unknown>,
  key: keyof DistillConfigFile,
  envKey: string,
  warnings: string[],
): void {
  if (!(key in file)) return;
  const value = file[key];
  if (key === "model") {
    if (value === undefined || value === null || value === "") {
      env[envKey] = "";
      return;
    }
    if (typeof value !== "string" || !value.trim()) {
      warnings.push(`Config field ${key} must be a provider/model string.`);
      env[envKey] = "__invalid_file_value__";
      return;
    }
    env[envKey] = value.trim();
    return;
  }

  if (key === "summarizeErrors") {
    if (typeof value !== "boolean") {
      warnings.push(`Config field ${key} must be boolean.`);
      env[envKey] = "__invalid_file_value__";
      return;
    }
    env[envKey] = String(value);
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`Config field ${key} must be a positive number.`);
    env[envKey] = "__invalid_file_value__";
    return;
  }
  env[envKey] = String(value);
}

/**
 * 读取 pi-distill 配置。配置文件字段优先于新旧环境变量；未在文件中声明的字段
 * 回退到 PI_DISTILL_*、旧 PI_BASH_SUMMARY_*，再回退到默认值。
 */
export function loadDistillConfig(
  env: NodeJS.ProcessEnv = process.env,
  configFile = getDistillConfigPath(env),
): DistillConfigLoadResult {
  const warnings: string[] = [];
  let enabled = true;
  let file: Record<string, unknown> | undefined;

  if (existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        warnings.push(`Distill config must be a JSON object: ${configFile}`);
      } else {
        file = parsed;
        if ("enabled" in parsed) {
          if (typeof parsed.enabled === "boolean") enabled = parsed.enabled;
          else warnings.push("Config field enabled must be boolean.");
        }
      }
    } catch (error) {
      warnings.push(`Could not parse Distill config ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const effectiveEnv = { ...env };
  if (file) {
    appendFileValueToEnv(effectiveEnv, file, "model", "PI_DISTILL_MODEL", warnings);
    appendFileValueToEnv(effectiveEnv, file, "minChars", "PI_DISTILL_MIN_CHARS", warnings);
    appendFileValueToEnv(effectiveEnv, file, "maxChars", "PI_DISTILL_MAX_CHARS", warnings);
    appendFileValueToEnv(effectiveEnv, file, "maxOutputChars", "PI_DISTILL_MAX_OUTPUT_CHARS", warnings);
    appendFileValueToEnv(effectiveEnv, file, "timeoutSeconds", "PI_DISTILL_TIMEOUT_SECONDS", warnings);
    appendFileValueToEnv(
      effectiveEnv,
      file,
      "missedCompressionRatio",
      "PI_DISTILL_MISSED_COMPRESSION_RATIO",
      warnings,
    );
    appendFileValueToEnv(
      effectiveEnv,
      file,
      "summarizeErrors",
      "PI_DISTILL_SUMMARIZE_ERRORS",
      warnings,
    );
  }

  const config = parseBashSummaryConfig(effectiveEnv);
  const render = parseRenderConfig(file, warnings);
  if (!config && warnings.length === 0) {
    warnings.push("Distill config is invalid; output distillation is disabled.");
  }
  return { config, enabled, render, configPath: configFile, warnings };
}

export function defaultDistillConfigFile(): DistillConfigFile {
  return {
    enabled: true,
    model: "",
    minChars: DEFAULT_MIN_CHARS,
    maxChars: DEFAULT_MAX_CHARS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    missedCompressionRatio: DEFAULT_MISSED_COMPRESSION_RATIO,
    summarizeErrors: DEFAULT_SUMMARIZE_ERRORS,
    render: {
      enabled: DEFAULT_RENDER_ENABLED,
      showPrompt: DEFAULT_RENDER_PROMPT,
      showResult: DEFAULT_RENDER_RESULT,
    },
  };
}

export const MIN_EFFECTIVE_COMPRESSION_RATIO = 1.4;

export type OutputSummaryIntent = "none" | "full" | "summary";

export type OutputSummaryDecision = {
  intent: OutputSummaryIntent;
  shouldSummarize: boolean;
  reason: "disabled" | "not-requested" | "full-output" | "below-threshold" | "explicit-summary" | "error-output";
};

export function classifyOutputSummaryIntent(prompt: string | undefined): OutputSummaryIntent {
  const normalizedPrompt = prompt?.trim() ?? "";
  if (!normalizedPrompt) return "none";
  if (/^RAW$/i.test(normalizedPrompt)) return "full";
  return "summary";
}

/** 总结模型的保留原文哨兵，只接受不带其他内容的 RAW。 */
export function isRawSummary(text: string | undefined): boolean {
  return typeof text === "string" && /^RAW$/i.test(text.trim());
}

/** 摘要没有达到最低压缩收益时，安全地恢复原始工具输出。 */
export function shouldFallbackToOriginal(originalChars: number, summaryChars: number): boolean {
  if (originalChars <= 0 || summaryChars <= 0) return false;
  return originalChars / summaryChars < MIN_EFFECTIVE_COMPRESSION_RATIO;
}

export function decideOutputSummary(
  prompt: string | undefined,
  output: string,
  config: BashSummaryConfig | undefined,
  isError = false,
): OutputSummaryDecision {
  const intent = classifyOutputSummaryIntent(prompt);
  if (!config) return { intent, shouldSummarize: false, reason: "disabled" };
  if (intent === "none") return { intent, shouldSummarize: false, reason: "not-requested" };
  if (intent === "full") return { intent, shouldSummarize: false, reason: "full-output" };
  if (isError && config.summarizeErrors) {
    return { intent, shouldSummarize: true, reason: "error-output" };
  }
  if (output.length < config.minChars) {
    return { intent, shouldSummarize: false, reason: "below-threshold" };
  }
  return { intent, shouldSummarize: true, reason: "explicit-summary" };
}

export function shouldSummarizeOutput(
  prompt: string | undefined,
  output: string,
  config: BashSummaryConfig | undefined,
  isError = false,
): boolean {
  return decideOutputSummary(prompt, output, config, isError).shouldSummarize;
}

export function buildSummarySystemPrompt(): string {
  return [
    i18n.t("system"),
    i18n.t("purpose"),
    i18n.t("method"),
    i18n.t("data"),
    i18n.t("preserve"),
    i18n.t("languageMatch"),
    i18n.t("exactRaw"),
    i18n.t("decisionProtocol"),
    i18n.t("sourceBoundary"),
    i18n.t("onlyResult"),
  ].join("\n");
}

export function buildSummaryUserPrompt(
  prompt: string,
  output: string,
  originalUserPrompt?: string,
): string {
  const languageContext = originalUserPrompt?.trim()
    ? [
        i18n.t("languageContext"),
        "<user-language-context>",
        originalUserPrompt.trim(),
        "</user-language-context>",
      ]
    : [];
  return [
    i18n.t("request"),
    prompt,
    ...(languageContext.length > 0 ? ["", ...languageContext] : []),
    "",
    "<tool-output>",
    output,
    "</tool-output>",
  ].join("\n");
}

export function buildSummaryPrompt(
  prompt: string,
  output: string,
  originalUserPrompt?: string,
): string {
  return [
    buildSummarySystemPrompt(),
    "",
    buildSummaryUserPrompt(prompt, output, originalUserPrompt),
  ].join("\n");
}
