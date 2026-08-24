/**
 * Session Squash — 在同一个 session tree 中非破坏性压缩当前会话后缀
 *
 * 提供两个 agent 工具：
 * - session_log：列出当前 active branch 的 user turn 和索引
 * - session_squash：接收摘要，从指定 user turn 索引压缩到当前 active leaf
 *
 * 摘要由主 agent 在调用 session_squash 时直接提交，不发起独立 LLM 请求。
 * 工具登记折叠后，当前 agent 结束时完成分支切换，并按 continuation 接续。
 *
 * 折叠不是覆盖当前历史，而是复用 Pi 的 SessionManager.branch：
 * - 原始后缀保留为旧 branch；
 * - 当前 leaf 回到折叠起点，保持 user turn 索引稳定；
 * - summary custom message 成为新的 active branch；
 * - /tree 可以回到原始后缀。
 */

import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { Type } from "typebox";
import {
  computeFileLists,
  didAgentStopNormally,
  extractFileOps,
  formatContextPercentage,
  formatFileOperations,
  formatPercentage,
  formatThreshold,
  formatTokens,
  getTailCompactions,
  listSquashCandidates,
  listUserInputs,
  parseSquashThresholds,
  resolveThresholdTokens,
  SESSION_SQUASH_FORCE_TYPE,
  SESSION_SQUASH_HINT_TYPE,
  SESSION_SQUASH_TYPE,
  TAIL_START_ERROR,
  thresholdKey,
  validateTailStart,
  type SquashThreshold,
  type TailCompactionData,
  type TailStartErrorCode,
} from "./session-tail-compaction-utils.ts";
import { i18n } from "./i18n.ts";

/** validateTailStart 失败码 → i18n key 的映射，集中维护。 */
const TAIL_START_ERROR_I18N_KEY: Record<TailStartErrorCode, string> = {
  [TAIL_START_ERROR.inputNotFound]: "validateInputNotFound",
  [TAIL_START_ERROR.inputIncomplete]: "validateInputIncomplete",
};

const CONTINUATION_AUTO = "auto";
const CONTINUATION_NEXT_USER = "next-user";

type SquashContinuation =
  | typeof CONTINUATION_AUTO
  | typeof CONTINUATION_NEXT_USER;

const TailCompactionParams = Type.Object({
  from: Type.Integer({
    minimum: 0,
    description: i18n.t("squashFromDescription"),
  }),
  summary: Type.String({
    minLength: 1,
    description: i18n.t("squashSummaryDescription"),
  }),
  continuation: Type.Optional(Type.Union([
    Type.Literal(CONTINUATION_AUTO),
    Type.Literal(CONTINUATION_NEXT_USER),
  ], {
    description: i18n.t("squashContinuationDescription"),
  })),
});

/** contextWindow 缺失时的回退值（与 Pi 内置摘要逻辑一致）。 */
const FALLBACK_CONTEXT_WINDOW = 128000;

/** 默认上下文阈值（k 单位，跨平台配置友好）。 */
const DEFAULT_SQUASH_THRESHOLDS: SquashThreshold[] = parseSquashThresholds([
  "150k", "200k", "250k", "300k",
]);

/** 扩展配置文件名（位于 ~/.pi/agent/extensions/<包名>/ 下）。 */
const CONFIG_FILE_NAME = "config.json";

/** 配置中的提醒阈值字段名。 */
const CONFIG_THRESHOLDS_KEY = "squashContextThresholds";

/** 配置中的强制压缩比例字段名；缺失或 null 表示关闭。 */
const CONFIG_FORCE_THRESHOLD_KEY = "forceSquashContextThreshold";

/** 强制压缩比例最小值；0 表示首次获得有效上下文用量后立即触发。 */
const FORCE_SQUASH_RATIO_MIN = 0;

/** 强制压缩比例最大值；1 表示达到完整上下文窗口时触发。 */
const FORCE_SQUASH_RATIO_MAX = 1;

/** 强制压缩期间唯一允许调用的工具。 */
const FORCE_ALLOWED_TOOLS = ["session_log", "session_squash"] as const;

/** 强制压缩工具名集合，供 tool_call 门禁快速判断。 */
const FORCE_ALLOWED_TOOL_SET = new Set<string>(FORCE_ALLOWED_TOOLS);

/** 阈值环境变量（逗号分隔，支持 "150000" 与 "75%"）。 */
const THRESHOLDS_ENV_VAR = "PI_SESSION_TOOLS_SQUASH_THRESHOLDS";

/** 加载期产生的待发送通知（无 ctx，推迟到 session_start flush）。 */
const pendingNotices: Array<{
  text: string;
  level: "info" | "warning" | "error";
}> = [];

/** 已提示过的阈值 key（按 session 隔离，上下文跌回阈值以下自动恢复）。 */
const notifiedThresholds = new Set<string>();

/** 阈值提示状态绑定的 sessionId。 */
let hintSessionId: string | null = null;

/** Pi agent 目录环境变量名（支持重定向 ~/.pi/agent）。 */
const AGENT_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";

/** agent 目录配置中的纯家目录标记。 */
const HOME_DIR_TOKEN = "~";

/** agent 目录配置中的家目录前缀。 */
const HOME_DIR_PREFIX = "~/";

/** 解析 Pi agent 目录：优先 AGENT_DIR_ENV_VAR（支持 HOME_DIR_TOKEN/HOME_DIR_PREFIX 前缀），否则 ~/.pi/agent。 */
function resolveAgentDir(): string {
  const configured = process.env[AGENT_DIR_ENV_VAR];
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === HOME_DIR_TOKEN) return homedir();
  return configured.startsWith(HOME_DIR_PREFIX)
    ? join(homedir(), configured.slice(HOME_DIR_PREFIX.length))
    : configured;
}

/**
 * 加载上下文阈值配置，优先级：配置文件 > 环境变量 > 默认值。
 * 配置存在但解析失败时降级到下一级并记录待发送通知（不静默降级）。
 */
function loadSquashThresholds(): SquashThreshold[] {
  // 优先级：配置文件 > 环境变量 > 默认值
  const configPath = join(
    resolveAgentDir(),
    "extensions",
    "pi-session-tools",
    CONFIG_FILE_NAME,
  );
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      const parsed = parseSquashThresholds(raw[CONFIG_THRESHOLDS_KEY]);
      if (parsed.length > 0) return parsed;
      if (raw[CONFIG_THRESHOLDS_KEY] !== undefined) {
        pendingNotices.push({
          text: i18n.t("configInvalid", { path: configPath }),
          level: "warning",
        });
      }
    }
  } catch {
    pendingNotices.push({
      text: i18n.t("configInvalid", { path: configPath }),
      level: "warning",
    });
  }

  const envValue = process.env[THRESHOLDS_ENV_VAR];
  if (envValue) {
    const parsed = parseSquashThresholds(envValue.split(","));
    if (parsed.length > 0) return parsed;
    pendingNotices.push({
      text: i18n.t("configInvalidEnv", { env: THRESHOLDS_ENV_VAR }),
      level: "warning",
    });
  }

  return DEFAULT_SQUASH_THRESHOLDS;
}

/** 阈值配置文件路径（与 loadSquashThresholds 一致）。 */
function squashConfigPath(): string {
  return join(
    resolveAgentDir(),
    "extensions",
    "pi-session-tools",
    CONFIG_FILE_NAME,
  );
}

/** 判断配置值是否为 0 到 1 的有限数字比例。 */
function isForceSquashRatio(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= FORCE_SQUASH_RATIO_MIN &&
    value <= FORCE_SQUASH_RATIO_MAX
  );
}

/** 加载可选强制压缩比例；缺失或 null 时保持关闭。 */
function loadForceSquashRatio(): number | null {
  const configPath = squashConfigPath();
  try {
    if (!existsSync(configPath)) return null;
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const configured = raw[CONFIG_FORCE_THRESHOLD_KEY];
    if (configured === undefined || configured === null) return null;
    if (isForceSquashRatio(configured)) return configured;
    pendingNotices.push({
      text: i18n.t("forceConfigInvalid", { path: configPath }),
      level: "warning",
    });
  } catch {
    // loadSquashThresholds 已为同一个无效配置文件登记通知，避免重复提示。
  }
  return null;
}

/** 把阈值数组序列化回配置值（k/百分比），供命令展示与写入。 */
function serializeThresholds(thresholds: SquashThreshold[]): string[] {
  return thresholds.map(formatThreshold);
}

/** 读取配置供命令合并写回；损坏文件会在启动通知后由显式保存覆盖。 */
function readSquashConfigForWrite(configPath: string): Record<string, unknown> {
  try {
    if (!existsSync(configPath)) return {};
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** 合并写入配置，避免修改一个阈值时丢失另一个阈值。 */
function writeSquashConfig(values: Record<string, unknown>): string {
  const configPath = squashConfigPath();
  const config = {
    ...readSquashConfigForWrite(configPath),
    ...values,
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

/** 写入提醒阈值配置并刷新运行时状态。 */
function saveSquashThresholds(thresholds: SquashThreshold[]): string {
  const configPath = writeSquashConfig({
    [CONFIG_THRESHOLDS_KEY]: serializeThresholds(thresholds),
  });
  squashThresholds = thresholds;
  return configPath;
}

/** 写入强制压缩比例配置并刷新运行时状态。 */
function saveForceSquashRatio(ratio: number | null): string {
  const configPath = writeSquashConfig({
    [CONFIG_FORCE_THRESHOLD_KEY]: ratio,
  });
  forceSquashRatio = ratio;
  return configPath;
}

/** 当前生效的提醒阈值配置（命令修改后重新加载）。 */
let squashThresholds: SquashThreshold[] = loadSquashThresholds();

/** 当前生效的强制压缩比例；默认关闭。 */
let forceSquashRatio: number | null = loadForceSquashRatio();

type PendingTailCompaction = {
  sessionId: string;
  startEntryId: string;
  fromUserInputIndex: number;
  summary: string;
  continuation: SquashContinuation;
};

type ForceSquashState = {
  sessionId: string;
  previousActiveTools: string[];
  tokens: number;
  threshold: number;
  attempt: number;
};

let pending: PendingTailCompaction | null = null;

/** 构造 Pi 工具的纯文本结果，并按需标记业务错误。 */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
    details: {},
  };
}

/** 注册会话日志、尾部压缩工具及其生命周期处理器。 */
export default function contextFoldExtension(pi: ExtensionAPI) {
  let latestAgentRunStoppedNormally = false;
  let forceState: ForceSquashState | null = null;

  /** 退出强制模式并恢复进入前的活动工具集合。 */
  function restoreToolsAfterForce(): void {
    if (!forceState) return;
    pi.setActiveTools(forceState.previousActiveTools);
    forceState = null;
  }

  /** 在 agent 已停止后投递强制压缩任务；未压缩时会再次调用。 */
  function triggerForcedSquashTurn(): void {
    if (!forceState) return;
    forceState.attempt += 1;
    pi.sendMessage(
      {
        customType: SESSION_SQUASH_FORCE_TYPE,
        content: [
          {
            type: "text",
            text: i18n.t("forceTaskPrompt", {
              tokens: formatTokens(forceState.tokens),
              threshold: formatTokens(forceState.threshold),
              attempt: forceState.attempt,
            }),
          },
        ],
        display: false,
        details: {
          tokens: forceState.tokens,
          threshold: forceState.threshold,
          attempt: forceState.attempt,
        },
      },
      { triggerTurn: true },
    );
  }

  /** 达到强制阈值时限制工具，并在当前工具批结束处中止 agent。 */
  function enterForceMode(
    ctx: ExtensionContext,
    tokens: number,
    threshold: number,
  ): void {
    forceState = {
      sessionId: ctx.sessionManager.getSessionId(),
      previousActiveTools: pi.getActiveTools(),
      tokens,
      threshold,
      attempt: 0,
    };
    pi.setActiveTools([...FORCE_ALLOWED_TOOLS]);
    ctx.ui.notify(
      i18n.t("forceInterruptNotice", {
        tokens: formatTokens(tokens),
        threshold: formatTokens(threshold),
      }),
      "warning",
    );
    ctx.abort();
  }

  pi.registerTool({
    name: "session_log",
    label: i18n.t("logLabel"),
    description: i18n.t("logDescription"),
    promptSnippet: i18n.t("logSnippet"),
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      const inputs = listSquashCandidates(
        branch,
        i18n.t("imagePlaceholder"),
      );

      return textResult(
        JSON.stringify(
          {
            sessionId: ctx.sessionManager.getSessionId(),
            leafId: ctx.sessionManager.getLeafId(),
            inputs: inputs.map((input) => ({
              index: input.index,
              content: input.content,
              complete: input.complete,
              canStartFold: input.complete,
            })),
          },
          null,
          2,
        ),
      );
    },
  });

  pi.registerTool({
    name: "session_squash",
    label: i18n.t("squashLabel"),
    description: i18n.t("squashDescription"),
    promptGuidelines: [
      i18n.t("guidelineBoundary"),
      i18n.t("guidelineIndex"),
      i18n.t("guidelineSummary"),
      i18n.t("guidelineSummaryIntegrity"),
      i18n.t("guidelineLeaf"),
      i18n.t("guidelineContinue"),
    ],
    parameters: TailCompactionParams,
    /** 校验并登记压缩请求；实际分支切换在 agent_settled 后执行。 */
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      const inputs = listUserInputs(branch, i18n.t("imagePlaceholder"));
      const validation = validateTailStart(inputs, params.from);

      if (validation.ok === false) {
        return textResult(
          i18n.t(TAIL_START_ERROR_I18N_KEY[validation.code], {
            from: validation.from,
          }),
          true,
        );
      }
      if (pending) {
        return textResult(
          i18n.t("pending"),
          true,
        );
      }

      const summary = params.summary.trim();
      if (!summary) {
        return textResult(i18n.t("squashSummaryEmpty"), true);
      }

      pending = {
        sessionId: ctx.sessionManager.getSessionId(),
        startEntryId: validation.input.entryId,
        fromUserInputIndex: params.from,
        summary,
        continuation: params.continuation ?? CONTINUATION_AUTO,
      };

      return {
        ...textResult(i18n.t("registered", { from: params.from })),
        // 先结束旧分支上的 agent run，agent_settled 才能立即切分支并注入摘要。
        terminate: true,
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (!forceState || FORCE_ALLOWED_TOOL_SET.has(event.toolName)) return;
    return {
      block: true,
      terminate: true,
      reason: i18n.t("forceToolBlocked", { tool: event.toolName }),
    };
  });

  pi.on("turn_end", (_event, ctx) => {
    if (forceSquashRatio === null || forceState || pending) return;
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    if (tokens <= 0) return;
    const contextWindow = ctx.model?.contextWindow || FALLBACK_CONTEXT_WINDOW;
    const threshold = Math.floor(contextWindow * forceSquashRatio);
    if (tokens < threshold) return;
    enterForceMode(ctx, tokens, threshold);
  });

  pi.on("agent_end", (event) => {
    latestAgentRunStoppedNormally = didAgentStopNormally(event.messages);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const shouldCheckContextThreshold = latestAgentRunStoppedNormally;
    latestAgentRunStoppedNormally = false;

    if (!pending) {
      if (forceState) {
        if (forceState.sessionId !== ctx.sessionManager.getSessionId()) {
          restoreToolsAfterForce();
          ctx.ui.notify(i18n.t("forceSwitched"), "warning");
          return;
        }
        triggerForcedSquashTurn();
        return;
      }
      if (shouldCheckContextThreshold) checkContextThreshold(pi, ctx);
      return;
    }

    if (pending.sessionId !== ctx.sessionManager.getSessionId()) {
      pending = null;
      restoreToolsAfterForce();
      ctx.ui.notify(i18n.t("switched"), "warning");
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const inputs = listUserInputs(branch, i18n.t("imagePlaceholder"));
    const input = inputs.find((item) => item.entryId === pending.startEntryId);
    if (!input || !input.complete) {
      pending = null;
      throw new Error(i18n.t("noInput"));
    }

    const sourceLeafId = ctx.sessionManager.getLeafId();
    if (!sourceLeafId) {
      pending = null;
      throw new Error(i18n.t("noLeaf"));
    }

    const request = pending;
    const startIdx = branch.findIndex(
      (entry) => entry.id === request.startEntryId,
    );
    const startEntry = branch[startIdx];
    if (!startEntry) {
      pending = null;
      throw new Error(i18n.t("noInput"));
    }
    const suffix = branch.slice(startIdx);
    const { readFiles, modifiedFiles } = computeFileLists(
      extractFileOps(suffix),
    );
    const taskState =
      request.summary + formatFileOperations(readFiles, modifiedFiles);
    const summary = `${i18n.t("continuationInstruction")}\n\n${taskState}`;
    const data: TailCompactionData = {
      startEntryId: request.startEntryId,
      sourceLeafId,
      fromUserInputIndex: request.fromUserInputIndex,
      summary,
      tokensBefore: ctx.getContextUsage()?.tokens ?? 0,
    };

    try {
      // 起始 user turn 作为新分支锚点保留，确保后续 session_log 索引稳定；
      // continuation=next-user 会阻止已完成任务立即重答这条旧 prompt。
      const sessionManager =
        ctx.sessionManager as unknown as SessionManager;
      sessionManager.branch(request.startEntryId);

      // sendMessage 同时把 summary 追加到 AgentSession 内存和当前新 leaf。
      // 已完成且等待用户的新阶段只保存快照，不额外触发一轮旧任务回复。
      restoreToolsAfterForce();
      pi.sendMessage(
        {
          customType: SESSION_SQUASH_TYPE,
          content: summary,
          display: true,
          details: data,
        },
        { triggerTurn: request.continuation === CONTINUATION_AUTO },
      );
      pending = null;
    } catch (error) {
      pending = null;
      throw new Error(i18n.t("branchFailed", { error: String(error) }));
    }

    ctx.ui.notify(
      i18n.t("done", {
        from: request.fromUserInputIndex,
      }),
      "info",
    );
  });

  pi.on("session_shutdown", () => {
    restoreToolsAfterForce();
  });

  // branch() 发生在 agent_settled 事件中，Pi 的 AgentSession 内存消息仍可能
  // 保留旧分支。下一次 provider 请求前，以当前 active branch 重建 context，
  // 确保模型和 /tree 看到同一条新分支。
  pi.on("context", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    if (getTailCompactions(branch).length === 0) return;

    return {
      messages: ctx.sessionManager
        .buildContextEntries()
        .flatMap(sessionEntryToContextMessages),
    };
  });

  // 加载期通知（如配置解析失败）延迟到首个 session 开始时统一发送。
  pi.on("session_start", async (_event, ctx) => {
    for (const notice of pendingNotices.splice(0)) {
      ctx.ui.notify(notice.text, notice.level);
    }
  });

  for (const name of CONFIG_COMMAND_NAMES) {
    pi.registerCommand(name, {
      description: i18n.t("configCommandDescription"),
      handler: (args, ctx) =>
        handleConfigCommand(args, ctx, restoreToolsAfterForce),
    });
  }
}

/** 配置命令的注册名（双命名，对齐其他公开插件）。 */
const CONFIG_COMMAND_NAMES = [
  "config:session-tools",
  "pi-session-tools",
] as const;

/** 强制阈值配置子命令。 */
const FORCE_CONFIG_COMMAND = "force";

/** 关闭强制阈值时接受的值。 */
const FORCE_CONFIG_DISABLED_VALUES = new Set(["off", "none", "disabled"]);

/** 配置命令：交互式设置压缩阈值（支持 k / 百分比 / 数字）。
 * 带参数时直接保存并返回；无参数时展示当前值并弹输入框。 */
async function handleConfigCommand(
  args: string,
  ctx: ExtensionCommandContext,
  onForceDisabled: () => void,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(i18n.t("configNoUi"), "warning");
    return;
  }
  const requested = args.trim();
  if (requested) {
    const [command, ...commandArgs] = requested.split(/\s+/);
    if (command.toLowerCase() === FORCE_CONFIG_COMMAND) {
      const forceValue = commandArgs.join(" ").trim().toLowerCase();
      if (!forceValue) {
        ctx.ui.notify(i18n.t("configForceUsage"), "error");
        return;
      }
      if (FORCE_CONFIG_DISABLED_VALUES.has(forceValue)) {
        const configPath = saveForceSquashRatio(null);
        onForceDisabled();
        ctx.ui.notify(
          i18n.t("configForceDisabled", { path: configPath }),
          "info",
        );
        return;
      }
      const forceRatio = Number(forceValue);
      if (!isForceSquashRatio(forceRatio)) {
        ctx.ui.notify(
          i18n.t("configForceParseError", { value: forceValue }),
          "error",
        );
        return;
      }
      const configPath = saveForceSquashRatio(forceRatio);
      ctx.ui.notify(
        i18n.t("configForceSaved", {
          ratio: forceRatio,
          path: configPath,
        }),
        "info",
      );
      return;
    }

    const parsed = parseSquashThresholds(requested.split(","));
    if (parsed.length === 0) {
      ctx.ui.notify(i18n.t("configParseError", { value: requested }), "error");
      return;
    }
    const configPath = saveSquashThresholds(parsed);
    ctx.ui.notify(
      i18n.t("configSaved", {
        thresholds: serializeThresholds(parsed).join(", "),
        path: configPath,
      }),
      "info",
    );
    return;
  }
  const current = serializeThresholds(squashThresholds).join(", ");
  const value = await ctx.ui.input(
    i18n.t("configPrompt", { current }),
    current,
  );
  if (value === undefined) return;
  const parsed = parseSquashThresholds(value.split(","));
  if (parsed.length === 0) {
    ctx.ui.notify(i18n.t("configParseError", { value }), "error");
    return;
  }
  const configPath = saveSquashThresholds(parsed);
  ctx.ui.notify(
    i18n.t("configSaved", {
      thresholds: serializeThresholds(parsed).join(", "),
      path: configPath,
    }),
    "info",
  );
}

/** 阈值提示消息的投递模式：agent 停止后立即投递（followUp）并触发下一轮（triggerTurn）。 */
const HINT_DELIVER_MODE = "followUp" as const;

/**
 * 上下文阈值提示：agent 主动正常停止且无压缩任务时，若上下文跨过未提示过的阈值，
 * 注入一条 followUp 消息建议主 agent 考虑 session_squash（停止后立即触发）。
 * 上下文跌回阈值以下（如压缩后）自动恢复该档位的可提示状态。
 */
function checkContextThreshold(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
): void {
  const usage = ctx.getContextUsage();
  const tokens = usage?.tokens ?? 0;
  if (tokens <= 0) return;

  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionId !== hintSessionId) {
    notifiedThresholds.clear();
    hintSessionId = sessionId;
  }

  const contextWindow = usage?.contextWindow ||
    ctx.model?.contextWindow ||
    FALLBACK_CONTEXT_WINDOW;
  let candidate: { key: string; resolved: number } | null = null;
  for (const threshold of squashThresholds) {
    const resolved = resolveThresholdTokens(threshold, contextWindow);
    const key = thresholdKey(threshold);
    if (tokens < resolved) {
      // 上下文跌回该档位以下：恢复可提示状态
      notifiedThresholds.delete(key);
      continue;
    }
    if (notifiedThresholds.has(key)) continue;
    if (!candidate || resolved > candidate.resolved) {
      candidate = { key, resolved };
    }
  }
  if (!candidate) return;
  notifiedThresholds.add(candidate.key);

  const tokensText = formatTokens(tokens);
  const contextWindowText = formatTokens(contextWindow);
  const measuredPercentage = usage?.percent;
  const contextPercentage =
    measuredPercentage === null || measuredPercentage === undefined
      ? formatContextPercentage(tokens, contextWindow)
      : formatPercentage(measuredPercentage);
  const thresholdText = formatTokens(candidate.resolved);
  ctx.ui.notify(
    i18n.t("contextHintNotice", {
      tokens: tokensText,
      contextWindow: contextWindowText,
      contextPercentage,
      threshold: thresholdText,
    }),
    "info",
  );
  // 停止后立即投递并触发下一轮，让主 agent 立即评估是否压缩（不排队等下次用户输入）。
  pi.sendMessage(
    {
      customType: SESSION_SQUASH_HINT_TYPE,
      content: [
        {
          type: "text",
          text: i18n.t("contextHint", {
            tokens: tokensText,
            contextWindow: contextWindowText,
            contextPercentage,
            threshold: thresholdText,
          }),
        },
      ],
      display: false,
      details: { tokens, threshold: candidate.resolved },
    },
    { deliverAs: HINT_DELIVER_MODE, triggerTurn: true },
  );
}
