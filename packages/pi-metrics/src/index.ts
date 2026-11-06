import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createTranslator, installNoticeRenderer, loadCatalog, notifyWithSource } from "pi-extensions-i18n";
import { openConfigPanel } from "./config-panel.ts";
import { NOTICE_SOURCE } from "./notice.ts";
import turnElapsed, { createElapsedTracker } from "./turn-elapsed.ts";
import tps from "./tps.ts";
import {
  configPath,
  DEFAULT_METRICS_CONFIG,
  loadConfig,
  saveConfig,
  type MetricsConfig,
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

/** 命令参数到配置片段的映射：直接改配置时要覆盖的字段。 */
const COMMAND_CONFIG_PATCH: ReadonlyMap<string, Partial<MetricsConfig>> = new Map([
  [ENABLE_COMMAND, { enabled: true }],
  [DISABLE_COMMAND, { enabled: false }],
  [DISPLAY_LIVE_COMMAND, { display: "live" }],
  [DISPLAY_ON_STOP_COMMAND, { display: "on-stop" }],
]);

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

/** 取命令参数对应的配置补丁；`reset` 用整份默认配置覆盖当前值，未知参数返回 null。 */
function configPatchFor(value: string): Partial<MetricsConfig> | null {
  if (value === CONFIG_RESET_COMMAND) return { ...DEFAULT_METRICS_CONFIG };
  return COMMAND_CONFIG_PATCH.get(value) ?? null;
}

/**
 * 应用直接参数形式的配置命令：读当前配置、叠加一个补丁后写回。
 * 未知参数只提示用法；写盘失败由 persistConfig 自己提示，本函数不抛出。
 * 返回生效后的配置，参数无效或写盘失败时返回 null，调用方据此决定是否重装处理器。
 */
function applyCommandSetting(value: string, ctx: ExtensionCommandContext): MetricsConfig | null {
  const patch = configPatchFor(value);
  if (patch === null) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_WARNING, message: i18n.t("configCommandUsage") });
    return null;
  }
  let current: MetricsConfig;
  try {
    current = loadConfig();
  } catch (error) {
    reportConfigError(ctx, error);
    return null;
  }
  const next = { ...current, ...patch };
  return persistConfig(ctx, next) ? next : null;
}

/** 注册配置命令：不带参数打开面板，带参数时直接改一项。 */
function registerConfigCommand(
  pi: ExtensionAPI,
  applyConfig: (config: MetricsConfig) => void,
): void {
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
     * 处理命令：带参数时直改一项，不带参数时打开配置面板。
     * 两种路径都在写盘后立刻把新配置应用到当前会话，不需要 /reload。
     */
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const value = args.trim();
      if (value) {
        const next = applyCommandSetting(value, ctx);
        if (next) applyConfig(next);
        return;
      }
      if (!ctx.hasUI) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_WARNING, message: i18n.t("configCommandInteractiveOnly") });
        return;
      }
      try {
        loadConfig();
      } catch (error) {
        reportConfigError(ctx, error);
        return;
      }
      // 面板每改一项就落盘并立刻生效；Esc 关闭面板后结束。
      await openConfigPanel(ctx, {
        getConfig: loadConfig,
        onChange: (config) => {
          if (persistConfig(ctx, config)) applyConfig(config);
        },
      });
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/** 注册耗时和 TPS 指标事件；配置关闭时不注册指标处理器。 */
export default function piHud(pi: ExtensionAPI): void {
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);

  /** 已停用的指标处理器；重装前先解引用，让旧闭包可回收。 */
  let disposeHandlers: (() => void) | undefined;

  /**
   * 按一份配置重装指标处理器。
   * 关闭时只解掉旧闭包，因此面板里关掉开关立即不再注册新处理器，打开开关立即恢复，
   * 不需要 /reload（原来只在扩展加载时读一次配置，改了要重启会话）。
   */
  const applyConfig = (next: MetricsConfig): void => {
    disposeHandlers?.();
    disposeHandlers = undefined;
    if (!next.enabled) return;
    // 两个模块共用同一个运行时钟：on-stop 汇总行里的整段耗时和 spinner 显示的是同一段。
    const tracker = createElapsedTracker();
    // 两个模块的注册函数都返回 void：Pi 在 /reload 时按模块清掉监听，这里只解引用。
    turnElapsed(pi, { tracker, display: next.display });
    tps(pi, { tracker, display: next.display });
  };

  registerConfigCommand(pi, applyConfig);

  let configError: unknown;
  try {
    applyConfig(loadConfig());
  } catch (error) {
    configError = error;
    applyConfig({ ...DEFAULT_METRICS_CONFIG });
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
}

export { configPath, loadConfig, parseConfig, saveConfig } from "./config.ts";
export type { MetricsConfig } from "./config.ts";
export { default as turnElapsed } from "./turn-elapsed.ts";
export { default as tps } from "./tps.ts";
export * from "./config-panel.ts";
export * from "./format-utils.ts";
export * from "./run-summary.ts";
export * from "./tps.ts";
