import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TerminalRenameOutcome, TerminalRenameTarget, ResolveRenameOptions } from "pi-terminal-mux";
import { configPath, loadConfig, parseConfig, saveConfig, type NamingConfig } from "./config.ts";
import { openConfigPanel } from "./config-panel.ts";
import { i18n } from "./i18n.ts";
import { NOTICE_TAG_COLOR, installNoticeRenderer, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
const NOTICE_TAG = "naming";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };
import { getCurrentSessionUserMessages, requestSessionNameWithTimeout, type SessionNameRequester } from "./session-name.ts";

const RENAME_COMMAND = "rename";
const CONFIG_COMMAND_ALIASES = ["config:naming", "naming-config", "pi-naming-config"] as const;
const CONFIG_RESET_COMMAND = "reset";
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
  if (ctx.hasUI) notifyWithSource({ ctx, source: NOTICE_SOURCE, level, message });
  else pi.sendMessage({ customType: MESSAGE_TYPE, content: message, display: true }, { triggerTurn: false });
}

export interface NamingConfigStore {
  load(): NamingConfig;
  save(config: NamingConfig): void;
  path(): string;
}

/** 运行期持有的命名配置；配置面板改动后直接改这里的值，不用重启会话。 */
export interface NamingRuntime {
  config: NamingConfig;
}

/** 把新配置写进运行期持有者；没有运行期持有者（如只读命令场景）时不动任何状态。 */
function applyConfig(runtime: NamingRuntime | undefined, next: NamingConfig): void {
  if (runtime) runtime.config = next;
}

/** 注册配置命令，通过 TUI 面板修改命名配置。 */
export function registerNamingConfigCommand(
  pi: ExtensionAPI,
  store: NamingConfigStore = { load: loadConfig, save: saveConfig, path: configPath },
  runtime?: NamingRuntime,
): void {
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
          const defaults = parseConfig({});
          store.save(defaults);
          applyConfig(runtime, defaults);
          report(pi, ctx, {
            message: i18n.t("configCommandSaved", { path: store.path() }),
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
        config = store.load();
      } catch (error) {
        report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
        return;
      }

      /** 面板里改一项：先存盘、再同步运行期配置；失败只报错，不静默丢失界面上的改动。 */
      const applyPanelChange = (next: NamingConfig): void => {
        try {
          store.save(next);
          config = next;
          applyConfig(runtime, next);
        } catch (error) {
          report(pi, ctx, { message: i18n.t("configCommandInvalid", { error: errorMessage(error) }), level: "error" });
        }
      };

      await openConfigPanel(ctx, { getConfig: () => config, onChange: applyPanelChange });
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/** 按配置组合统一的自动/手动入口，可注入模型和终端替身做组合测试。 */
export async function registerNaming(
  pi: ExtensionAPI,
  config: NamingConfig,
  dependencies: { requestName?: SessionNameRequester; loadTerminal?: () => Promise<TerminalNamingAdapter>; runtime?: NamingRuntime } = {},
): Promise<void> {
  const { requestName, loadTerminal = loadTerminalAdapter, runtime } = dependencies;
  // 运行期配置随时可能被配置面板改写，所以每次使用都读一次，不缓存快照。
  const current = (): NamingConfig => runtime?.config ?? config;
  const initial = current();
  if ((!initial.automaticNaming && !initial.manualNaming) || !Object.values(initial.targets).some(Boolean)) return;
  // 终端能力按需加载：面板里把 workspace/tab 打开后，下一次命名就会去加载，不用 reload。
  let terminalPromise: Promise<TerminalNamingAdapter> | undefined;
  /** 取终端适配器（只加载一次）；加载失败按调用方处理。 */
  const getTerminal = (): Promise<TerminalNamingAdapter> => (terminalPromise ??= loadTerminal());
  let generation = 0;
  let request = 0;
  let eligible = false;
  let attempted = false;

  pi.on("session_start", (_event, ctx) => {
    generation++;
    eligible = !pi.getSessionName() && getCurrentSessionUserMessages(ctx).length === 0;
    attempted = false;
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
    const liveTargets = current().targets;
    // 只有开了 workspace/tab 目标才需要终端；适配器不提前加载，面板打开开关后一样能用。
    if (liveTargets.workspace || liveTargets.tab) {
      try {
        const terminal = await getTerminal();
        targets = terminal.resolve({ tab: liveTargets.tab, workspace: liveTargets.workspace });
      } catch (error) { resolutionError = error; }
    }
    let label = automatic ? "" : args.trim();
    if (!label) {
      try {
        label = await requestSessionNameWithTimeout({
          userMessages: automatic ? [args] : getCurrentSessionUserMessages(ctx),
          ctx, requestName, title: current().title,
        });
      } catch (error) {
        if (isCurrent()) report(pi, ctx, { message: i18n.t("namingFailed", { error: errorMessage(error) }), level: "error" });
        return;
      }
    }
    if (!isCurrent() || (automatic && pi.getSessionName())) return;

    const renamed: string[] = [];
    if (current().targets.session) {
      try { pi.setSessionName(label); renamed.push(i18n.t("piSessionTarget")); }
      catch (error) { report(pi, ctx, { message: i18n.t("namingFailed", { error: errorMessage(error) }), level: "error" }); }
    }
    if (resolutionError !== undefined) {
      report(pi, ctx, { message: i18n.t("terminalNamingFailed", { error: errorMessage(resolutionError) }), level: "warning" });
    }
    for (const target of targets) {
      let result = target;
      if (target.status === "ready") {
        try { result = (await getTerminal()).rename(target.reference, label); }
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

  if (initial.manualNaming) {
    pi.registerCommand(RENAME_COMMAND, {
      description: i18n.t("renameDescription"),
      getArgumentCompletions: () => null,
      handler: async (args, ctx) => { await rename(args, ctx, false); },
    });
  }
  if (initial.automaticNaming) {
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
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  let config: NamingConfig;
  try { config = loadConfig(); }
  catch (error) {
    registerNamingConfigCommand(pi);
    pi.on("session_start", (_event, ctx) => report(pi, ctx, { message:
      i18n.t("namingConfigFailed", { error: errorMessage(error) }), level: "warning" }));
    return;
  }
  // 面板改一项就改这里，后续命名请求读到的就是新值，不用 /reload。
  const runtime: NamingRuntime = { config };
  registerNamingConfigCommand(pi, undefined, runtime);
  await registerNaming(pi, config, { runtime });
}
