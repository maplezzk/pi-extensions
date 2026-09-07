import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import turnElapsed from "./turn-elapsed.ts";
import tps from "./tps.ts";
import { configPath, loadConfig, parseConfig, saveConfig, type MetricsConfig } from "./config.ts";

const messages = loadCatalog(new URL("../locales/index.json", import.meta.url));
const i18n = createTranslator(messages);
const CONFIG_COMMAND_ALIASES = ["config:metrics", "metrics-config", "pi-metrics-config"] as const;
const CONFIG_RESET_COMMAND = "reset";
const CONFIG_CHOICE = { enabled: 0, disabled: 1 } as const;
const ENABLE_COMMAND = "enable";
const DISABLE_COMMAND = "disable";
const NOTICE_WARNING = "warning" as const;
const NOTICE_INFO = "info" as const;
const NOTICE_ERROR = "error" as const;

/** 注册配置命令，通过 TUI 选择是否启用指标。 */
function registerConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    /** Completes the supported reset action. */
    getArgumentCompletions: () => [{ value: CONFIG_RESET_COMMAND, label: CONFIG_RESET_COMMAND }],
    /** Selects and persists the enabled state. */
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const value = args.trim();
      if (value && value !== CONFIG_RESET_COMMAND && value !== ENABLE_COMMAND && value !== DISABLE_COMMAND) {
        ctx.ui.notify(i18n.t("configCommandUsage"), NOTICE_WARNING);
        return;
      }
      if (value === CONFIG_RESET_COMMAND || value === ENABLE_COMMAND || value === DISABLE_COMMAND) {
        try {
          const config = parseConfig(value === CONFIG_RESET_COMMAND ? {} : { enabled: value === ENABLE_COMMAND });
          const path = saveConfig(config);
          ctx.ui.notify(i18n.t("configCommandSaved", { path }), NOTICE_INFO);
        } catch (error) {
          ctx.ui.notify(i18n.t("configCommandInvalid", {
            error: error instanceof Error ? error.message : String(error),
          }), NOTICE_ERROR);
        }
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("configCommandInteractiveOnly"), NOTICE_WARNING);
        return;
      }
      let current: MetricsConfig;
      try {
        current = loadConfig();
      } catch (error) {
        ctx.ui.notify(i18n.t("configCommandInvalid", {
          error: error instanceof Error ? error.message : String(error),
        }), NOTICE_ERROR);
        return;
      }
      const enabledChoice = i18n.t("configEnabled", { value: i18n.t(current.enabled ? "configOn" : "configOff") });
      const disabledChoice = i18n.t("configDisabled", { value: i18n.t(current.enabled ? "configOff" : "configOn") });
      const doneChoice = i18n.t("configDone");
      const selected = await ctx.ui.select(i18n.t("configMenuTitle"), [
        enabledChoice,
        disabledChoice,
        doneChoice,
      ]);
      if (selected === undefined || selected === doneChoice) return;
      const choice = selected === enabledChoice ? CONFIG_CHOICE.enabled : CONFIG_CHOICE.disabled;
      try {
        const path = saveConfig({ enabled: choice === CONFIG_CHOICE.enabled });
        ctx.ui.notify(i18n.t("configCommandSaved", { path }), NOTICE_INFO);
      } catch (error) {
        ctx.ui.notify(i18n.t("configCommandInvalid", {
          error: error instanceof Error ? error.message : String(error),
        }), NOTICE_ERROR);
      }
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/** 注册耗时和 TPS 指标事件；配置关闭时不注册指标处理器。 */
export default function piHud(pi: ExtensionAPI): void {
  registerConfigCommand(pi);
  let config: MetricsConfig;
  let configError: unknown;
  try {
    config = loadConfig();
  } catch (error) {
    config = { enabled: true };
    configError = error;
  }
  if (configError !== undefined) {
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      ctx.ui.notify(i18n.t("configLoadFailed", {
        path: configPath(),
        error: configError instanceof Error ? configError.message : String(configError),
      }), NOTICE_WARNING);
    });
  }
  if (!config.enabled) return;
  turnElapsed(pi);
  tps(pi);
}

export { configPath, loadConfig, parseConfig, saveConfig } from "./config.ts";
export type { MetricsConfig } from "./config.ts";
export { default as turnElapsed } from "./turn-elapsed.ts";
export { default as tps } from "./tps.ts";
export * from "./format-utils.ts";
export * from "./tps.ts";
