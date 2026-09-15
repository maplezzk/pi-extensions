import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createTranslator, installNoticeRenderer, loadCatalog, notifyWithSource } from "pi-extensions-i18n";
import { NOTICE_SOURCE } from "./notice.ts";
import turnElapsed, { createElapsedTracker } from "./turn-elapsed.ts";
import tps from "./tps.ts";
import {
  configPath,
  DEFAULT_METRICS_CONFIG,
  loadConfig,
  saveConfig,
  type MetricsConfig,
  type MetricsDisplay,
} from "./config.ts";

const messages = loadCatalog(new URL("../locales/index.json", import.meta.url));
const i18n = createTranslator(messages);
const CONFIG_COMMAND_ALIASES = ["config:metrics", "metrics-config", "pi-metrics-config"] as const;
const CONFIG_RESET_COMMAND = "reset";
const ENABLE_COMMAND = "enable";
const DISABLE_COMMAND = "disable";
const DISPLAY_LIVE_COMMAND = "live";
const DISPLAY_ON_STOP_COMMAND = "on-stop";
const NOTICE_WARNING = "warning" as const;
const NOTICE_INFO = "info" as const;
const NOTICE_ERROR = "error" as const;
const DISPLAY_FLIP: Record<MetricsDisplay, MetricsDisplay> = {
  [DISPLAY_LIVE_COMMAND]: DISPLAY_ON_STOP_COMMAND,
  [DISPLAY_ON_STOP_COMMAND]: DISPLAY_LIVE_COMMAND,
};

/** 命令参数到配置片段的映射：直接改配置时要覆盖的字段。 */
const COMMAND_CONFIG_PATCH: ReadonlyMap<string, Partial<MetricsConfig>> = new Map([
  [ENABLE_COMMAND, { enabled: true }],
  [DISABLE_COMMAND, { enabled: false }],
  [DISPLAY_LIVE_COMMAND, { display: "live" }],
  [DISPLAY_ON_STOP_COMMAND, { display: "on-stop" }],
]);

/** 配置值对应的菜单文案。 */
function displayLabel(display: MetricsDisplay): string {
  return i18n.t(display === "on-stop" ? "configDisplayOnStop" : "configDisplayLive");
}

/** 保存配置并提示结果；写盘失败时只提示不抛出，返回是否成功。 */
function persistConfig(ctx: ExtensionCommandContext, config: MetricsConfig): boolean {
  try {
    const path = saveConfig(config);
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_INFO, message: i18n.t("configCommandSaved", { path }) });
    return true;
  } catch (error) {
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: NOTICE_ERROR,
      message: i18n.t("configCommandInvalid", {
        error: error instanceof Error ? error.message : String(error),
      }),
    });
    return false;
  }
}

/** 提示无效配置并返回 false，供读取配置失败时复用。 */
function reportConfigError(ctx: ExtensionCommandContext, error: unknown): false {
  notifyWithSource({
    ctx,
    source: NOTICE_SOURCE,
    level: NOTICE_ERROR,
    message: i18n.t("configCommandInvalid", {
      error: error instanceof Error ? error.message : String(error),
    }),
  });
  return false;
}

/**
 * 弹出配置菜单，返回用户改动后的配置。
 * 只调用 TUI 选择，不写盘：选择「完成」或按 Esc 时返回 null，由调用方结束编辑；
 * 返回的配置还需要调用方自己落盘。
 */
async function promptConfigChange(
  ctx: ExtensionCommandContext,
  current: MetricsConfig,
): Promise<MetricsConfig | null> {
  const enabledChoice = i18n.t("configEnabled", { value: i18n.t(current.enabled ? "configOn" : "configOff") });
  const displayChoice = i18n.t("configDisplay", { value: displayLabel(current.display) });
  const doneChoice = i18n.t("configDone");
  const selected = await ctx.ui.select(i18n.t("configMenuTitle"), [enabledChoice, displayChoice, doneChoice]);
  if (selected === undefined || selected === doneChoice) return null;
  return selected === enabledChoice
    ? { ...current, enabled: !current.enabled }
    : { ...current, display: DISPLAY_FLIP[current.display] };
}

/** 取命令参数对应的配置补丁；`reset` 用整份默认配置覆盖当前值，未知参数返回 null。 */
function configPatchFor(value: string): Partial<MetricsConfig> | null {
  if (value === CONFIG_RESET_COMMAND) return { ...DEFAULT_METRICS_CONFIG };
  return COMMAND_CONFIG_PATCH.get(value) ?? null;
}

/**
 * 应用直接参数形式的配置命令：读当前配置、叠加一个补丁后写回。
 * 未知参数只提示用法；写盘失败由 persistConfig 自己提示，本函数不抛出。
 */
function applyCommandSetting(value: string, ctx: ExtensionCommandContext): void {
  const patch = configPatchFor(value);
  if (patch === null) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_WARNING, message: i18n.t("configCommandUsage") });
    return;
  }
  let current: MetricsConfig;
  try {
    current = loadConfig();
  } catch (error) {
    reportConfigError(ctx, error);
    return;
  }
  persistConfig(ctx, { ...current, ...patch });
}

/** 注册配置命令，通过 TUI 循环编辑，或直接用参数改一项。 */
function registerConfigCommand(pi: ExtensionAPI): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    /** Completes the supported direct settings. */
    getArgumentCompletions: () => [
      { value: CONFIG_RESET_COMMAND, label: CONFIG_RESET_COMMAND },
      { value: ENABLE_COMMAND, label: ENABLE_COMMAND },
      { value: DISABLE_COMMAND, label: DISABLE_COMMAND },
      { value: DISPLAY_LIVE_COMMAND, label: DISPLAY_LIVE_COMMAND },
      { value: DISPLAY_ON_STOP_COMMAND, label: DISPLAY_ON_STOP_COMMAND },
    ],
    /**
     * 处理命令：带参数时直改一项，不带参数时进入 TUI 菜单循环；
     * 写盘和提示都是副作用，配置改动需要 /reload 才生效。
     */
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const value = args.trim();
      if (value) {
        applyCommandSetting(value, ctx);
        return;
      }
      if (!ctx.hasUI) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_WARNING, message: i18n.t("configCommandInteractiveOnly") });
        return;
      }
      let current: MetricsConfig;
      try {
        current = loadConfig();
      } catch (error) {
        reportConfigError(ctx, error);
        return;
      }
      // 每选一项就落盘并重新打开菜单，直到用户选「完成」或按 Esc。
      for (;;) {
        const next = await promptConfigChange(ctx, current);
        if (next === null) return;
        if (persistConfig(ctx, next)) current = next;
      }
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/** 注册耗时和 TPS 指标事件；配置关闭时不注册指标处理器。 */
export default function piHud(pi: ExtensionAPI): void {
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  registerConfigCommand(pi);
  let config: MetricsConfig;
  let configError: unknown;
  try {
    config = loadConfig();
  } catch (error) {
    config = { ...DEFAULT_METRICS_CONFIG };
    configError = error;
  }
  if (configError !== undefined) {
    pi.on("session_start", (_event, ctx: ExtensionContext) => {
      notifyWithSource({
        ctx,
        source: NOTICE_SOURCE,
        level: NOTICE_WARNING,
        message: i18n.t("configLoadFailed", {
          path: configPath(),
          error: configError instanceof Error ? configError.message : String(configError),
        }),
      });
    });
  }
  if (!config.enabled) return;
  // 两个模块共用同一个运行时钟：on-stop 汇总行里的整段耗时和 spinner 显示的是同一段。
  const tracker = createElapsedTracker();
  turnElapsed(pi, { tracker, display: config.display });
  tps(pi, { tracker, display: config.display });
}

export { configPath, loadConfig, parseConfig, saveConfig } from "./config.ts";
export type { MetricsConfig } from "./config.ts";
export { default as turnElapsed } from "./turn-elapsed.ts";
export { default as tps } from "./tps.ts";
export * from "./format-utils.ts";
export * from "./run-summary.ts";
export * from "./tps.ts";
