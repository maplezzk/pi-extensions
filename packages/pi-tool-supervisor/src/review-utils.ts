import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import { createTwoFilesPatch } from "diff";

const i18n = createTranslator(loadCatalog(new URL("../locales/review-utils.json", import.meta.url)));

const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_MAX_FILE_CONTEXT_CHARS = 50_000;
const DIFF_CONTEXT_LINES = 3;
const FILE_CONTEXT_RADIUS_STEPS = [100, 50, 20, 10, 3, 0] as const;
const OMITTED_RANGE_START_OFFSET = 2;
const DEFAULT_MAX_RULE_LINES = 100;
const CONFIG_DIRECTORY = "pi-tool-supervisor";
const LEGACY_CONFIG_DIRECTORY = "pi-file-edit-review";
const CONFIG_FILE_NAME = "config.json";
const DEFAULT_REVIEW_TOOLS = ["edit", "write"];
const ALL_TOOLS = "*";
const REVIEW_TRIGGERS = ["before", "after"] as const;
const DEFAULT_REVIEW_TRIGGER: ReviewTrigger = "after";
export const REVIEW_BACKENDS = ["model", "typesafe"] as const;
/** 未配置 backend 时按对话模型审查，保持旧行为。 */
const DEFAULT_REVIEW_BACKEND: ReviewBackend = "model";
/** TypeSafe 模型名默认值；`typesafe/latest` 之类的别名由 TypeSafe 自行解析。 */
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
/** noul 达到该值即认为条款命中；可在规则文件 front matter 里覆盖。 */
export const DEFAULT_RULE_THRESHOLD = 0.85;
/** 规则文件去掉扩展名的认得的扩展名。 */
const RULE_FILE_EXTENSION = /\.(md|markdown|txt)$/i;
/** Severity that makes one finding actionable, and therefore blocking. */
const BLOCKING_SEVERITY = "error";
const INFO_SEVERITY = "info";
/** Rule group reported by findings the supervisor synthesizes itself. */
const SUPERVISOR_RULE_GROUP = "supervisor";
/** 二级标题；用来识别元指令段落边界。 */
const RULE_SECTION_HEADING = /^##\s+(.+?)\s*$/;
/** 编号条款：`1. 正文`。同一文件里的编号连续递增。 */
const CLAUSE_LINE = /^(\d+)\.\s+(\S.*)$/;
/** 条款正文里的粗体片段当规则名；没有时回退到编号。 */
const CLAUSE_TITLE = /\*\*(.+?)\*\*/;
/** 条款开头的历史 severity 标注；本后端不读它，但要从判据里剔掉。 */
const CLAUSE_SEVERITY_MARK = /^\[(?:error|warning|info)\]\s*/i;
/**
 * 元指令段落：讲的是「怎么报告」，不是「什么代码算违规」。
 * 这些段落里的编号条款不参与判断，否则 `ruleGroup 只能填…` 这类报告要求会被当成代码规则。
 */
const META_SECTION_PREFIX = "归属";

export type ReviewStatus = "passed" | "rejected" | "failed" | "skipped";
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];
/** 审查引擎：`model` 用 Pi 配置的对话模型，`typesafe` 用 TypeSafe System One 判断。 */
export type ReviewBackend = (typeof REVIEW_BACKENDS)[number];
/** 对话模型后端返回的 finding 级别；TypeSafe 后端不分级，命中即阻断。 */
export type RuleSeverity = "error" | "warning" | "info";

export interface FileEditReviewReviewerConfig {
  name: string;
  /** `model` backend 使用，格式为 `provider/model`；`typesafe` backend 不使用。 */
  model?: string;
  /** 审查引擎；省略时按 `model` 处理。 */
  backend?: ReviewBackend;
  /** `typesafe` backend 使用的 TypeSafe 模型名；省略时为 `jev-latest`。 */
  typesafeModel?: string;
  /** 兼容旧配置：单个规则文件。 */
  rulesFile?: string;
  /** 新配置：一个 reviewer 一次加载多个规则文件。 */
  rulesFiles?: string[];
  /** 兼容旧配置；新配置应放在规则文件 front matter 中。 */
  enabled?: boolean;
  /** 兼容旧配置；新配置应放在规则文件 front matter 中。 */
  filePatterns?: string[];
  complexity?: "local" | "context";
  consumers?: string[];
  /** 省略时兼容旧配置：仅审查 edit/write。 */
  tools?: string[];
  /** 省略时兼容旧配置：工具执行完成后审查。 */
  trigger?: ReviewTrigger;
  /** Optional local module that decides whether this reviewer applies. */
  condition?: string;
}

export interface FileEditReviewRuleMetadata {
  name?: string;
  enabled?: boolean;
  filePatterns?: string[];
  complexity?: "local" | "context";
  consumers?: string[];
  /** noul 达到该值即认为条款命中。 */
  threshold?: number;
}

/**
 * 规则文件里的一条编号条款。
 *
 * 规则文件是引擎无关的：条款正文就是判据，`## 归属与 severity` 这类元指令段落里的编号不参与判断。
 * `group` 沿用规则文件自己的叫法（如「必须遵守 1」），所以两个后端的 finding 看起来一致。
 */
export interface FileEditReviewRuleClause {
  /** 判断标识，形式为 `rule_<编号>`，同一文件内唯一。 */
  id: string;
  /** 审计和 finding 里显示的规则名，如「必须遵守 1 禁止魔法值」。 */
  group: string;
  /** 条款正文去掉 severity 标注后的文本；既当判据也当修复提示。 */
  text: string;
}

interface ParsedRuleFile {
  metadata: FileEditReviewRuleMetadata;
  content: string;
  clauses: FileEditReviewRuleClause[];
  warnings: string[];
}

/** 解析中途的条款草稿；正文按行累积，遇到下一条款或下一个二级标题才收尾。 */
interface ClauseDraft {
  number: number;
  section?: string;
  lines: string[];
}

/**
 * TypeSafe 连接设置；写在 config.json 里，不必依赖环境变量。
 *
 * 两个字段都可省略，省略时回退到对应环境变量（常量定义在 `typesafe-client.ts`）。
 */
export interface FileEditReviewTypeSafeConfig {
  /** TypeSafe API Key。 */
  apiKey?: string;
  /** TypeSafe 端点。 */
  endpoint?: string;
}

export interface FileEditReviewConfig {
  enabled: boolean;
  reviewers: FileEditReviewReviewerConfig[];
  /** TypeSafe 后端共用的连接设置。 */
  typesafe?: FileEditReviewTypeSafeConfig;
  timeoutSeconds: number;
  maxFileContextChars: number;
  maxRuleLines: number;
}

export interface FileEditReviewConfigLoadResult {
  config: FileEditReviewConfig;
  configPath: string;
  warnings: string[];
}

export interface FileEditReviewRule {
  reviewer: FileEditReviewReviewerConfig;
  absolutePath: string;
  content: string;
  lineCount: number;
  /** 规则 front matter 原文；判断后端用它决定规则标识。 */
  metadata: FileEditReviewRuleMetadata;
  /** 文件里切出的全部编号条款；元指令段落里的编号不在这里。 */
  clauses: FileEditReviewRuleClause[];
  warning?: string;
}

export interface CurrentFileContext {
  content: string;
  truncated: boolean;
}

export interface FileEditReviewFinding {
  severity?: "error" | "warning" | "info";
  message: string;
  line?: number;
  ruleGroup?: string;
}

export interface ParsedFileEditReviewResult {
  passed: boolean;
  summary: string;
  findings: FileEditReviewFinding[];
}

export interface FileEditReviewResult {
  name: string;
  model: string;
  rulesFile?: string;
  rulesFiles?: string[];
  status: ReviewStatus;
  summary?: string;
  findings?: FileEditReviewFinding[];
  durationMs: number;
  error?: string;
  /** 该 reviewer 自己产生的警告（例如规则缺判据、行定位被跳过）。 */
  warnings?: string[];
}

export interface FileEditReviewAudit {
  status: "disabled" | "passed" | "rejected" | "failed" | "skipped";
  filePath?: string;
  toolName: string;
  trigger?: ReviewTrigger;
  reviewers: FileEditReviewResult[];
  durationMs: number;
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

export function getPiSupervisorConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolvePiAgentDir(env), "extensions", CONFIG_DIRECTORY, CONFIG_FILE_NAME);
}

export function getLegacyFileEditReviewConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolvePiAgentDir(env), "extensions", LEGACY_CONFIG_DIRECTORY, CONFIG_FILE_NAME);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 只接受 (0, 1] 的概率阈值；其它值返回 undefined，由调用方明确报告。 */
function probabilityValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 1 ? numeric : undefined;
}

/** 解析 backend；字段缺失时用默认值，写了非法值返回 undefined 由调用方告警。 */
function backendValue(value: unknown): ReviewBackend | undefined {
  if (value === undefined) return DEFAULT_REVIEW_BACKEND;
  return REVIEW_BACKENDS.find((backend) => backend === value);
}

function parseModel(value: unknown): string | undefined {
  const model = stringValue(value);
  if (!model) return undefined;
  const separator = model.indexOf("/");
  return separator > 0 && separator < model.length - 1 ? model : undefined;
}

/** Normalizes one reviewer while preserving legacy defaults and reporting invalid lifecycle fields. */
/**
 * 解析 config.json 顶层的 typesafe 块。
 *
 * 不在这里校验字段是否齐全：两个字段都省略时返回 undefined，由连接层回退到环境变量。
 */
function parseTypeSafeConfig(value: unknown): FileEditReviewTypeSafeConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const apiKey = stringValue(source.apiKey);
  const endpoint = stringValue(source.endpoint);
  if (apiKey === undefined && endpoint === undefined) return undefined;
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

function normalizeReviewer(value: unknown, index: number, warnings: string[] = []): FileEditReviewReviewerConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const backend = backendValue(source.backend);
  if (!backend) {
    warnings.push(i18n.t("invalidBackendConfig", { index }));
    return undefined;
  }
  const model = parseModel(source.model);
  let typesafeModel: string | undefined;
  if (backend === "typesafe") {
    typesafeModel = source.typesafeModel === undefined ? DEFAULT_TYPESAFE_MODEL : stringValue(source.typesafeModel);
    if (!typesafeModel) {
      warnings.push(i18n.t("invalidTypesafeModelConfig", { index }));
      return undefined;
    }
    if (source.model !== undefined) warnings.push(i18n.t("modelIgnoredForTypesafe", { index }));
  } else if (!model) {
    return undefined;
  }
  const rulesFile = stringValue(source.rulesFile);
  const rulesFiles = Array.isArray(source.rulesFiles)
    ? source.rulesFiles
      .filter((file): file is string => typeof file === "string" && Boolean(file.trim()))
      .map((file) => file.trim())
    : [];
  if ((Boolean(rulesFile) && rulesFiles.length > 0) || (!rulesFile && rulesFiles.length === 0)) return undefined;
  const filePatterns = Array.isArray(source.filePatterns)
    ? source.filePatterns.filter((pattern): pattern is string => typeof pattern === "string" && Boolean(pattern.trim())).map((pattern) => pattern.trim())
    : [];
  const rawTools = source.tools === undefined ? DEFAULT_REVIEW_TOOLS : source.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0 || rawTools.some((tool) => typeof tool !== "string" || !tool.trim())) {
    warnings.push(i18n.t("invalidToolsConfig", { index }));
    return undefined;
  }
  const tools = rawTools.map((tool) => String(tool).trim());
  const normalizedTools = tools.includes(ALL_TOOLS) ? [ALL_TOOLS] : [...new Set(tools)];
  if (tools.includes(ALL_TOOLS) && tools.length > 1) warnings.push(i18n.t("wildcardToolsConfig", { index }));
  const condition = source.condition === undefined ? undefined : stringValue(source.condition);
  if (source.condition !== undefined && !condition) {
    warnings.push(i18n.t("invalidConditionConfig", { index }));
    return undefined;
  }
  const trigger = source.trigger === undefined ? "after" : source.trigger;
  if (!REVIEW_TRIGGERS.includes(trigger as ReviewTrigger)) {
    warnings.push(i18n.t("invalidTriggerConfig", { index }));
    return undefined;
  }
  return {
    name: stringValue(source.name) ?? `reviewer-${index + 1}`,
    // 只在 typesafe 时写入 backend，避免把旧配置改写为带显式 model backend。
    ...(backend === "typesafe" ? { backend, typesafeModel } : { model }),
    ...(rulesFile ? { rulesFile } : { rulesFiles }),
    enabled: source.enabled !== false,
    filePatterns,
    tools: normalizedTools,
    trigger: trigger as ReviewTrigger,
    ...(condition ? { condition } : {}),
  };
}

export function loadFileEditReviewConfig(
  configFile?: string,
): FileEditReviewConfigLoadResult {
  const preferredConfigFile = configFile ?? getPiSupervisorConfigPath();
  const legacyConfigFile = getLegacyFileEditReviewConfigPath();
  const shouldReadLegacyConfig = configFile === undefined
    && !existsSync(preferredConfigFile)
    && existsSync(legacyConfigFile);
  const resolvedConfigFile = shouldReadLegacyConfig ? legacyConfigFile : preferredConfigFile;
  const warnings = shouldReadLegacyConfig
    ? [`已从旧配置 ${legacyConfigFile} 读取；通过 /config:tool-supervisor 保存后会迁移到 ${preferredConfigFile}。`]
    : [];
  const defaultConfig: FileEditReviewConfig = {
    enabled: false,
    reviewers: [],
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    maxFileContextChars: DEFAULT_MAX_FILE_CONTEXT_CHARS,
    maxRuleLines: DEFAULT_MAX_RULE_LINES,
  };
  if (!existsSync(resolvedConfigFile)) {
    return { config: defaultConfig, configPath: resolvedConfigFile, warnings };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedConfigFile, "utf8")) as unknown;
  } catch (error) {
    return {
      config: defaultConfig,
      configPath: resolvedConfigFile,
      warnings: [...warnings, `无法解析审查配置 ${resolvedConfigFile}：${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      config: defaultConfig,
      configPath: resolvedConfigFile,
      warnings: [...warnings, `审查配置必须是 JSON 对象：${resolvedConfigFile}`],
    };
  }

  const source = raw as Record<string, unknown>;
  const typesafe = parseTypeSafeConfig(source.typesafe);
  const rawReviewers = Array.isArray(source.reviewers) ? source.reviewers : [];
  const reviewers: FileEditReviewReviewerConfig[] = [];
  rawReviewers.forEach((entry, index) => {
    const reviewer = normalizeReviewer(entry, index, warnings);
    if (!reviewer) {
      warnings.push(i18n.t("invalidReviewerConfig", { index }));
      return;
    }
    reviewers.push(reviewer);
  });

  if (rawReviewers.length === 0 && source.enabled !== false) {
    warnings.push("审查配置没有 reviewers，工具审查不会执行。");
  }

  return {
    config: {
      enabled: source.enabled !== false && reviewers.some((reviewer) => reviewer.enabled !== false),
      reviewers,
      ...(typesafe ? { typesafe } : {}),
      timeoutSeconds: positiveInteger(
        source.timeoutSeconds,
        typeof source.timeoutMs === "number"
          ? Math.max(1, Math.ceil(source.timeoutMs / 1000))
          : DEFAULT_TIMEOUT_SECONDS,
      ),
      maxFileContextChars: positiveInteger(source.maxFileContextChars, DEFAULT_MAX_FILE_CONTEXT_CHARS),
      maxRuleLines: positiveInteger(source.maxRuleLines, DEFAULT_MAX_RULE_LINES),
    },
    configPath: resolvedConfigFile,
    warnings,
  };
}

function expandHomePath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(homedir(), filePath.slice(2));
  }
  return filePath;
}

function normalizeFilePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parseMetadataValue(value: string): string | boolean | undefined {
  const normalized = value.trim();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (!normalized) return undefined;
  return normalized.replace(/^([\"'])(.*)\1$/, "$2");
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/[:：]\s*$/, "").toLowerCase();
}

/** 条款所属的二级标题是否是元指令段落。 */
function isMetaSection(section: string | undefined): boolean {
  return section !== undefined && normalizeHeading(section).startsWith(META_SECTION_PREFIX);
}

/** 从条款正文提取规则名：取第一个粗体片段，没有就用编号。 */
function clauseLabel(draft: ClauseDraft, section: string | undefined): string {
  const body = draft.lines.join(" ");
  const title = CLAUSE_TITLE.exec(body)?.[1]?.trim();
  const numbered = section === undefined ? `规则 ${draft.number}` : `${section} ${draft.number}`;
  return title ? `${numbered} ${title}` : numbered;
}

/**
 * 把规则文件切成编号条款。
 *
 * 规则文件是引擎无关的：不要求 `## 判据`、不要求 severity 标注，也不要求分块标题。
 * 一条 `N. 正文` 就是一条规则，正文既当判据、也当修复提示；`## 归属与 severity`
 * 这类元指令段落里编号的是「怎么报告」，不参与判断。
 */
function parseRuleClauses(content: string): FileEditReviewRuleClause[] {
  const drafts: ClauseDraft[] = [];
  let section: string | undefined;
  let current: ClauseDraft | undefined;
  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(RULE_SECTION_HEADING);
    if (heading) {
      section = (heading[1] ?? "").trim();
      current = undefined;
      continue;
    }
    const clause = line.match(CLAUSE_LINE);
    if (clause) {
      current = {
        number: Number(clause[1]),
        ...(section === undefined ? {} : { section }),
        lines: [stripSeverityMark((clause[2] ?? "").trim())],
      };
      drafts.push(current);
      continue;
    }
    // 条款正文可能续行；空行和紧跟的缩进行都归上一条，到下一个编号或标题才收尾。
    if (current && (line.trim() === "" || /^\s+\S/.test(line))) {
      current.lines.push(line.trim());
      continue;
    }
  }
  return drafts
    .filter((draft) => !isMetaSection(draft.section))
    .map((draft) => ({
      id: `rule_${draft.number}`,
      group: clauseLabel(draft, draft.section),
      text: draft.lines.map((line) => line.trim()).filter(Boolean).join(" ").trim(),
    }))
    .filter((clause) => clause.text !== "");
}

/** 剔掉条款开头的 `[error]` / `[warning]` 标注；本后端不分级，标注留在判据里会和行为矛盾。 */
function stripSeverityMark(value: string): string {
  return value.replace(CLAUSE_SEVERITY_MARK, "");
}

function parseRuleFile(rawContent: string): ParsedRuleFile {
  const warnings: string[] = [];
  const metadata: FileEditReviewRuleMetadata = {};
  const bareFile: ParsedRuleFile = {
    metadata,
    content: rawContent,
    clauses: parseRuleClauses(rawContent),
    warnings,
  };
  if (!rawContent.startsWith("---\n") && !rawContent.startsWith("---\r\n")) return bareFile;

  const headerEnd = rawContent.search(/\r?\n---\r?\n/);
  if (headerEnd < 0) {
    warnings.push(i18n.t("unterminatedFrontMatter"));
    return bareFile;
  }

  const header = rawContent.slice(4, headerEnd);
  const content = rawContent.slice(headerEnd).replace(/^\r?\n---\r?\n/, "");
  const lists: Record<"filePatterns" | "consumers", string[]> = {
    filePatterns: [],
    consumers: [],
  };
  let activeList: keyof typeof lists | undefined;
  for (const line of header.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    const listItem = line.match(/^\s*-\s*(.+)$/);
    if (activeList && listItem) {
      const value = parseMetadataValue(listItem[1]);
      if (typeof value === "string" && value) lists[activeList].push(value);
      continue;
    }
    activeList = undefined;
    if (!field) continue;
    const [, key, rawValue] = field;
    if (key === "filePatterns" || key === "consumers") {
      if (!rawValue.trim()) activeList = key;
      continue;
    }
    const value = parseMetadataValue(rawValue);
    if (key === "name" && typeof value === "string") metadata.name = value;
    if (key === "enabled" && typeof value === "boolean") metadata.enabled = value;
    if (key === "complexity" && (value === "local" || value === "context")) metadata.complexity = value;
    if (key === "threshold") {
      const threshold = probabilityValue(value);
      if (threshold === undefined) warnings.push(i18n.t("invalidRuleThreshold", { value: String(value ?? "") }));
      else metadata.threshold = threshold;
    }
  }
  if (lists.filePatterns.length > 0) metadata.filePatterns = lists.filePatterns;
  if (lists.consumers.length > 0) metadata.consumers = lists.consumers;
  return {
    metadata,
    content,
    clauses: parseRuleClauses(content),
    warnings,
  };
}

/** Converts the supported glob subset while preserving directory boundaries for a single star. */
function filePatternToRegExp(pattern: string): RegExp {
  const singleSegmentWildcard = "*";
  const recursiveWildcard = "**";
  const recursiveDirectoryWildcard = "**/";
  let expression = "";
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index];
    if (character !== singleSegmentWildcard) {
      expression += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
      index += 1;
      continue;
    }
    if (!pattern.startsWith(recursiveWildcard, index)) {
      expression += "[^/]*";
      index += singleSegmentWildcard.length;
      continue;
    }
    if (pattern.startsWith(recursiveDirectoryWildcard, index)) {
      expression += "(?:.*/)?";
      index += recursiveDirectoryWildcard.length;
      continue;
    }
    expression += ".*";
    index += recursiveWildcard.length;
  }
  return new RegExp(`^${expression}$`);
}

/** Matches a normalized file path against one configured file pattern. */
function matchesFilePattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeFilePath(filePath);
  const normalizedPattern = normalizeFilePath(pattern);
  return filePatternToRegExp(normalizedPattern).test(normalizedPath);
}

/** 审查引擎；未配置时按 `model` 处理。 */
export function reviewerBackend(reviewer: FileEditReviewReviewerConfig): ReviewBackend {
  return reviewer.backend ?? "model";
}

/** 审计卡片和配置界面显示的模型标签；TypeSafe backend 用 `typesafe/<model>` 形式。 */
export function reviewerModelLabel(reviewer: FileEditReviewReviewerConfig): string {
  if (reviewerBackend(reviewer) === "typesafe") {
    return `typesafe/${reviewer.typesafeModel ?? DEFAULT_TYPESAFE_MODEL}`;
  }
  return reviewer.model ?? "unknown";
}

export function reviewerAppliesToFile(
  reviewer: FileEditReviewReviewerConfig,
  filePath: string,
): boolean {
  const filePatterns = reviewer.filePatterns ?? [];
  return filePatterns.length === 0 || filePatterns.some((pattern) => matchesFilePattern(filePath, pattern));
}

export function reviewerIsEditorLocal(reviewer: FileEditReviewReviewerConfig): boolean {
  return reviewer.complexity !== "context" &&
    (!reviewer.consumers || reviewer.consumers.includes("editor-review"));
}

/** Returns whether a reviewer explicitly selects a tool or the all-tools wildcard. */
export function reviewerMatchesTool(reviewer: FileEditReviewReviewerConfig, toolName: string): boolean {
  const tools = reviewer.tools ?? DEFAULT_REVIEW_TOOLS;
  return tools.includes(ALL_TOOLS) || tools.includes(toolName);
}

/** Returns the normalized trigger, including the legacy after default. */
export function reviewerTrigger(reviewer: FileEditReviewReviewerConfig): ReviewTrigger {
  return reviewer.trigger ?? DEFAULT_REVIEW_TRIGGER;
}

export function resolveRulesFilePath(rulesFile: string, cwd: string): string {
  const expanded = expandHomePath(rulesFile);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function getReviewerRulesFiles(reviewer: FileEditReviewReviewerConfig): string[] {
  if (reviewer.rulesFiles && reviewer.rulesFiles.length > 0) return reviewer.rulesFiles;
  return reviewer.rulesFile ? [reviewer.rulesFile] : [];
}

export function loadReviewRule(
  reviewer: FileEditReviewReviewerConfig & { rulesFile: string },
  cwd: string,
  maxRuleLines: number,
): FileEditReviewRule {
  const absolutePath = resolveRulesFilePath(reviewer.rulesFile, cwd);
  const rawContent = readFileSync(absolutePath, "utf8");
  const parsed = parseRuleFile(rawContent);
  const effectiveReviewer: FileEditReviewReviewerConfig = {
    ...reviewer,
    name: parsed.metadata.name ?? reviewer.name,
    enabled: parsed.metadata.enabled ?? reviewer.enabled ?? true,
    filePatterns: parsed.metadata.filePatterns ?? reviewer.filePatterns ?? [],
    complexity: parsed.metadata.complexity,
    consumers: parsed.metadata.consumers,
  };
  const content = parsed.content;
  const lineCount = content.split(/\r?\n/).length;
  const lengthWarning = lineCount > maxRuleLines
    ? `规则文件 ${reviewer.rulesFile} 有 ${lineCount} 行，超过 ${maxRuleLines} 行；审查可能变慢且效果下降，建议拆分规则文件。`
    : undefined;
  const warning = [...parsed.warnings, lengthWarning].filter(Boolean).join(" ") || undefined;
  return {
    reviewer: effectiveReviewer,
    absolutePath,
    content,
    lineCount,
    metadata: parsed.metadata,
    clauses: parsed.clauses,
    warning,
  };
}

export function loadReviewRules(
  reviewer: FileEditReviewReviewerConfig,
  cwd: string,
  maxRuleLines: number,
): { rules: FileEditReviewRule[]; errors: FileEditReviewResult[] } {
  const rules: FileEditReviewRule[] = [];
  const errors: FileEditReviewResult[] = [];
  for (const rulesFile of getReviewerRulesFiles(reviewer)) {
    try {
      rules.push(loadReviewRule({ ...reviewer, rulesFile, rulesFiles: undefined }, cwd, maxRuleLines));
    } catch (error) {
      errors.push({
        name: reviewer.name,
        model: reviewerModelLabel(reviewer),
        rulesFile,
        status: "failed",
        durationMs: 0,
        error: `规则文件读取失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { rules, errors };
}

/** Builds the actual before/after file diff used by file reviewers. */
export function buildFileEditReviewDiff(
  filePath: string,
  before: string | undefined,
  after: string | undefined,
  fallbackDiff = "",
): string {
  if (before !== undefined && after !== undefined && before === after) return "";
  if (before !== undefined && after !== undefined) {
    return createTwoFilesPatch(
      `a/${filePath}`,
      `b/${filePath}`,
      before,
      after,
      undefined,
      undefined,
      { context: DIFF_CONTEXT_LINES },
    ).trimEnd();
  }
  if (after !== undefined) {
    const lines = after.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return [`--- /dev/null`, `+++ b/${filePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
  }
  return fallbackDiff;
}

/** Builds a numbered post-edit file view, bounded around the first and last changed lines for oversized files. */
export function buildCurrentFileContext(
  before: string | undefined,
  after: string | undefined,
  maxChars: number,
): CurrentFileContext | undefined {
  if (after === undefined) return undefined;
  const afterLines = after.split(/\r?\n/);
  if (afterLines.length > 0 && afterLines[afterLines.length - 1] === "") afterLines.pop();
  const numberedLines = afterLines.map((line, index) => `${index + 1} | ${line}`);
  const fullContent = numberedLines.join("\n");
  if (fullContent.length <= maxChars) return { content: fullContent, truncated: false };

  const beforeLines = before?.split(/\r?\n/) ?? [];
  if (beforeLines.length > 0 && beforeLines[beforeLines.length - 1] === "") beforeLines.pop();
  const commonStart = beforeLines.findIndex((line, index) => line !== afterLines[index]);
  const start = commonStart === -1 ? Math.min(beforeLines.length, afterLines.length) : commonStart;
  let commonEnd = 0;
  while (
    commonEnd < beforeLines.length - start &&
    commonEnd < afterLines.length - start &&
    beforeLines[beforeLines.length - 1 - commonEnd] === afterLines[afterLines.length - 1 - commonEnd]
  ) {
    commonEnd += 1;
  }
  const changedEnd = Math.max(start + 1, afterLines.length - commonEnd);
  const lastLineIndex = Math.max(0, afterLines.length - 1);
  const firstAnchor = Math.min(start, lastLineIndex);
  const lastAnchor = Math.min(Math.max(start, changedEnd - 1), lastLineIndex);
  const anchors = [firstAnchor, lastAnchor];
  let excerptContent = "";
  for (const radius of FILE_CONTEXT_RADIUS_STEPS) {
    const selected = new Set<number>();
    for (const anchor of anchors) {
      const from = Math.max(0, anchor - radius);
      const to = Math.min(afterLines.length, anchor + radius + 1);
      for (let index = from; index < to; index += 1) selected.add(index);
    }
    const selectedLines = [...selected].sort((left, right) => left - right);
    const excerpt: string[] = [];
    let previous = -1;
    for (const index of selectedLines) {
      if (previous >= 0 && index > previous + 1) {
        excerpt.push(`... lines ${previous + OMITTED_RANGE_START_OFFSET}-${index} omitted ...`);
      }
      excerpt.push(numberedLines[index]);
      previous = index;
    }
    excerptContent = excerpt.join("\n");
    if (excerptContent.length <= maxChars) return { content: excerptContent, truncated: true };
  }
  const truncationMarker = "\n... file context truncated ...";
  if (maxChars <= truncationMarker.length) {
    return { content: truncationMarker.slice(0, maxChars), truncated: true };
  }
  const boundedContent = `${excerptContent.slice(0, maxChars - truncationMarker.length)}${truncationMarker}`;
  return { content: boundedContent, truncated: true };
}

export function buildEditFallbackDiff(params: Record<string, unknown>): string {
  const edits = Array.isArray(params.edits)
    ? params.edits.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    : [params];
  return edits.map((edit, index) => {
    const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
    const newText = typeof edit.newText === "string" ? edit.newText : "";
    return [`@@ edit ${index + 1} @@`, ...oldText.split(/\r?\n/).map((line) => `-${line}`), ...newText.split(/\r?\n/).map((line) => `+${line}`)].join("\n");
  }).join("\n");
}

/** Builds the untrusted-data-wrapped prompt shared by file and generic tool reviews. */
export function buildMergedReviewPrompt(options: {
  toolName: string;
  filePath?: string;
  diff: string;
  currentFileContext?: CurrentFileContext;
  rules: FileEditReviewRule[];
  trigger?: ReviewTrigger;
}): string;
export function buildMergedReviewPrompt(options: {
  toolName: string;
  filePath?: string;
  diff: string;
  currentFileContext?: CurrentFileContext;
  rules: FileEditReviewRule[];
  trigger?: ReviewTrigger;
}): string {
  const { toolName, filePath, diff, currentFileContext, rules, trigger = DEFAULT_REVIEW_TRIGGER } = options;
  const ruleBlocks = rules.flatMap((rule) => [
    `<rules name="${rule.reviewer.name}">`,
    rule.content,
    "</rules>",
    "",
  ]);
  return [
    i18n.t("systemPrompt"),
    i18n.t("doNotExecute"),
    i18n.t("noInvent"),
    i18n.t("jsonOnly"),
    i18n.t("jsonFormat"),
    i18n.t("passedRule"),
    "",
    i18n.t("tool", { value: toolName }),
    ...(filePath ? [i18n.t("file", { value: filePath })] : []),
    i18n.t("trigger", { value: trigger }),
    i18n.t("rules", { value: rules.map((rule) => rule.reviewer.rulesFile).join(", ") }),
    "",
    ...ruleBlocks,
    "<diff>",
    diff,
    "</diff>",
    ...(currentFileContext ? [
      "",
      i18n.t("currentFileGuidance"),
      `<current-file truncated="${String(currentFileContext.truncated)}">`,
      currentFileContext.content,
      "</current-file>",
    ] : []),
  ].join("\n");
}

export function buildReviewPrompt(
  toolName: "edit" | "write",
  filePath: string,
  diff: string,
  rule: FileEditReviewRule,
): string {
  return buildMergedReviewPrompt({ toolName, filePath, diff, rules: [rule] });
}

/** Builds the generic payload prompt used for non-file tools. */
export function buildGenericReviewPrompt(options: { toolName: string; payload: string; rules: FileEditReviewRule[]; trigger: ReviewTrigger }): string {
  return buildMergedReviewPrompt({ toolName: options.toolName, diff: options.payload, rules: options.rules, trigger: options.trigger });
}

function normalizeFinding(value: unknown): FileEditReviewFinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const message = stringValue(source.message);
  if (!message) return undefined;
  const severity = source.severity === "error" || source.severity === "warning" || source.severity === "info"
    ? source.severity
    : undefined;
  const line = typeof source.line === "number" && Number.isSafeInteger(source.line) && source.line > 0
    ? source.line
    : undefined;
  const ruleGroup = stringValue(source.ruleGroup);
  return { severity, message, line, ruleGroup };
}

/**
 * Finds actionable issues. A finding without severity stays blocking so reviewers that omit
 * the field keep their gate instead of silently losing it.
 */
function isBlockingFinding(finding: FileEditReviewFinding): boolean {
  return finding.severity === undefined || finding.severity === BLOCKING_SEVERITY;
}

/** Records why the reviewer verdict was not taken at face value. */
function buildVerdictConflictFinding(modelClaimedPassed: boolean): FileEditReviewFinding {
  return {
    severity: INFO_SEVERITY,
    ruleGroup: SUPERVISOR_RULE_GROUP,
    message: i18n.t(modelClaimedPassed ? "verdictConflictPassed" : "verdictConflictDowngraded"),
  };
}

export function parseReviewResponse(text: string): ParsedFileEditReviewResult {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(i18n.t("noJson"));
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(i18n.t("jsonNotObject"));
  }
  const source = parsed as Record<string, unknown>;
  if (typeof source.passed !== "boolean") throw new Error(i18n.t("missingPassed"));
  const summary = stringValue(source.summary) ?? (source.passed ? i18n.t("passed") : i18n.t("rejected"));
  const findings = Array.isArray(source.findings)
    ? source.findings.map(normalizeFinding).filter((finding): finding is FileEditReviewFinding => Boolean(finding))
    : [];
  // A rejection is honored only when the reviewer also reported an actionable issue; a model that
  // claims passed false while listing nothing to fix would otherwise block the edit with no fix path.
  const blocked = findings.some(isBlockingFinding);
  const balanced = source.passed === !blocked;
  const passed = source.passed || !blocked;
  return {
    passed,
    summary,
    findings: balanced ? findings : [...findings, buildVerdictConflictFinding(source.passed)],
  };
}

/** Safely serializes untrusted tool input and bounds the prompt payload. */
export function safeSerialize(value: unknown, maxChars: number): { text?: string; error?: string; truncated?: boolean } {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === "bigint") return `${current}n`;
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    });
    if (serialized === undefined) return { error: i18n.t("cannotSerializeToolInput") };
    if (serialized.length <= maxChars) return { text: serialized };
    const suffix = "…[truncated]";
    return { text: `${serialized.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`, truncated: true };
  } catch (error) {
    return { error: i18n.t("toolInputSerializationFailed", { message: error instanceof Error ? error.message : String(error) }) };
  }
}

/** Aggregates reviewer states with rejection taking precedence over failures. */
export function getOverallReviewStatus(results: FileEditReviewResult[]): FileEditReviewAudit["status"] {
  if (results.length === 0) return "skipped";
  if (results.some((result) => result.status === "rejected")) return "rejected";
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.every((result) => result.status === "passed")) return "passed";
  return "skipped";
}

export function getConfigFileFingerprint(configFile: string): string {
  try {
    const stats = statSync(configFile);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "missing";
  }
}
