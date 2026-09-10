import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXTENSIONS_DIRECTORY = "extensions";
const PACKAGE_NAME = "pi-auto-goal";
const CONFIG_FILE_NAME = "config.json";
const UTF8_ENCODING = "utf8";
const FILE_NOT_FOUND_CODE = "ENOENT";

/** pi-auto-goal 配置；字段含义见 config.example.json 与 SKILL.md。 */
export type ForcedDecision = "auto" | "continue" | "stop";

/** pi-auto-goal 配置；字段含义见 config.example.json 与 SKILL.md。 */
export interface AutoGoalConfig {
  /** 是否启用提前停止判定。 */
  enabled: boolean;
  /** 判定模型 "provider/modelId"；空字符串表示复用当前会话模型。 */
  model: string;
  /** 同一条用户请求允许的最大自动干预次数；0 表示不限制。 */
  maxAutoContinues: number;
  /** 判定为「应继续」所需的最低置信度。 */
  confidenceThreshold: number;
  /** 单次判定请求的超时秒数。 */
  timeoutSeconds: number;
  /** 是否把本轮工具调用轨迹交给判定模型。 */
  includeToolTrace: boolean;
  /** 交给判定模型的用户请求最大字符数。 */
  maxUserRequestChars: number;
  /** 交给判定模型的 agent 最后输出最大字符数。 */
  maxFinalOutputChars: number;
  /** 工具轨迹最多保留的调用条数。 */
  maxToolTraceEntries: number;
  /** 判定为「可以停止」时是否也弹出提示。 */
  notifyOnStopDecision: boolean;
  /** 自动催促消息模板；空字符串表示使用内置模板。支持 {reason} 占位。 */
  continueMessageTemplate: string;
  /** 受控实验：覆写判定结果；auto 表示正常判定。 */
  forcedDecision: ForcedDecision;
}

/** 默认自动干预次数：同一条用户请求最多催两次。 */
const DEFAULT_MAX_AUTO_CONTINUES = 2;
/** 默认置信度阈值：低于该值的「应继续」判定不触发干预。 */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
/** 默认判定请求超时秒数。 */
const DEFAULT_TIMEOUT_SECONDS = 30;
/** 默认交给判定模型的用户请求字符上限。 */
const DEFAULT_MAX_USER_REQUEST_CHARS = 2000;
/** 默认交给判定模型的 agent 最后输出字符上限。 */
const DEFAULT_MAX_FINAL_OUTPUT_CHARS = 4000;
/** 默认工具轨迹条数上限。 */
const DEFAULT_MAX_TOOL_TRACE_ENTRIES = 20;
/** 置信度下界。 */
const CONFIDENCE_THRESHOLD_MIN = 0;
/** 置信度上界。 */
const CONFIDENCE_THRESHOLD_MAX = 1;
/** 强制判定枚举。 */
const FORCED_DECISIONS = ["auto", "continue", "stop"] as const;
/** 超时秒数下界。 */
const TIMEOUT_SECONDS_MIN = 1;
/** 超时秒数上界，避免单次判定挂太久。 */
const TIMEOUT_SECONDS_MAX = 600;

/** 默认配置；未写配置文件时全部字段取这里的值。 */
export const DEFAULT_AUTO_GOAL_CONFIG: AutoGoalConfig = {
  enabled: true,
  model: "",
  maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES,
  confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  includeToolTrace: true,
  maxUserRequestChars: DEFAULT_MAX_USER_REQUEST_CHARS,
  maxFinalOutputChars: DEFAULT_MAX_FINAL_OUTPUT_CHARS,
  maxToolTraceEntries: DEFAULT_MAX_TOOL_TRACE_ENTRIES,
  notifyOnStopDecision: false,
  continueMessageTemplate: "",
  forcedDecision: "auto",
};

/** 布尔字段清单。 */
const BOOLEAN_FIELDS = ["enabled", "includeToolTrace", "notifyOnStopDecision"] as const;
/** 必须为正整数的字段清单。 */
const POSITIVE_INTEGER_FIELDS = ["maxUserRequestChars", "maxFinalOutputChars"] as const;
/** 允许为 0（表示不限制）的整数字段清单。 */
const NON_NEGATIVE_INTEGER_FIELDS = ["maxAutoContinues", "maxToolTraceEntries"] as const;
/** 字符串字段清单。 */
const STRING_FIELDS = ["model", "continueMessageTemplate"] as const;
/** 全部合法字段名；出现其它键即视为配置错误。 */
const KNOWN_FIELDS = new Set([
  ...BOOLEAN_FIELDS,
  ...POSITIVE_INTEGER_FIELDS,
  ...NON_NEGATIVE_INTEGER_FIELDS,
  ...STRING_FIELDS,
  "forcedDecision",
  "confidenceThreshold",
  "timeoutSeconds",
]);

/** 返回 pi-auto-goal 配置文件路径。 */
export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, EXTENSIONS_DIRECTORY, PACKAGE_NAME, CONFIG_FILE_NAME);
}

/** 模型字段格式：provider/modelId，provider 段允许字母数字点划线。 */
const MODEL_PATTERN = /^[\w.-]+\/[\w.\-:]+$/;

/** 校验整数字段，拒绝小数与越界值。 */
function parseInteger(raw: Record<string, unknown>, key: string, minimum: number): number {
  const value = raw[key];
  if (value === undefined) return DEFAULT_AUTO_GOAL_CONFIG[key as keyof AutoGoalConfig] as number;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${key} must be an integer >= ${minimum}`);
  }
  return value;
}

/** 校验数值字段，拒绝 NaN 与越界值。 */
function parseNumber(raw: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = raw[key];
  if (value === undefined) return DEFAULT_AUTO_GOAL_CONFIG[key as keyof AutoGoalConfig] as number;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

/** 解析并校验 pi-auto-goal 配置，未知字段直接报错而不是静默忽略。 */
export function parseConfig(value: unknown): AutoGoalConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) throw new Error(`unknown configuration field: ${key}`);
  }

  const config: AutoGoalConfig = { ...DEFAULT_AUTO_GOAL_CONFIG };
  for (const key of BOOLEAN_FIELDS) {
    const booleanValue = raw[key];
    if (booleanValue === undefined) continue;
    if (typeof booleanValue !== "boolean") throw new Error(`${key} must be a boolean`);
    config[key] = booleanValue;
  }
  for (const key of STRING_FIELDS) {
    const stringValue = raw[key];
    if (stringValue === undefined) continue;
    if (typeof stringValue !== "string") throw new Error(`${key} must be a string`);
    config[key] = stringValue;
  }
  for (const key of POSITIVE_INTEGER_FIELDS) {
    config[key] = parseInteger(raw, key, 1);
  }
  for (const key of NON_NEGATIVE_INTEGER_FIELDS) {
    config[key] = parseInteger(raw, key, 0);
  }
  config.confidenceThreshold = parseNumber(
    raw,
    "confidenceThreshold",
    CONFIDENCE_THRESHOLD_MIN,
    CONFIDENCE_THRESHOLD_MAX,
  );
  config.timeoutSeconds = parseNumber(raw, "timeoutSeconds", TIMEOUT_SECONDS_MIN, TIMEOUT_SECONDS_MAX);

  const model = config.model.trim();
  if (model && !MODEL_PATTERN.test(model)) {
    throw new Error('model must look like "provider/modelId" or be empty');
  }
  config.model = model;

  const forcedDecisionInput = raw.forcedDecision;
  let forcedDecision: string;
  if (forcedDecisionInput === undefined) {
    forcedDecision = config.forcedDecision;
  } else {
    if (typeof forcedDecisionInput !== "string") {
      throw new Error("forcedDecision must be a string");
    }
    forcedDecision = forcedDecisionInput;
  }

  if (!isForcedDecision(forcedDecision)) {
    throw new Error("forcedDecision must be one of: auto, continue, stop");
  }
  config.forcedDecision = forcedDecision;

  return config;
}

function isForcedDecision(value: string): value is ForcedDecision {
  return (FORCED_DECISIONS as readonly string[]).includes(value);
}

/** 读取配置文件；缺少文件时使用默认配置。 */
export function loadConfig(path = configPath()): AutoGoalConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, UTF8_ENCODING)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return { ...DEFAULT_AUTO_GOAL_CONFIG };
    throw error;
  }
}

/** 将经过校验的配置写入配置文件。 */
export function saveConfig(config: AutoGoalConfig, path = configPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, UTF8_ENCODING);
  return path;
}
