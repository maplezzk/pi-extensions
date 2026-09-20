/**
 * TypeSafe 判断引擎。
 *
 * 把规则文件编译成独立的 typed question（Noul：违反该规则的概率），一次请求批量问完；
 * 命中判断后再用一次 Choice 请求把问题定位到具体的新增行。
 *
 * 设计要点：
 * - 代码拥有控制流：阈值和阻断与否都在这里决定，模型只提供概率。
 * - finding 文案直接取规则文件里的条款正文，不依赖模型生成解释。
 * - 缺失答案、阈值非法、规则切不出条款都必须明确报告，不能降级成「通过」。
 */

import { diffLines } from "diff";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import {
  DEFAULT_RULE_THRESHOLD,
  type FileEditReviewFinding,
  type FileEditReviewRule,
} from "./review-utils.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/judgment.json", import.meta.url)));

/** 一次行定位请求里允许的候选行上限；超过时跳过定位并明确报告。 */
export const MAX_LOCALIZATION_CANDIDATES = 40;
/** 候选项代码和判据文本的截断长度，控制单次请求的输入 token。 */
const MAX_CANDIDATE_TEXT_CHARS = 120;
const MAX_CRITERION_CHARS = 300;
/** finding 文案上限；条款原文可能很长，全量塞进 tool result 会淹没 Agent。 */
const MAX_FINDING_TEXT_CHARS = 600;
const MAX_JUDGMENT_ID_CHARS = 60;
/** 命中即阻断：没有 severity 概念，条款定义了就要遵守。 */
/** 行定位置信度低于该值时只报规则、不报行号，避免指错行。 */
const MIN_LOCALIZATION_CONFIDENCE = 0.5;
const JUDGMENT_ID_SEPARATOR = /[^A-Za-z0-9_-]+/g;
const LINE_SUFFIX = "__line";
const NO_LINE_CHOICE = "none";

/** 一条规则编译出的 TypeSafe 判断单元。 */
export interface RuleJudgment {
  /** TypeSafe 问题 id，只含字母、数字、下划线和连字符。 */
  id: string;
  /** 审计和 finding 里显示的规则名，取自规则文件自己的条款叫法。 */
  ruleName: string;
  rulesFile: string;
  threshold: number;
  /** 条款正文；既当判据也当修复提示。 */
  criterion: string;
}

export interface JudgmentCompileError {
  rulesFile: string;
  message: string;
}

export interface JudgmentCompileResult {
  judgments: RuleJudgment[];
  errors: JudgmentCompileError[];
  warnings: string[];
}

export interface TypeSafeQuestion {
  type: string;
  instructions: string;
  criteria: Record<string, string>;
}

/** TypeSafe 判断请求的 state；字段名用下划线，便于在 instructions 里用反引号路径引用。 */
export interface JudgmentState {
  tool: string;
  trigger: string;
  diff: string;
  file?: string;
  current_file?: string;
  current_file_truncated?: boolean;
}

export interface LocatedLine {
  line: number;
  text: string;
}

export interface JudgmentVerdict {
  judgment: RuleJudgment;
  noul: number;
  /** noul 达到该条款的阈值。 */
  hit: boolean;
}

export interface JudgmentReadResult {
  verdicts: JudgmentVerdict[];
  /** 没有可用答案的规则；调用方必须把它报成失败，而不是通过。 */
  unanswered: RuleJudgment[];
}

function sanitizeJudgmentId(value: string): string {
  const sanitized = value
    .trim()
    .replace(JUDGMENT_ID_SEPARATOR, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_JUDGMENT_ID_CHARS);
  return sanitized || i18n.t("fallbackJudgmentId");
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

/**
 * 把规则文件切出的编号条款编译成判断。
 *
 * 一个文件切不出任何条款时不能静默通过：那意味着这个文件在本后端下无法判断，
 * 必须报成带路径的错误，否则启用 typesafe 后规则会静默失效。
 *
 * 条款编号是文件内序号（`rule_1`、`rule_2`），而一次审查会把该 reviewer 的多个规则
 * 文件合成一次请求，所以跨文件必然重号。合并多个文件时按文件顺序加前缀，让判断 id
 * 天然唯一；重号警告只留给同一个文件里编号重复这种真的写错了的情况。
 */
export function compileJudgments(rules: FileEditReviewRule[]): JudgmentCompileResult {
  const judgments: RuleJudgment[] = [];
  const errors: JudgmentCompileError[] = [];
  const warnings: string[] = [];
  const usedIds = new Set<string>();
  const scoped = rules.length > 1;
  for (const [fileIndex, rule] of rules.entries()) {
    if (rule.clauses.length === 0) {
      errors.push({ rulesFile: rule.absolutePath, message: i18n.t("missingClauses") });
      continue;
    }
    const fileScope = scoped ? `f${fileIndex + 1}_` : "";
    for (const clause of rule.clauses) {
      const baseId = sanitizeJudgmentId(`${fileScope}${clause.id}`);
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}_${suffix}`;
        suffix += 1;
      }
      if (id !== baseId) {
        warnings.push(i18n.t("duplicateJudgmentId", { id: baseId, resolved: id, file: rule.absolutePath }));
      }
      usedIds.add(id);
      judgments.push({
        id,
        ruleName: clause.group,
        rulesFile: rule.absolutePath,
        threshold: rule.metadata.threshold ?? DEFAULT_RULE_THRESHOLD,
        criterion: clause.text,
      });
    }
  }
  return { judgments, errors, warnings };
}

/** 把条款编译成一批 Noul 问题；同一份 state 下的问题由 TypeSafe 并行回答。 */
export function buildJudgmentQuestions(judgments: RuleJudgment[]): Record<string, TypeSafeQuestion> {
  const questions: Record<string, TypeSafeQuestion> = {};
  for (const judgment of judgments) {
    questions[judgment.id] = {
      type: "noul",
      instructions: i18n.t("judgmentInstructions", { rule: judgment.ruleName, criterion: judgment.criterion }),
      criteria: {
        true: i18n.t("criterionTrue", { criterion: judgment.criterion }),
        false: i18n.t("criterionFalse"),
      },
    };
  }
  return questions;
}

/** 读取答案；缺答案或值非法的条款被列进 unanswered。 */
export function readJudgmentVerdicts(
  judgments: RuleJudgment[],
  answers: Record<string, { type?: string; noul?: number }>,
): JudgmentReadResult {
  const verdicts: JudgmentVerdict[] = [];
  const unanswered: RuleJudgment[] = [];
  for (const judgment of judgments) {
    const noul = answers[judgment.id]?.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      unanswered.push(judgment);
      continue;
    }
    verdicts.push({ judgment, noul, hit: noul >= judgment.threshold });
  }
  return { verdicts, unanswered };
}

/**
 * 扫描新增/修改行，用于把判断定位到具体行号。
 * 候选行超过上限时返回 truncated，调用方必须跳过定位而不是猜一行。
 */
export function extractChangedLines(
  before: string | undefined,
  after: string | undefined,
): { lines: LocatedLine[]; truncated: boolean } {
  if (after === undefined) return { lines: [], truncated: false };
  const lines: LocatedLine[] = [];
  let truncated = false;
  let newLineNumber = 1;
  for (const part of diffLines(before ?? "", after)) {
    const partLines = part.value.split("\n");
    if (partLines[partLines.length - 1] === "") partLines.pop();
    if (part.added) {
      for (const text of partLines) {
        if (lines.length < MAX_LOCALIZATION_CANDIDATES) {
          lines.push({ line: newLineNumber, text: truncate(text, MAX_CANDIDATE_TEXT_CHARS) });
        } else {
          truncated = true;
        }
        newLineNumber += 1;
      }
      continue;
    }
    if (!part.removed) newLineNumber += partLines.length;
  }
  return { lines, truncated };
}

/** 为每条命中的规则生成一个 Choice 问题，在候选新增行里定位。 */
export function buildLocalizationQuestions(
  judgments: RuleJudgment[],
  candidates: LocatedLine[],
): Record<string, TypeSafeQuestion> {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[String(candidate.line)] = i18n.t("candidateLine", { line: candidate.line, text: candidate.text });
  }
  criteria[NO_LINE_CHOICE] = i18n.t("candidateNone");
  const questions: Record<string, TypeSafeQuestion> = {};
  for (const judgment of judgments) {
    questions[`${judgment.id}${LINE_SUFFIX}`] = {
      type: "choice",
      instructions: i18n.t("localizeInstructions", {
        rule: judgment.ruleName,
        criterion: truncate(judgment.criterion, MAX_CRITERION_CHARS),
        none: NO_LINE_CHOICE,
      }),
      criteria,
    };
  }
  return questions;
}

/** 读取定位结果；置信度不足、选到 none 或选了未知行号时不返回行，而不是返回错行。 */
export function readLocatedLines(
  judgments: RuleJudgment[],
  answers: Record<string, { type?: string; choice?: string; confidence?: number }>,
  candidates: LocatedLine[],
): Map<string, LocatedLine> {
  const located = new Map<string, LocatedLine>();
  for (const judgment of judgments) {
    const answer = answers[`${judgment.id}${LINE_SUFFIX}`];
    const choice = answer?.choice;
    if (typeof choice !== "string" || choice === NO_LINE_CHOICE) continue;
    const confidence = answer?.confidence;
    if (typeof confidence !== "number" || confidence < MIN_LOCALIZATION_CONFIDENCE) continue;
    const match = candidates.find((candidate) => String(candidate.line) === choice);
    if (match) located.set(judgment.id, match);
  }
  return located;
}

/** 把命中的判断转成 findings；没有分级，命中即阻断。 */
export function buildJudgmentFindings(
  verdicts: JudgmentVerdict[],
  located: Map<string, LocatedLine>,
): FileEditReviewFinding[] {
  const findings: FileEditReviewFinding[] = [];
  for (const verdict of verdicts) {
    if (!verdict.hit) continue;
    const { judgment } = verdict;
    const locatedLine = located.get(judgment.id);
    const text = truncate(judgment.criterion, MAX_FINDING_TEXT_CHARS);
    findings.push({
      ruleGroup: judgment.ruleName,
      message: locatedLine
        ? `${text}\n${i18n.t("hitLine", { text: locatedLine.text })}`
        : text,
      ...(locatedLine ? { line: locatedLine.line } : {}),
    });
  }
  return findings;
}
