/**
 * pi-auto-goal 扩展入口。
 *
 * agent 每次完全停止后，用第二个模型判断这次停止是「正常结束」还是「擅自早停」；
 * 判定为早停时自动注入一条 system 继续指令，并有次数上限兜底。
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { installNoticeRenderer, notifyWithSource, type NoticeLevel } from "pi-extensions-i18n";
import { i18n } from "./i18n.ts";
import { NOTICE_SOURCE } from "./notice.ts";
import {
  configPath,
  DEFAULT_AUTO_GOAL_CONFIG,
  loadConfig,
  parseConfig,
  saveConfig,
  type AutoGoalConfig,
} from "./config.ts";
import { collectTurnSnapshot, readLastAssistantStopReason, STOP_REASON_ABORTED } from "./session-context.ts";
import { evaluateStop, type StopOutcome } from "./evaluate.ts";
import { createJudgeModelInvoker, createJudgeModelSource } from "./judge-model.ts";
import { createStopVerdictRequester } from "./verdict.ts";
import { formatBudget, isJudgeableStopReason } from "./guard.ts";
import {
  buildInterruptedNotice,
  buildNotCompletedNotice,
  buildSendFailedNotice,
  buildVerdictNotice,
  type VerdictNotice,
} from "./verdict-notice.ts";
import { formatModelValue } from "./model-choice.ts";
import { openConfigPanel } from "./config-panel.ts";
import { registerNudgeContext, triggerSystemNudge } from "./system-nudge.ts";

/** notify 级别常量，避免散落裸字符串。 */
const NOTICE_INFO: NoticeLevel = "info";
const NOTICE_WARNING: NoticeLevel = "warning";
const NOTICE_ERROR: NoticeLevel = "error";

/** 允许自动判定的运行模式。 */
type JudgeMode = "tui" | "rpc";

/**
 * 允许自动判定的运行模式集合。
 * print 与 json 模式在 agent 结束后立即收尾，settled 回调里的 ctx 已经失效，
 * 此时发消息会报 ctx stale，且催促也不可能真的执行，所以直接跳过。
 */
const JUDGE_MODES: ReadonlySet<string> = new Set<JudgeMode>(["tui", "rpc"]);

/** 配置命令别名。 */
const CONFIG_COMMAND_ALIASES = ["config:auto-goal", "auto-goal", "pi-auto-goal-config"] as const;
/** 配置命令支持的非交互参数。 */
const CONFIG_ARGUMENTS = ["enable", "disable", "status", "reset", "model"] as const;
const CONFIG_ENABLE_COMMAND = "enable";
const CONFIG_DISABLE_COMMAND = "disable";
const CONFIG_STATUS_COMMAND = "status";
const CONFIG_RESET_COMMAND = "reset";
const CONFIG_MODEL_COMMAND = "model";
/** `model` 参数里表示「复用当前会话模型」的取值。 */
const CONFIG_MODEL_REUSE_VALUES: readonly string[] = ["default", "current", "session"];

/** 扩展运行期状态。 */
interface AutoGoalRuntime {
  /** 当前生效配置（改动配置后需要 /reload 重新加载）。 */
  config: AutoGoalConfig;
  /** 当前会话 id，切换会话时重置预算。 */
  sessionId: string | undefined;
  /** 当前用户请求已自动干预的次数。 */
  used: number;
  /** 是否有一次判定正在进行，避免并发触发。 */
  inFlight: boolean;
}

/** 创建运行期状态。 */
function createRuntime(config: AutoGoalConfig): AutoGoalRuntime {
  return {
    config,
    sessionId: undefined,
    used: 0,
    inFlight: false,
  };
}

/** 读取配置；失败时回退默认配置并把错误留给 session_start 报告。 */
function loadInitialConfig(): { config: AutoGoalConfig; error: unknown } {
  try {
    return { config: loadConfig(), error: undefined };
  } catch (error) {
    return { config: { ...DEFAULT_AUTO_GOAL_CONFIG }, error };
  }
}

/** 把错误对象转成可读文案；统一供 UI 提示使用，避免各处重复写 instanceof 分支。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 会话切换时重置干预预算，避免把上一个会话的次数带到新会话。 */
function syncSession(
  runtime: AutoGoalRuntime,
  ctx: Pick<ExtensionContext, "sessionManager">,
): void {
  const sessionId = ctx.sessionManager.getSessionId();
  if (runtime.sessionId === sessionId) return;
  runtime.sessionId = sessionId;
  runtime.used = 0;
}

/** 判定异步返回后确认会话没有被用户接管：仍然空闲，且叶节点没有变化。 */
function isStillCurrent(
  ctx: Pick<ExtensionContext, "isIdle" | "sessionManager">,
  leafId: string | null | undefined,
): boolean {
  if (!ctx.isIdle()) return false;
  return ctx.sessionManager.getLeafId() === leafId;
}

/** 配置状态文案，供 /config:auto-goal status 使用。 */
function buildStatusText(runtime: AutoGoalRuntime): string {
  const { config } = runtime;
  const limit = config.maxAutoContinues <= 0
    ? i18n.t("configUnlimited")
    : String(config.maxAutoContinues);
  return [
    i18n.t("configStatusTitle"),
    i18n.t("configStatusEnabled", { value: i18n.t(config.enabled ? "configOn" : "configOff") }),
    i18n.t("configStatusModel", { value: config.model || i18n.t("configModelCurrent") }),
    i18n.t("configStatusLimit", { value: limit }),
    i18n.t("configStatusThreshold", { value: String(config.confidenceThreshold) }),
    i18n.t("configStatusJudgeTokens", { value: String(config.judgeMaxTokens) }),
    i18n.t("configStatusVerdictNotice", {
      value: i18n.t(config.showVerdictNotice ? "configOn" : "configOff"),
    }),
    i18n.t("configStatusUsed", { value: String(runtime.used) }),
  ].join("\n");
}

/** 保存配置并把结果反馈到 UI；保存失败必须报错而不是静默，返回是否真的保存成功。 */
function persistConfig(next: AutoGoalConfig, ctx: ExtensionCommandContext): boolean {
  try {
    const path = saveConfig(next);
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_INFO, message: i18n.t("configCommandSaved", { path }) });
    return true;
  } catch (error) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_ERROR, message: i18n.t("configCommandInvalid", { error: errorText(error) }) });
    return false;
  }
}

/**
 * 保存配置，并在保存成功时同步运行期配置。
 * 运行期配置是判定时的唯一读取源，所以配置命令改完立即生效；
 * 手动改配置文件仍需要 /reload 重新加载。
 */
function applyConfig(next: AutoGoalConfig, runtime: AutoGoalRuntime, ctx: ExtensionCommandContext): void {
  if (!persistConfig(next, ctx)) return;
  runtime.config = next;
}

/** 配置里判定模型的展示文本：空值表示复用当前会话模型。 */
function judgeModelLabel(runtime: AutoGoalRuntime): string {
  return formatModelValue(runtime.config.model, i18n.t("configModelCurrent"));
}

/** 处理 /config:auto-goal model：无值时显示当前模型，有值时设置。 */
function runModelArgument(value: string, runtime: AutoGoalRuntime, ctx: ExtensionCommandContext): void {
  if (value === "") {
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: NOTICE_INFO,
      message: i18n.t("configStatusModel", { value: judgeModelLabel(runtime) }),
    });
    return;
  }
  const model = CONFIG_MODEL_REUSE_VALUES.includes(value) ? "" : value;
  try {
    const next = parseConfig({ ...runtime.config, model });
    applyConfig(next, runtime, ctx);
  } catch (error) {
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: NOTICE_WARNING,
      message: i18n.t("configModelInvalid", { value, error: errorText(error) }),
    });
  }
}

/**
 * 保存面板里改动的配置并让它立即生效。
 *
 * 存盘失败也要先把新配置用在本次会话里，用户不至于改了没反应；失败必须报错而不是静默。
 * 成功不提示：面板里逐项切换会刷屏，面板关闭即已生效。
 */
function applyPanelConfig(next: AutoGoalConfig, runtime: AutoGoalRuntime, ctx: ExtensionCommandContext): void {
  runtime.config = next;
  try {
    saveConfig(next);
  } catch (error) {
    notifyWithSource({
      ctx,
      source: NOTICE_SOURCE,
      level: NOTICE_ERROR,
      message: i18n.t("configSaveFailed", { error: errorText(error) }),
    });
  }
}

/** 打开配置面板（TUI 设置列表）。 */
async function openAutoGoalConfigPanel(runtime: AutoGoalRuntime, ctx: ExtensionCommandContext): Promise<void> {
  await openConfigPanel(ctx, {
    getConfig: () => runtime.config,
    getModels: () => ctx.modelRegistry.getAvailable(),
    onChange: (config) => applyPanelConfig(config, runtime, ctx),
  });
}

/** 处理带参数的配置命令。 */
function runConfigArgument(value: string, runtime: AutoGoalRuntime, ctx: ExtensionCommandContext): void {
  const [head, ...rest] = value.split(/\s+/);
  if (head === CONFIG_MODEL_COMMAND) {
    runModelArgument(rest.join(" ").trim(), runtime, ctx);
    return;
  }
  if (value === CONFIG_STATUS_COMMAND) {
    notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_INFO, message: buildStatusText(runtime) });
    return;
  }
  if (value === CONFIG_RESET_COMMAND) {
    applyConfig({ ...DEFAULT_AUTO_GOAL_CONFIG }, runtime, ctx);
    return;
  }
  if (value === CONFIG_ENABLE_COMMAND || value === CONFIG_DISABLE_COMMAND) {
    applyConfig({ ...runtime.config, enabled: value === CONFIG_ENABLE_COMMAND }, runtime, ctx);
  }
}

/** 注册 /config:auto-goal 及其别名。 */
function registerConfigCommand(pi: ExtensionAPI, runtime: AutoGoalRuntime): void {
  const command = {
    description: i18n.t("configCommandDescription"),
    /** 补全受支持的参数。 */
    getArgumentCompletions: () => CONFIG_ARGUMENTS.map((value) => ({ value, label: value })),
    /** 按参数执行配置动作，无参数时打开 TUI 菜单。 */
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const value = args.trim();
      const head = value.split(/\s+/)[0] ?? "";
      if (value && !CONFIG_ARGUMENTS.includes(head as (typeof CONFIG_ARGUMENTS)[number])) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_WARNING, message: i18n.t("configCommandUsage") });
        return;
      }
      if (value) {
        runConfigArgument(value, runtime, ctx);
        return;
      }
      if (!ctx.hasUI) {
        notifyWithSource({ ctx, source: NOTICE_SOURCE, level: NOTICE_WARNING, message: i18n.t("configCommandInteractiveOnly") });
        return;
      }
      await openAutoGoalConfigPanel(runtime, ctx);
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/**
 * 把判定结论写进会话区（消息下方，带底色的消息块）。
 *
 * 一个有判定的轮次只发一条：正文一行，细节（理由/失败原因/已注入的催促）默认收起、
 * Ctrl+O 展开，避免每轮往会话区里堆好几条提示。
 */
function writeVerdictNotice(
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  runtime: AutoGoalRuntime,
  notice: VerdictNotice,
): void {
  if (!runtime.config.showVerdictNotice) return;
  notifyWithSource({
    ctx,
    source: NOTICE_SOURCE,
    level: notice.level,
    message: notice.text,
    textColor: notice.color,
    details: notice.details,
  });
}

/** 把判定结果落到 UI 与会话：只有 continue 才会真的注入催促并触发新一轮。 */
function applyOutcome(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoGoalRuntime,
  outcome: StopOutcome,
): void {
  switch (outcome.kind) {
    case "continue": {
      // 先发送再记账：发送失败不应该消耗干预预算。
      try {
        triggerSystemNudge(pi, outcome.message);
      } catch (error) {
        writeVerdictNotice(ctx, runtime, buildSendFailedNotice(errorText(error)));
        return;
      }
      runtime.used += 1;
      writeVerdictNotice(ctx, runtime, buildVerdictNotice(outcome, outcome.message));
      return;
    }
    // 其余三种结果都是「一行结论 + 展开细节」，没有额外副作用。
    case "stop":
    case "skipped":
    case "failed":
      writeVerdictNotice(ctx, runtime, buildVerdictNotice(outcome));
  }
}

/** 注册停止判定事件。 */
function registerStopJudgement(pi: ExtensionAPI, runtime: AutoGoalRuntime): void {
  // 真实用户输入开启新一轮任务：会话变了就切预算，同一会话内也重置次数。
  // 扩展注入的催促不是用户消息，不会走到这里，所以自动干预不会自己重置次数。
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    syncSession(runtime, ctx);
    runtime.used = 0;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!runtime.config.enabled) return;
    if (!JUDGE_MODES.has(ctx.mode)) return;
    // 已有判定在跑，或 Pi 还会继续（排队消息 / 其他扩展启动了新一轮）时不介入。
    if (runtime.inFlight) return;
    if (!ctx.isIdle()) return;
    if (ctx.hasPendingMessages()) return;

    syncSession(runtime, ctx);
    const branch = ctx.sessionManager.getBranch();
    // 只判定「正常跑完」的轮次。
    // 用户按 Esc 打断时结束原因是 aborted 或 error、内容为空；
    // 把这种轮次当成提前停止去催，会立刻把 agent 复活，让人以为 Esc 没生效。
    const stopReason = readLastAssistantStopReason(branch);
    if (!isJudgeableStopReason(stopReason)) {
      writeVerdictNotice(
        ctx,
        runtime,
        stopReason === STOP_REASON_ABORTED
          ? buildInterruptedNotice()
          : buildNotCompletedNotice(stopReason),
      );
      return;
    }
    const snapshot = collectTurnSnapshot(branch, {
      maxUserRequestChars: runtime.config.maxUserRequestChars,
      maxFinalOutputChars: runtime.config.maxFinalOutputChars,
      maxToolTraceEntries: runtime.config.maxToolTraceEntries,
      maxUserAnswerChars: runtime.config.maxUserAnswerChars,
      includeToolTrace: runtime.config.includeToolTrace,
    });
    if (!snapshot?.userRequest) return;

    const leafId = ctx.sessionManager.getLeafId();
    runtime.inFlight = true;
    try {
      // 每次判定都从当前上下文取模型与鉴权，避免会话切模型后用到旧配置。
      const judge = createStopVerdictRequester(
        createJudgeModelInvoker({
          source: createJudgeModelSource(ctx, runtime.config),
          maxTokens: runtime.config.judgeMaxTokens,
        }),
      );
      const outcome = await evaluateStop({
        snapshot,
        config: runtime.config,
        judge,
        used: runtime.used,
        signal: ctx.signal,
      });
      // 判定期间用户可能已经发了新消息；此时丢弃结果，不打断用户。
      if (!isStillCurrent(ctx, leafId)) return;
      applyOutcome(pi, ctx, runtime, outcome);
    } finally {
      runtime.inFlight = false;
    }
  });
}

/** 扩展入口。 */
export default function piAutoGoal(pi: ExtensionAPI): void {
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  const { config, error } = loadInitialConfig();
  const runtime = createRuntime(config);
  registerConfigCommand(pi, runtime);
  registerNudgeContext(pi);
  registerStopJudgement(pi, runtime);

  if (error !== undefined) {
    pi.on("session_start", (_event, ctx) => {
      notifyWithSource({
        ctx,
        source: NOTICE_SOURCE,
        level: NOTICE_WARNING,
        message: i18n.t("configLoadFailed", { path: configPath(), error: errorText(error) }),
      });
    });
  }
}

export { configPath, loadConfig, parseConfig, saveConfig } from "./config.ts";
export type { AutoGoalConfig } from "./config.ts";
export { NUDGE_CUSTOM_TYPE, isNudgeMessage, registerNudgeContext, triggerSystemNudge } from "./system-nudge.ts";
export { collectTurnSnapshot, truncateText } from "./session-context.ts";
export type { TurnSnapshot } from "./session-context.ts";
export { createStopVerdictRequester, parseJudgeVerdict } from "./verdict.ts";
export type { JudgeInvoker, JudgeRequest, JudgeResponse, StopVerdict } from "./verdict.ts";
export {
  createJudgeModelInvoker,
  createJudgeModelSource,
  resolveJudgeModel,
  type JudgeModelSource,
} from "./judge-model.ts";
export { hasContinueBudget, formatBudget } from "./guard.ts";
export { renderContinueMessage } from "./continue-message.ts";
export { evaluateStop, createJudgeAbortHandle } from "./evaluate.ts";
export type { StopOutcome, StopSkipCode } from "./evaluate.ts";
