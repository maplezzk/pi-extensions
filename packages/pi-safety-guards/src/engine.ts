import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeShellCommand, type ShellCommandAnalysis } from "./shell-command-utils.ts";
import {
  findOutOfScopeBashPaths,
  resolveBashDirectoryRoots,
  type BashPathViolation,
} from "./bash-directory-scope-utils.ts";
import { i18n } from "./i18n.ts";
import type { RuleAction, RuleContext, RuleMatcher, RuleMatch, SafetyConfig, SafetyRule } from "./types.ts";

const MODULE_TIMEOUT_MS = 5_000;
const ACTION_ORDER: readonly RuleAction[] = ["block", "confirm", "warn"];

/** 正则和模块在编译期已分流，声明式匹配器只剩这三种。 */
type DeclarativeMatch = Extract<RuleMatch,
  | { commands: readonly string[] }
  | { commandPrefixes: readonly string[] }
  | { outsideRoots: readonly string[] }>;

/**
 * 编译结果自带判定所需数据：声明式规则带 match，正则规则带 pattern，模块规则带 matcher。
 * 不再引入额外判别字段，也不需要检查“缺正则 / 缺函数”这类内部状态。
 */
export type CompiledRule =
  | { readonly rule: SafetyRule; readonly match: DeclarativeMatch }
  | { readonly rule: SafetyRule; readonly pattern: RegExp }
  | { readonly rule: SafetyRule; readonly matcher: RuleMatcher };

export interface PathRuleEvidence {
  readonly cwd: string;
  readonly allowedRoots: readonly string[];
  readonly violations: readonly BashPathViolation[];
  readonly suggestedDirectories: readonly string[];
}

export interface PolicyDecision {
  readonly action: RuleAction;
  readonly matches: readonly SafetyRule[];
  readonly pathEvidence: ReadonlyMap<string, PathRuleEvidence>;
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
    const { match } = rule;
    if ("commandPattern" in match) {
      // 配置解析阶段已验证可编译，这里编译一次，避免每条命令重复编译。
      compiled.push({ rule, pattern: new RegExp(match.commandPattern) });
      continue;
    }
    if (!("module" in match)) {
      compiled.push({ rule, match });
      continue;
    }
    try {
      const modulePath = resolve(configDirectory, match.module);
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

/** 命令名只建立一次索引；每种匹配器都只读自己那一个字段。 */
interface BuiltinMatch {
  matched: boolean;
  pathEvidence?: PathRuleEvidence;
}

/** 一次评估要用的命令上下文与目录根，避免每个函数再摊开一串参数。 */
interface EvaluationInput {
  readonly context: RuleContext;
  readonly commandNames: ReadonlySet<string>;
  readonly additionalRoots: readonly string[];
}

/** 前缀匹配不构造中间集合，逐个命令名比对。 */
function matchesAnyPrefix(commandNames: ReadonlySet<string>, prefixes: readonly string[]): boolean {
  for (const name of commandNames) {
    if (prefixes.some((prefix) => name.startsWith(prefix))) return true;
  }
  return false;
}

/** 声明式匹配器只看执行到的命令和显式路径，不做任何名字到逻辑的映射。 */
function matchesDeclarative(match: DeclarativeMatch, input: EvaluationInput): BuiltinMatch {
  if ("commands" in match) return { matched: match.commands.some((name) => input.commandNames.has(name)) };
  if ("commandPrefixes" in match) return { matched: matchesAnyPrefix(input.commandNames, match.commandPrefixes) };
  const roots = [...match.outsideRoots, ...input.additionalRoots];
  const violations = findOutOfScopeBashPaths(input.context.command, input.context.cwd, roots);
  if (violations.length === 0) return { matched: false };
  const suggestedDirectories = [...new Set(violations.map(({ resolvedPath }) => {
    try {
      return statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath);
    } catch {
      return dirname(resolvedPath);
    }
  }))];
  return {
    matched: true,
    pathEvidence: {
      cwd: input.context.cwd,
      allowedRoots: resolveBashDirectoryRoots(input.context.cwd, roots),
      violations,
      suggestedDirectories,
    },
  };
}

/** 按编译结果自带的判定数据分流；正则只做一次 test，模块调用带超时。 */
async function evaluateCompiled(compiled: CompiledRule, input: EvaluationInput): Promise<BuiltinMatch> {
  if ("pattern" in compiled) {
    // JSON 只给正则源文本、没有 flags，test 不依赖 lastIndex，跨命令匹配互不影响。
    return { matched: compiled.pattern.test(input.context.command) };
  }
  if ("matcher" in compiled) return { matched: await withDeadline(() => compiled.matcher(input.context)) };
  return matchesDeclarative(compiled.match, input);
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
  additionalRoots: readonly string[] = [],
): Promise<PolicyDecision | undefined> {
  if (rules.length === 0) return undefined;
  const analysis = analyzeShellCommand(command);
  if (analysis.errors.length) throw new Error(i18n.t("shellParseBlocked"));
  const context = moduleContext(command, cwd, analysis);
  const input: EvaluationInput = {
    context,
    commandNames: new Set(analysis.commands.map(({ name }) => name)),
    additionalRoots,
  };
  const matches: SafetyRule[] = [];
  const pathEvidence = new Map<string, PathRuleEvidence>();
  for (const compiled of rules) {
    try {
      const result = await evaluateCompiled(compiled, input);
      if (typeof result.matched !== "boolean") throw new Error(i18n.t("matcherMustReturnBoolean"));
      if (result.matched) {
        matches.push(compiled.rule);
        if (result.pathEvidence) pathEvidence.set(compiled.rule.id, result.pathEvidence);
      }
    } catch (error) {
      throw ruleFailure(compiled.rule.id, error);
    }
  }
  const action = ACTION_ORDER.find((action) => matches.some((rule) => rule.action === action));
  return action ? { action, matches, pathEvidence } : undefined;
}
