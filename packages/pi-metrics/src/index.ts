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
const ENABLE_COMMAND = "enable";
const DISABLE_COMMAND = "disable";
const NOTICE_WARNING = "warning" as const;
const NOTICE_INFO = "info" as const;
const NOTICE_ERROR = "error" as const;

/** 注册配置命令，允许通过 JSON 参数或交互式输入持久化 metrics 配置。 */
function registerConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    /** Completes the supported enable, disable and reset actions. */
    getArgumentCompletions: () => [
      { value: ENABLE_COMMAND, label: ENABLE_COMMAND },
      { value: DISABLE_COMMAND, label: DISABLE_COMMAND },
      { value: CONFIG_RESET_COMMAND, label: CONFIG_RESET_COMMAND },
    ],
    /** Parses and persists a complete JSON configuration or a short action. */
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      let value = args.trim();
      if (!value) {
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
        const input = await ctx.ui.input(i18n.t("configCommandInput"), JSON.stringify(current));
        if (input === undefined) return;
        value = input.trim();
      }

      try {
        const config = value === ENABLE_COMMAND
          ? parseConfig({ enabled: true })
          : value === DISABLE_COMMAND
            ? parseConfig({ enabled: false })
            : value === CONFIG_RESET_COMMAND
              ? parseConfig({})
              : parseConfig(JSON.parse(value));
        const path = saveConfig(config);
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
