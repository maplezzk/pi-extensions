import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TerminalRenameOutcome, TerminalRenameTarget, ResolveRenameOptions } from "pi-terminal-mux";
import { configPath, loadConfig, parseConfig, saveConfig, type NamingConfig } from "./config.ts";
import { i18n } from "./i18n.ts";
import { getCurrentSessionUserMessages, requestSessionNameWithTimeout, type SessionNameRequester } from "./session-name.ts";

const RENAME_COMMAND = "rename";
const CONFIG_COMMAND_ALIASES = ["config:naming", "naming-config", "pi-naming-config"] as const;
const CONFIG_RESET_COMMAND = "reset";
const CONFIG_OPTION = {
  automaticNaming: 0,
  manualNaming: 1,
  sessionTarget: 2,
  workspaceTarget: 3,
  tabTarget: 4,
  maxLength: 5,
  preferredLength: 6,
  language: 7,
  instructions: 8,
  timeout: 9,
} as const;
const MESSAGE_TYPE = "pi-naming";

export interface TerminalNamingAdapter {
  resolve(options: ResolveRenameOptions): TerminalRenameOutcome[];
  rename(reference: TerminalRenameTarget, title: string): TerminalRenameOutcome;
}

/** 终端能力按需加载；session-only 使用不依赖终端运行环境。 */
async function loadTerminalAdapter(): Promise<TerminalNamingAdapter> {
  const mux = await import("pi-terminal-mux");
  return { resolve: mux.resolveTerminalRenameTargets, rename: mux.renameTerminalTarget };
}

/** 格式化捕获的异常，不丢失原始错误。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 无交互 UI 时仍通过 Pi 消息报告结果，不静默吞错。 */
function report(pi: ExtensionAPI, ctx: ExtensionContext, notice: { message: string; level: "info" | "warning" | "error" }): void {
  const { message, level } = notice;
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else pi.sendMessage({ customType: MESSAGE_TYPE, content: message, display: true }, { triggerTurn: false });
}

/** 注册配置命令，通过 TUI 菜单和输入框修改命名配置。 */
function registerNamingConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    getArgumentCompletions: () => [{ value: CONFIG_RESET_COMMAND, label: CONFIG_RESET_COMMAND }],
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const argument = args.trim();
      if (argument && argument !== CONFIG_RESET_COMMAND) {
        report(pi, ctx, { message: i18n.t("configCommandUsage"), level: "warning" });
        return;
      }
      if (argument === CONFIG_RESET_COMMAND) {
        try {
          saveConfig(parseConfig({}));
          report(pi, ctx, {
            message: i18n.t("configCommandSaved", { path: configPath() }),
            level: "info",
          });
        } catch (error) {
          report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
        }
        return;
      }
      if (!ctx.hasUI) {
        report(pi, ctx, { message: i18n.t("configCommandInteractiveOnly"), level: "warning" });
        return;
      }

      let config: NamingConfig;
      try {
        config = loadConfig();
      } catch (error) {
        report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
        return;
      }

      /** Saves one validated menu change and reports its result. */
      const save = (next: NamingConfig): boolean => {
        try {
          saveConfig(next);
          config = next;
          report(pi, ctx, { message: i18n.t("configCommandSaved", { path: configPath() }), level: "info" });
          return true;
        } catch (error) {
          report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
          return false;
        }
      };
      /** Formats a boolean setting for the localized menu label. */
      const toggle = (value: boolean): string => value ? i18n.t("configOn") : i18n.t("configOff");
      /** Opens one text input for a scalar title setting. */
      const editText = async (title: string, current: string): Promise<string | undefined> =>
        ctx.ui.input(title, current);

      while (true) {
        const doneChoice = i18n.t("configDone");
        const choices = [
          i18n.t("configAutomaticNaming", { value: toggle(config.automaticNaming) }),
          i18n.t("configManualNaming", { value: toggle(config.manualNaming) }),
          i18n.t("configSessionTarget", { value: toggle(config.targets.session) }),
          i18n.t("configWorkspaceTarget", { value: toggle(config.targets.workspace) }),
          i18n.t("configTabTarget", { value: toggle(config.targets.tab) }),
          i18n.t("configMaxLength", { value: config.title.maxLength }),
          i18n.t("configPreferredLength", { value: config.title.preferredLength }),
          i18n.t("configLanguage", { value: config.title.language }),
          i18n.t("configInstructions", { value: config.title.instructions || i18n.t("configEmpty") }),
          i18n.t("configTimeout", { value: config.title.timeoutMs }),
          doneChoice,
        ];
        const selected = await ctx.ui.select(i18n.t("configMenuTitle"), choices);
        if (selected === undefined || selected === doneChoice) return;
        const selectedIndex = choices.indexOf(selected);
        let next: NamingConfig | undefined;
        if (selectedIndex === CONFIG_OPTION.automaticNaming) {
          next = parseConfig({ ...config, automaticNaming: !config.automaticNaming });
        } else if (selectedIndex === CONFIG_OPTION.manualNaming) {
          next = parseConfig({ ...config, manualNaming: !config.manualNaming });
        } else if (selectedIndex === CONFIG_OPTION.sessionTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, session: !config.targets.session } });
        } else if (selectedIndex === CONFIG_OPTION.workspaceTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, workspace: !config.targets.workspace } });
        } else if (selectedIndex === CONFIG_OPTION.tabTarget) {
          next = parseConfig({ ...config, targets: { ...config.targets, tab: !config.targets.tab } });
        } else {
          let inputTitle = i18n.t("configTimeoutInput");
          let inputValue = String(config.title.timeoutMs);
          if (selectedIndex === CONFIG_OPTION.maxLength) {
            inputTitle = i18n.t("configMaxLengthInput");
            inputValue = String(config.title.maxLength);
          } else if (selectedIndex === CONFIG_OPTION.preferredLength) {
            inputTitle = i18n.t("configPreferredLengthInput");
            inputValue = String(config.title.preferredLength);
          } else if (selectedIndex === CONFIG_OPTION.language) {
            inputTitle = i18n.t("configLanguageInput");
            inputValue = config.title.language;
          } else if (selectedIndex === CONFIG_OPTION.instructions) {
            inputTitle = i18n.t("configInstructionsInput");
            inputValue = config.title.instructions;
          }
          const input = await ctx.ui.input(inputTitle, inputValue);
          if (input === undefined) continue;
          const title = { ...config.title };
          if (selectedIndex === CONFIG_OPTION.maxLength) title.maxLength = Number(input.trim());
          else if (selectedIndex === CONFIG_OPTION.preferredLength) title.preferredLength = Number(input.trim());
          else if (selectedIndex === CONFIG_OPTION.language) title.language = input;
          else if (selectedIndex === CONFIG_OPTION.instructions) title.instructions = input;
          else title.timeoutMs = Number(input.trim());
          try { next = parseConfig({ ...config, title }); }
          catch (error) {
            report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
          }
        }
        if (next) save(next);
      }
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/** 按配置组合统一的自动/手动入口，可注入模型和终端替身做组合测试。 */
export async function registerNaming(
  pi: ExtensionAPI,
  config: NamingConfig,
  dependencies: { requestName?: SessionNameRequester; loadTerminal?: () => Promise<TerminalNamingAdapter> } = {},
): Promise<void> {
  const { requestName, loadTerminal = loadTerminalAdapter } = dependencies;
  if ((!config.automaticNaming && !config.manualNaming) || !Object.values(config.targets).some(Boolean)) return;
  let terminal: TerminalNamingAdapter | undefined;
  let terminalLoadError: unknown;
  if (config.targets.workspace || config.targets.tab) {
    try { terminal = await loadTerminal(); } catch (error) { terminalLoadError = error; }
  }
  let generation = 0;
  let request = 0;
  let eligible = false;
  let attempted = false;

  pi.on("session_start", (_event, ctx) => {
    generation++;
    eligible = !pi.getSessionName() && getCurrentSessionUserMessages(ctx).length === 0;
    attempted = false;
    if (terminalLoadError !== undefined) {
      report(pi, ctx, { message: i18n.t("terminalNamingFailed", { error: errorMessage(terminalLoadError) }), level: "warning" });
    }
  });
  pi.on("session_shutdown", () => { generation++; eligible = false; });
  pi.on("session_tree", () => { generation++; eligible = false; });

  /** 先捕获终端身份，再生成标题；任一新请求或会话切换都会使旧结果失效。 */
  async function rename(args: string, ctx: ExtensionContext, automatic: boolean): Promise<void> {
    const currentGeneration = generation;
    const currentRequest = ++request;
    // 新请求和 session 生命周期变化都会使当前请求失效。
    const isCurrent = () => generation === currentGeneration && request === currentRequest;
    let targets: TerminalRenameOutcome[] = [];
    let resolutionError: unknown;
    if (terminal) {
      try { targets = terminal.resolve({ tab: config.targets.tab, workspace: config.targets.workspace }); }
      catch (error) { resolutionError = error; }
    }
    let label = automatic ? "" : args.trim();
    if (!label) {
      try {
        label = await requestSessionNameWithTimeout({
          userMessages: automatic ? [args] : getCurrentSessionUserMessages(ctx),
          ctx, requestName, title: config.title,
        });
      } catch (error) {
        if (isCurrent()) report(pi, ctx, { message: i18n.t("namingFailed", { error: errorMessage(error) }), level: "error" });
        return;
      }
    }
    if (!isCurrent() || (automatic && pi.getSessionName())) return;

    const renamed: string[] = [];
    if (config.targets.session) {
      try { pi.setSessionName(label); renamed.push(i18n.t("piSessionTarget")); }
      catch (error) { report(pi, ctx, { message: i18n.t("namingFailed", { error: errorMessage(error) }), level: "error" }); }
    }
    if (resolutionError !== undefined) {
      report(pi, ctx, { message: i18n.t("terminalNamingFailed", { error: errorMessage(resolutionError) }), level: "warning" });
    }
    for (const target of targets) {
      let result = target;
      if (target.status === "ready" && terminal) {
        try { result = terminal.rename(target.reference, label); }
        catch (error) { result = { status: "failed", operation: target.reference.operation, error: errorMessage(error) }; }
      }
      if (result.status === "renamed") {
        renamed.push(i18n.t(`${result.reference.target}Target`));
      } else if (result.status === "skipped") {
        report(pi, ctx, { message: i18n.t("terminalNamingSkipped", {
          target: i18n.t(`${result.operation}Target`),
          reason: i18n.t(`skip.${result.reason}`, { setting: result.setting ?? "" }),
        }), level: "warning" });
      } else if (result.status === "failed") {
        report(pi, ctx, { message: i18n.t("terminalNamingFailed", { error: result.error }), level: "warning" });
      }
    }
    if (renamed.length > 0) {
      report(pi, ctx, { message: i18n.t("namingDone", { label, targets: [...new Set(renamed)].join(", ") }), level: "info" });
    }
  }

  if (config.manualNaming) {
    pi.registerCommand(RENAME_COMMAND, {
      description: i18n.t("renameDescription"),
      getArgumentCompletions: () => null,
      handler: async (args, ctx) => { await rename(args, ctx, false); },
    });
  }
  if (config.automaticNaming) {
    pi.on("input", (event, ctx) => {
      if (!eligible || attempted || event.source === "extension" || pi.getSessionName()) return;
      const text = event.text.trim();
      if (!text) return;
      attempted = true;
      const inputGeneration = generation;
      void rename(text, ctx, true).catch((error: unknown) => {
        if (generation !== inputGeneration) return;
        report(pi, ctx, { message: i18n.t("namingFailed", { error: errorMessage(error) }), level: "error" });
      });
    });
  }
}

/** 配置错误在 session_start 报告，不注册不完整的命名功能。 */
export default async function namingExtension(pi: ExtensionAPI): Promise<void> {
  registerNamingConfigCommand(pi);
  let config: NamingConfig;
  try { config = loadConfig(); }
  catch (error) {
    pi.on("session_start", (_event, ctx) => report(pi, ctx, { message:
      i18n.t("namingConfigFailed", { error: errorMessage(error) }), level: "warning" }));
    return;
  }
  await registerNaming(pi, config);
}
