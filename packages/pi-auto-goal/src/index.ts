/**
 * pi-auto-goal 扩展入口。
 *
 * agent 每次完全停止后，用第二个模型判断这次停止是「正常结束」还是「擅自早停」；
 * 判定为早停时，以用户语气自动发一条严厉的继续指令，并有次数上限兜底。
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";
import {
  configPath,
  DEFAULT_AUTO_GOAL_CONFIG,
  loadConfig,
  parseConfig,
  saveConfig,
  type AutoGoalConfig,
} from "./config.ts";
import { collectTurnSnapshot } from "./session-context.ts";
import { evaluateStop, STOP_SKIP_BUDGET, type StopOutcome } from "./evaluate.ts";
import { createJudgeModelInvoker, createJudgeModelSource } from "./judge-model.ts";
import { createStopVerdictRequester } from "./verdict.ts";
import { formatBudget } from "./guard.ts";

/** notify 级别常量，避免散落裸字符串。 */
const NOTICE_INFO = "info";
const NOTICE_WARNING = "warning";
const NOTICE_ERROR = "error";

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
const CONFIG_ARGUMENTS = ["enable", "disable", "status", "reset"] as const;
const CONFIG_ENABLE_COMMAND = "enable";
const CONFIG_DISABLE_COMMAND = "disable";
const CONFIG_STATUS_COMMAND = "status";
const CONFIG_RESET_COMMAND = "reset";

/** 扩展运行期状态。 */
interface AutoGoalRuntime {
  /** 当前生效配置（改动配置后需要 /reload 重新加载）。 */
  config: AutoGoalConfig;
  /** 本扩展注入的催促消息文本，用于和真实用户输入区分。 */
  injectedUserTexts: Set<string>;
  /** 当前会话 id，切换会话时重置预算。 */
  sessionId: string | undefined;
  /** 当前用户请求已自动干预的次数。 */
  used: number;
  /** 是否有一次判定正在进行，避免并发触发。 */
  inFlight: boolean;
  /** 预算用尽的提示是否已经发过。 */
  budgetNoticeSent: boolean;
}

/** 创建运行期状态。 */
function createRuntime(config: AutoGoalConfig): AutoGoalRuntime {
  return {
    config,
    injectedUserTexts: new Set<string>(),
    sessionId: undefined,
    used: 0,
    inFlight: false,
    budgetNoticeSent: false,
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
  runtime.budgetNoticeSent = false;
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
    i18n.t("configStatusUsed", { value: String(runtime.used) }),
  ].join("\n");
}

/** 保存配置并把结果反馈到 UI；保存失败必须报错而不是静默。 */
function persistConfig(next: AutoGoalConfig, ctx: ExtensionCommandContext): void {
  try {
    const path = saveConfig(next);
    ctx.ui.notify(i18n.t("configCommandSaved", { path }), NOTICE_INFO);
  } catch (error) {
    ctx.ui.notify(i18n.t("configCommandInvalid", { error: errorText(error) }), NOTICE_ERROR);
  }
}

/** 处理交互式菜单选择。 */
async function runConfigMenu(runtime: AutoGoalRuntime, ctx: ExtensionCommandContext): Promise<void> {
  const toggleChoice = i18n.t("configEnabled", {
    value: i18n.t(runtime.config.enabled ? "configOff" : "configOn"),
  });
  const statusChoice = i18n.t("configStatusTitle");
  const doneChoice = i18n.t("configDone");
  const selected = await ctx.ui.select(i18n.t("configMenuTitle"), [toggleChoice, statusChoice, doneChoice]);
  if (selected === undefined || selected === doneChoice) return;
  if (selected === statusChoice) {
    ctx.ui.notify(buildStatusText(runtime), NOTICE_INFO);
    return;
  }
  const enabled = selected === toggleChoice
    ? !runtime.config.enabled
    : runtime.config.enabled;
  persistConfig({ ...runtime.config, enabled }, ctx);
}

/** 处理带参数的配置命令。 */
function runConfigArgument(value: string, runtime: AutoGoalRuntime, ctx: ExtensionCommandContext): void {
  if (value === CONFIG_STATUS_COMMAND) {
    ctx.ui.notify(buildStatusText(runtime), NOTICE_INFO);
    return;
  }
  if (value === CONFIG_RESET_COMMAND) {
    persistConfig({ ...DEFAULT_AUTO_GOAL_CONFIG }, ctx);
    return;
  }
  if (value === CONFIG_ENABLE_COMMAND || value === CONFIG_DISABLE_COMMAND) {
    persistConfig({ ...runtime.config, enabled: value === CONFIG_ENABLE_COMMAND }, ctx);
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
      if (value && !CONFIG_ARGUMENTS.includes(value as (typeof CONFIG_ARGUMENTS)[number])) {
        ctx.ui.notify(i18n.t("configCommandUsage"), NOTICE_WARNING);
        return;
      }
      if (value) {
        runConfigArgument(value, runtime, ctx);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("configCommandInteractiveOnly"), NOTICE_WARNING);
        return;
      }
      await runConfigMenu(runtime, ctx);
    },
  };
  for (const name of CONFIG_COMMAND_ALIASES) pi.registerCommand(name, command);
}

/** 把判定结果落到 UI 与会话：只有 continue 才会真的发消息。 */
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
        pi.sendUserMessage(outcome.message);
      } catch (error) {
        ctx.ui.notify(i18n.t("continueSendFailed", { error: errorText(error) }), NOTICE_ERROR);
        return;
      }
      runtime.used += 1;
      runtime.injectedUserTexts.add(outcome.message.trim());
      ctx.ui.notify(
        i18n.t("autoContinueSent", { reason: outcome.reason, budget: outcome.budget }),
        NOTICE_INFO,
      );
      return;
    }
    case "stop": {
      if (runtime.config.notifyOnStopDecision) {
        ctx.ui.notify(i18n.t("stopDecisionNotified", { reason: outcome.reason }), NOTICE_INFO);
      }
      return;
    }
    case "skipped": {
      if (outcome.code === STOP_SKIP_BUDGET && !runtime.budgetNoticeSent) {
        runtime.budgetNoticeSent = true;
        ctx.ui.notify(i18n.t("budgetExhausted", { budget: outcome.budget }), NOTICE_WARNING);
      }
      return;
    }
    case "failed": {
      ctx.ui.notify(outcome.error, NOTICE_ERROR);
      return;
    }
  }
}

/** 注册停止判定事件。 */
function registerStopJudgement(pi: ExtensionAPI, runtime: AutoGoalRuntime): void {
  // 真实用户输入开启新一轮任务：会话变了就切预算，同一会话内也重置次数。
  // 扩展注入的催促消息不重置，否则自动干预会无限循环。
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    syncSession(runtime, ctx);
    runtime.used = 0;
    runtime.budgetNoticeSent = false;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!runtime.config.enabled) return;
    if (!JUDGE_MODES.has(ctx.mode)) return;
    // 已有判定在跑，或 Pi 还会继续（排队消息 / 其他扩展启动了新一轮）时不介入。
    if (runtime.inFlight) return;
    if (!ctx.isIdle()) return;
    if (ctx.hasPendingMessages()) return;

    syncSession(runtime, ctx);
    const snapshot = collectTurnSnapshot(ctx.sessionManager.getBranch(), {
      maxUserRequestChars: runtime.config.maxUserRequestChars,
      maxFinalOutputChars: runtime.config.maxFinalOutputChars,
      maxToolTraceEntries: runtime.config.maxToolTraceEntries,
      includeToolTrace: runtime.config.includeToolTrace,
      injectedUserTexts: runtime.injectedUserTexts,
    });
    if (!snapshot?.userRequest) return;

    const leafId = ctx.sessionManager.getLeafId();
    runtime.inFlight = true;
    try {
      // 每次判定都从当前上下文取模型与鉴权，避免会话切模型后用到旧配置。
      const judge = createStopVerdictRequester(
        createJudgeModelInvoker({ source: createJudgeModelSource(ctx, runtime.config) }),
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
  const { config, error } = loadInitialConfig();
  const runtime = createRuntime(config);
  registerConfigCommand(pi, runtime);
  registerStopJudgement(pi, runtime);

  if (error !== undefined) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        i18n.t("configLoadFailed", { path: configPath(), error: errorText(error) }),
        NOTICE_WARNING,
      );
    });
  }
}

export { configPath, loadConfig, parseConfig, saveConfig } from "./config.ts";
export type { AutoGoalConfig } from "./config.ts";
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
