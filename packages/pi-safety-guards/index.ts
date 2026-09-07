import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { configPath, loadConfig, loadConfigDocument, saveConfigDocument } from "./src/config.ts";
import { DEFAULT_PRESETS, PRESETS } from "./src/presets.ts";
import { compileRules, evaluateRules, type ModuleLoader, type PathRuleEvidence } from "./src/engine.ts";
import { addedDirectoryPathsFromSession } from "./src/bash-directory-scope-utils.ts";
import { i18n } from "./src/i18n.ts";
import type { SafetyConfig, SafetyRule } from "./src/types.ts";

const BASH_TOOL = "bash";
const ERROR_LEVEL = "error";
const INFO_LEVEL = "info";
const WARN_LEVEL = "warning";
const BLOCK_ACTION = "block";
const CONFIRM_ACTION = "confirm";
const WARN_ACTION = "warn";
const CONFIG_COMMAND_ALIASES = ["config:safety-guards", "safety-guards-config", "pi-safety-guards-config"] as const;
const CONFIG_RESET_COMMAND = "reset";
const CONFIG_PRESET_NAMES = Object.keys(PRESETS);

/** 注册配置命令，通过 TUI 菜单选择安全预设并保留自定义规则。 */
function registerConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    getArgumentCompletions: () => [{ value: CONFIG_RESET_COMMAND, label: CONFIG_RESET_COMMAND }],
    /** Handles preset selection and persists each change immediately. */
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const argument = args.trim();
      if (argument && argument !== CONFIG_RESET_COMMAND) {
        ctx.ui.notify(i18n.t("configCommandUsage"), WARN_LEVEL);
        return;
      }
      if (argument === CONFIG_RESET_COMMAND) {
        try {
          const path = saveConfigDocument({ presets: [...DEFAULT_PRESETS], rules: [] });
          ctx.ui.notify(i18n.t("configCommandSaved", { path }), INFO_LEVEL);
        } catch (error) {
          ctx.ui.notify(i18n.t("configCommandInvalid", {
            error: error instanceof Error ? error.message : String(error),
          }), ERROR_LEVEL);
        }
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("configCommandInteractiveOnly"), WARN_LEVEL);
        return;
      }

      let document: { presets: string[]; rules: unknown[] };
      try {
        document = loadConfigDocument();
      } catch (error) {
        ctx.ui.notify(i18n.t("configCommandInvalid", {
          error: error instanceof Error ? error.message : String(error),
        }), ERROR_LEVEL);
        return;
      }
      while (true) {
        const choices = CONFIG_PRESET_NAMES.map((name) => i18n.t("configPreset", {
          name,
          value: document.presets.includes(name) ? i18n.t("configOn") : i18n.t("configOff"),
        }));
        choices.push(i18n.t("configCustomRules", { count: document.rules.length }), i18n.t("configDone"));
        const selected = await ctx.ui.select(i18n.t("configMenuTitle"), choices);
        if (selected === undefined || selected === choices[choices.length - 1]) return;
        const selectedIndex = choices.indexOf(selected);
        if (selectedIndex === CONFIG_PRESET_NAMES.length) {
          ctx.ui.notify(i18n.t("configCustomRulesHint"), INFO_LEVEL);
          continue;
        }
        const preset = CONFIG_PRESET_NAMES[selectedIndex];
        if (!preset) continue;
        const presets = document.presets.includes(preset)
          ? document.presets.filter((name) => name !== preset)
          : [...document.presets, preset];
        try {
          const path = saveConfigDocument({ presets, rules: document.rules });
          document = { ...document, presets };
          ctx.ui.notify(i18n.t("configCommandSaved", { path }), INFO_LEVEL);
        } catch (error) {
          ctx.ui.notify(i18n.t("configCommandInvalid", {
            error: error instanceof Error ? error.message : String(error),
          }), ERROR_LEVEL);
        }
      }
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
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(i18n.t("noRules"), INFO_LEVEL));
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
  registerConfigCommand(pi);
  try {
    await registerSafetyGuards(pi, loadConfig());
  } catch (error) {
    const reason = i18n.t("configLoadFailed", { error: error instanceof Error ? error.message : String(error) });
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(reason, ERROR_LEVEL));
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
