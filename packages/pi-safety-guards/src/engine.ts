import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeShellCommand, type ShellCommandAnalysis } from "./shell-command-utils.ts";
import { findOutOfScopeBashPaths } from "./bash-directory-scope-utils.ts";
import { i18n } from "./i18n.ts";
import type { Detector, RuleAction, RuleContext, RuleMatcher, RuleMatch, SafetyConfig, SafetyRule } from "./types.ts";

const MODULE_TIMEOUT_MS = 5_000;
const ACTION_ORDER: readonly RuleAction[] = ["block", "confirm", "warn"];
const FORK_BOMB_NAME = ":";
const FORMAT_COMMAND = "mkfs";
const FORMAT_PREFIX = "mkfs.";
const FUNCTION_NODE = "Function";
const EDIT_COMMAND = "sed";
const SEARCH_COMMAND = "find";
const IN_PLACE_OPTION = "--in-place";
const HOME_ROOT = "~";
const FILESYSTEM_ROOT = "/";

export interface CompiledRule {
  readonly rule: SafetyRule;
  readonly matcher?: RuleMatcher;
}
export interface PolicyDecision {
  readonly action: RuleAction;
  readonly matches: readonly SafetyRule[];
}
export type ModuleLoader = (path: string) => Promise<unknown>;

/** 只加载配置指定的本地模块；mtime 使 reload 可以读取规则文件的新版本。 */
async function loadModule(path: string): Promise<unknown> {
  const url = pathToFileURL(path);
  url.searchParams.set("mtime", String(statSync(path).mtimeMs));
  return import(url.href);
}

/** 在注册任何工具 hook 之前加载启用的规则，避免部分注册后才发现配置错误。 */
export async function compileRules(
  config: SafetyConfig,
  configDirectory: string,
  loader: ModuleLoader = loadModule,
): Promise<CompiledRule[]> {
  const compiled: CompiledRule[] = [];
  for (const rule of config.rules) {
    if (!("module" in rule.match)) {
      compiled.push({ rule });
      continue;
    }
    try {
      const modulePath = resolve(configDirectory, rule.match.module);
      const module = await withDeadline(() => loader(modulePath));
      const matcher = module && typeof module === "object" ? (module as { default?: unknown }).default : undefined;
      if (typeof matcher !== "function") throw new Error(i18n.t("moduleMustExportMatcher"));
      compiled.push({ rule, matcher: matcher as RuleMatcher });
    } catch (error) {
      throw ruleFailure(rule.id, error);
    }
  }
  return compiled;
}

/** 检测器只返回匹配事实，动作和建议不属于检测器。 */
function detect(detector: Detector, analysis: ShellCommandAnalysis, command: string): boolean {
  switch (detector) {
    case "disk-format":
      return analysis.commands.some(({ name }) => name === FORMAT_COMMAND || name.startsWith(FORMAT_PREFIX));
    case "fork-bomb":
      return /:\(\)\s*\{/.test(command) && analysis.nodes.some(isForkBombFunction);
    case "in-place-edit":
      return analysis.commands.some(({ name, args }) => name === EDIT_COMMAND && args.some(({ value }) => isInPlaceOption(value)));
    case "home-root":
      return analysis.commands.some(({ args }) => args.some(({ text }) => text === HOME_ROOT));
    case "root-search":
      return analysis.commands.some(({ name, args }) => name === SEARCH_COMMAND && args.some(({ value }) => value === FILESYSTEM_ROOT));
  }
}

/** 匹配已有 fork bomb 检测范围中的冒号函数节点。 */
function isForkBombFunction(node: Record<string, unknown>): boolean {
  if (node.type !== FUNCTION_NODE || !node.name || typeof node.name !== "object") return false;
  return (node.name as { value?: unknown }).value === FORK_BOMB_NAME;
}

/** 识别 sed 组合短选项和带备份后缀的原地编辑选项。 */
function isInPlaceOption(value: string): boolean {
  if (value === IN_PLACE_OPTION || value.startsWith(`${IN_PLACE_OPTION}=`)) return true;
  return /^-[^-]*i/.test(value);
}

/** 用户模块只拿到深度冻结的命令摘要，不能改写后续内置规则的分析结果。 */
function moduleContext(command: string, cwd: string, analysis: ShellCommandAnalysis): RuleContext {
  return Object.freeze({
    command,
    cwd,
    commands: Object.freeze(analysis.commands.map(({ name, args }) => Object.freeze({
      name,
      args: Object.freeze(args.map(({ value }) => value)),
    }))),
  });
}

/** 有界等待异步规则；同进程同步死循环不能被抢占，模块必须可信。 */
function withDeadline<T>(operation: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(i18n.t("moduleTimeout"))), MODULE_TIMEOUT_MS);
    Promise.resolve().then(operation).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 命令名只建立一次索引；内置检测保持明确的分支。 */
function matchesBuiltin(
  match: RuleMatch,
  context: RuleContext,
  analysis: ShellCommandAnalysis,
  commandNames: ReadonlySet<string>,
): boolean {
  if ("commands" in match) return match.commands.some((name) => commandNames.has(name));
  if ("detector" in match) return detect(match.detector, analysis, context.command);
  if ("outsideRoots" in match) return findOutOfScopeBashPaths(context.command, context.cwd, match.outsideRoots).length > 0;
  throw new Error(i18n.t("moduleMustExportMatcher"));
}

/** 错误保留规则 ID，绝不按未命中继续执行。 */
function ruleFailure(id: string, error: unknown): Error {
  return new Error(i18n.t("ruleFailed", {
    id,
    error: error instanceof Error ? error.message : String(error),
  }), { cause: error });
}

/** 评估所有规则并按 block > confirm > warn 合并，不能用前面的低风险动作绕过阻断。 */
export async function evaluateRules(
  rules: readonly CompiledRule[],
  command: string,
  cwd: string,
): Promise<PolicyDecision | undefined> {
  if (rules.length === 0) return undefined;
  const analysis = analyzeShellCommand(command);
  if (analysis.errors.length) throw new Error(i18n.t("shellParseBlocked"));
  const context = moduleContext(command, cwd, analysis);
  const commandNames = new Set(analysis.commands.map(({ name }) => name));
  const matches: SafetyRule[] = [];
  for (const { rule, matcher } of rules) {
    try {
      const matched = matcher
        ? await withDeadline(() => matcher(context))
        : matchesBuiltin(rule.match, context, analysis, commandNames);
      if (typeof matched !== "boolean") throw new Error(i18n.t("matcherMustReturnBoolean"));
      if (matched) matches.push(rule);
    } catch (error) {
      throw ruleFailure(rule.id, error);
    }
  }
  const action = ACTION_ORDER.find((action) => matches.some((rule) => rule.action === action));
  return action ? { action, matches } : undefined;
}
