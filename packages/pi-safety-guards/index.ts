import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import {
  configPath,
  ensureConfigFile,
  loadConfig,
  loadConfigDocument,
  parseConfig,
  saveConfig,
} from "./src/config.ts";
import { describeEffectiveRules } from "./src/inspect.ts";
import { compileRules, evaluateRules, type ModuleLoader, type PathRuleEvidence } from "./src/engine.ts";
import { addedDirectoryPathsFromSession } from "./src/bash-directory-scope-utils.ts";
import { i18n } from "./src/i18n.ts";
import type { SafetyConfig, SafetyRule } from "./src/types.ts";
import { installNoticeRenderer, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
const NOTICE_TAG = "safety";
/** 提示标签颜色；与其它扩展错开，避免看起来像同一条消息。 */
const NOTICE_COLOR: NoticeColor = "warning";
/** 本扩展的提示来源。 */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

const BASH_TOOL = "bash";
const ERROR_LEVEL = "error";
const INFO_LEVEL = "info";
const WARN_LEVEL = "warning";
const BLOCK_ACTION = "block";
const CONFIRM_ACTION = "confirm";
const WARN_ACTION = "warn";
const CONFIG_COMMAND_ALIASES = ["config:safety-guards", "safety-guards-config", "pi-safety-guards-config"] as const;
const CONFIG_SHOW_COMMAND = "show";

/** 统一提示出口：加来源标签后交给 Pi 的 notify，避免用户分不清消息来源。 */
function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  notifyWithSource({ ctx, source: NOTICE_SOURCE, level, message });
}

/** 配置读取失败时统一提示，保留原始错误文本。 */
function notifyConfigError(ctx: ExtensionContext | ExtensionCommandContext, error: unknown): void {
  notify(ctx, i18n.t("configCommandInvalid", {
    error: error instanceof Error ? error.message : String(error),
  }), ERROR_LEVEL);
}

/** 打印配置文件路径和当前生效规则；命令和启动提示共用。 */
function showEffectiveRules(ctx: ExtensionContext | ExtensionCommandContext): void {
  try {
    const path = configPath();
    const document = loadConfigDocument(path);
    const rules = describeEffectiveRules(document, parseConfig(document));
    notify(ctx, [i18n.t("configShowPath", { path }), ...(rules.length ? rules : [i18n.t("noRules")])].join("\n"), INFO_LEVEL);
  } catch (error) {
    notifyConfigError(ctx, error);
  }
}

/** 注册配置命令：只展示配置文件位置和生效规则，改规则请直接编辑 config.json。 */
function registerConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    getArgumentCompletions: () => [{ value: CONFIG_SHOW_COMMAND, label: CONFIG_SHOW_COMMAND }],
    /** 只读展示；不带参数等同于 show。 */
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const argument = args.trim();
      if (argument && argument !== CONFIG_SHOW_COMMAND) {
        notify(ctx, i18n.t("configCommandUsage"), WARN_LEVEL);
        return;
      }
      showEffectiveRules(ctx);
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/** 将规则 ID、路径证据和安全重试建议一起展示，不自动执行替代命令。 */
function describeRule(rule: SafetyRule, evidence?: PathRuleEvidence): string {
  const message = typeof rule.message === "string" ? rule.message : rule.message?.[i18n.locale()];
  const description = message ? `[${rule.id}] ${message}` : i18n.t("ruleMatched", { id: rule.id });
  if (!evidence) return description;
  const violations = evidence.violations.map(({ inputPath, resolvedPath }) =>
    i18n.t("pathViolation", { inputPath, resolvedPath }),
  ).join("\n");
  return `${description}\n${i18n.t("pathEvidence", {
    commandPath: violations,
    cwd: evidence.cwd,
    allowedRoots: evidence.allowedRoots.join(", "),
    suggestion: evidence.suggestedDirectories.map((directory) => i18n.t("addDirectorySuggestion", {
      directory,
      arguments: JSON.stringify({ path: directory }),
    })).join("\n"),
  })}`;
}

/** 先加载规则再注册统一执行入口，禁用规则不会执行模块。 */
export async function registerSafetyGuards(
  pi: ExtensionAPI,
  config: SafetyConfig,
  options: { configDirectory?: string; loader?: ModuleLoader } = {},
): Promise<void> {
  const rules = await compileRules(config, options.configDirectory ?? dirname(configPath()), options.loader);
  if (rules.length === 0) {
    pi.on("session_start", (_event, ctx) => notify(ctx, i18n.t("noRules"), INFO_LEVEL));
    return;
  }
  const warnings = new Map<string, string>();
  pi.on("session_shutdown", () => warnings.clear());
  pi.on("turn_end", () => warnings.clear());
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== BASH_TOOL) return;
    const command = String(event.input.command ?? "");
    try {
      const additionalRoots = addedDirectoryPathsFromSession(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getBranch(),
      );
      const decision = await evaluateRules(rules, command, ctx.cwd, additionalRoots);
      if (!decision) return;
      const details = decision.matches.map((rule) => describeRule(rule, decision.pathEvidence.get(rule.id))).join("\n");
      if (decision.action === BLOCK_ACTION) return { block: true, reason: i18n.t("blocked", { details }) };
      if (decision.action === CONFIRM_ACTION) {
        if (!ctx.hasUI) return { block: true, reason: i18n.t("confirmationUnavailable", { details }) };
        const accepted = await ctx.ui.confirm(i18n.t("confirmTitle"), i18n.t("confirmBody", { details, command }));
        if (!accepted) return { block: true, reason: i18n.t("confirmationRejected", { details }) };
      }
      const warned = decision.matches.filter((rule) => rule.action === WARN_ACTION);
      if (warned.length) {
        warnings.set(event.toolCallId, i18n.t("warning", {
          details: warned.map((rule) => describeRule(rule, decision.pathEvidence.get(rule.id))).join("\n"),
        }));
      }
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  // warn 必须对没有 UI 的调用者同样可见，且只附加到对应工具结果。
  pi.on("tool_result", (event) => {
    const warning = warnings.get(event.toolCallId);
    warnings.delete(event.toolCallId);
    if (!warning) return;
    return { content: [...event.content, { type: "text", text: warning }] };
  });
}

/** 配置或启用规则加载失败时阻断 Bash，避免把失败当作关闭保护。 */
export default async function piSafetyGuards(pi: ExtensionAPI): Promise<void> {
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  registerConfigCommand(pi);
  try {
    // 第一次运行时把默认规则写成真实文件，用户看得见、改得动，之后只读用户那份。
    if (ensureConfigFile()) {
      pi.on("session_start", (_event, ctx) => notify(ctx, i18n.t("configSeedCreated", { path: configPath() }), INFO_LEVEL));
    }
    await registerSafetyGuards(pi, loadConfig());
  } catch (error) {
    const reason = i18n.t("configLoadFailed", { error: error instanceof Error ? error.message : String(error) });
    pi.on("session_start", (_event, ctx) => notify(ctx, reason, ERROR_LEVEL));
    pi.on("tool_call", (event) => {
      if (event.toolName === BASH_TOOL) return { block: true, reason };
    });
  }
}

export { configPath, loadConfig, parseConfig, saveConfig } from "./src/config.ts";
export type { RuleContext, RuleMatcher } from "./src/types.ts";
export {
  addedDirectoryPathsFromSession,
  findOutOfScopeBashPaths,
} from "./src/bash-directory-scope-utils.ts";
