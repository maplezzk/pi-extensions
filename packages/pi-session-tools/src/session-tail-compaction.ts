/**
 * Session Squash — 在同一个 session tree 中非破坏性压缩当前会话后缀
 *
 * 提供三个 agent 工具：
 * - session_log：列出当前 active branch 的 user turn 和索引
 * - session_squash：从指定 user turn 索引开始，压缩到当前 active leaf
 * - session_squash_finalize：内部任务专用，主 agent 写入交接文档后提交路径
 *
 * 摘要生成不使用独立 LLM 请求，而是复用主 agent 自身：折叠登记后，
 * 注入一条内部任务消息（triggerTurn）让主 agent 用完整上下文（天然命中
 * 前缀缓存）写一份交接文档到系统临时目录，再通过 finalize 工具提交；
 * 下一个 agent_settled 时读取文档全文作为摘要完成折叠。失败兜底：主
 * agent 未提交则放弃并通知，可再次调用重试。
 *
 * 折叠不是覆盖当前历史，而是复用 Pi 的 SessionManager.branch：
 * - 原始后缀保留为旧 branch；
 * - 当前 leaf 回到折叠起点；
 * - summary custom message 成为新的 active branch；
 * - /tree 可以回到原始后缀。
 */

import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { Type } from "typebox";
import {
  buildSquashTaskPrompt,
  computeFileLists,
  didAgentStopNormally,
  extractFileOps,
  formatFileOperations,
  formatThreshold,
  formatTokens,
  getTailCompactions,
  listUserInputs,
  parseSquashThresholds,
  resolveThresholdTokens,
  SESSION_SQUASH_HINT_TYPE,
  SESSION_SQUASH_TASK_TYPE,
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
  [TAIL_START_ERROR.overlapWithExisting]: "validateOverlap",
};

const TailCompactionParams = Type.Object({
  from: Type.Integer({
    minimum: 0,
    description: i18n.t("squashFromDescription"),
  }),
});

/** 任务消息中用户消息预览的最大字符数。 */
const USER_MESSAGE_PREVIEW_MAX_CHARS = 120;

/** 编辑器上方进度提示的 widget key。 */
const PROGRESS_WIDGET_KEY = "session-squash-progress";

/** contextWindow 缺失时的回退值（与 Pi 内置摘要逻辑一致）。 */
const FALLBACK_CONTEXT_WINDOW = 128000;

/** 默认上下文阈值（k 单位，跨平台配置友好）。 */
const DEFAULT_SQUASH_THRESHOLDS: SquashThreshold[] = parseSquashThresholds([
  "150k", "200k", "250k", "300k",
]);

/** 扩展配置文件名（位于 ~/.pi/agent/extensions/<包名>/ 下）。 */
const CONFIG_FILE_NAME = "config.json";

/** 配置中的阈值字段名。 */
const CONFIG_THRESHOLDS_KEY = "squashContextThresholds";

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

/** 把阈值数组序列化回配置值（k/百分比），供命令展示与写入。 */
function serializeThresholds(thresholds: SquashThreshold[]): string[] {
  return thresholds.map(formatThreshold);
}

/** 写入阈值配置并刷新运行时状态。 */
function saveSquashThresholds(thresholds: SquashThreshold[]): string {
  const configPath = squashConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      { [CONFIG_THRESHOLDS_KEY]: serializeThresholds(thresholds) },
      null,
      2,
    )}\n`,
    "utf8",
  );
  squashThresholds = thresholds;
  return configPath;
}

/** 当前生效的阈值配置（命令修改后重新加载）。 */
let squashThresholds: SquashThreshold[] = loadSquashThresholds();

const FinalizeParams = Type.Object({
  summary: Type.String({
    description: i18n.t("finalizeSummaryDescription"),
  }),
});

type PendingStage = "registered" | "taskInjected";

type PendingTailCompaction = {
  sessionId: string;
  startEntryId: string;
  fromUserInputIndex: number;
  stage: PendingStage;
  summary?: string;
  /** 自动提取的文件清单（<read-files>/<modified-files>），finalize 时追加到 summary 尾部。 */
  fileSection: string;
};

let pending: PendingTailCompaction | null = null;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
    details: {},
  };
}

export default function contextFoldExtension(pi: ExtensionAPI) {
  let latestAgentRunStoppedNormally = false;

  pi.registerTool({
    name: "session_log",
    label: i18n.t("logLabel"),
    description: i18n.t("logDescription"),
    promptSnippet: i18n.t("logSnippet"),
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      const inputs = listUserInputs(branch, i18n.t("imagePlaceholder"));
      const existing = getTailCompactions(branch);
      const latest = existing.at(-1)?.data;

      return textResult(
        JSON.stringify(
          {
            sessionId: ctx.sessionManager.getSessionId(),
            leafId: ctx.sessionManager.getLeafId(),
            inputs: inputs.map((input) => ({
              index: input.index,
              content: input.content,
              complete: input.complete,
              canStartFold:
                input.complete &&
                (!latest || input.index > latest.fromUserInputIndex),
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
      i18n.t("guidelineLeaf"),
      i18n.t("guidelineContinue"),
    ],
    parameters: TailCompactionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      const inputs = listUserInputs(branch, i18n.t("imagePlaceholder"));
      const validation = validateTailStart(inputs, params.from, branch);

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

      pending = {
        sessionId: ctx.sessionManager.getSessionId(),
        startEntryId: validation.input.entryId,
        fromUserInputIndex: params.from,
        stage: "registered",
        fileSection: "",
      };

      return textResult(
        i18n.t("registered", { from: params.from }),
      );
    },
  });

  pi.registerTool({
    name: "session_squash_finalize",
    label: i18n.t("finalizeLabel"),
    description: i18n.t("finalizeDescription"),
    promptSnippet: i18n.t("finalizeSnippet"),
    parameters: FinalizeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!pending) {
        return textResult(i18n.t("finalizeNoPending"), true);
      }
      if (pending.stage !== "taskInjected") {
        return textResult(i18n.t("finalizeNotTask"), true);
      }

      const summary = params.summary.trim();
      if (!summary) {
        return textResult(i18n.t("finalizeEmpty"), true);
      }

      pending.summary = summary + pending.fileSection;
      return textResult(
        i18n.t("finalizeOk", { chars: summary.length }),
      );
    },
  });

  pi.on("agent_end", (event) => {
    latestAgentRunStoppedNormally = didAgentStopNormally(event.messages);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const shouldCheckContextThreshold = latestAgentRunStoppedNormally;
    latestAgentRunStoppedNormally = false;

    if (!pending) {
      if (shouldCheckContextThreshold) checkContextThreshold(pi, ctx);
      return;
    }

    if (pending.sessionId !== ctx.sessionManager.getSessionId()) {
      pending = null;
      ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
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

    if (pending.stage === "registered") {
      // 阶段 1：注入内部任务消息，让主 agent 用完整上下文产出总结全文；
      // 同时自动提取被压缩段的文件清单，稍后在 finalize 时追加到 summary。
      const startIdx = branch.findIndex(
        (entry) => entry.id === pending.startEntryId,
      );
      const suffix = startIdx >= 0 ? branch.slice(startIdx) : branch;
      const { readFiles, modifiedFiles } = computeFileLists(
        extractFileOps(suffix),
      );
      pending.fileSection = formatFileOperations(readFiles, modifiedFiles);
      pending.stage = "taskInjected";

      const preview =
        (input.content || "").slice(0, USER_MESSAGE_PREVIEW_MAX_CHARS) ||
        i18n.t("imagePlaceholder");
      const taskText = buildSquashTaskPrompt(i18n.t("taskPrompt"), {
        preview,
      });

      // 进度提示放在编辑器（消息框）上方，而不是 footer status
      ctx.ui.setWidget(PROGRESS_WIDGET_KEY, [i18n.t("generatingDoc")]);
      pi.sendMessage(
        {
          customType: SESSION_SQUASH_TASK_TYPE,
          content: [{ type: "text", text: taskText }],
          display: false,
          details: {
            fromUserInputIndex: pending.fromUserInputIndex,
          },
        },
        { triggerTurn: true },
      );
      return;
    }

    // 阶段 2：主 agent 任务轮结束。
    ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
    if (!pending.summary) {
      // 主 agent 未通过 finalize 提交文档：放弃并通知，可再次调用重试。
      pending = null;
      ctx.ui.notify(i18n.t("abandoned"), "warning");
      return;
    }

    const sourceLeafId = ctx.sessionManager.getLeafId();
    if (!sourceLeafId) {
      pending = null;
      throw new Error(i18n.t("noLeaf"));
    }

    const request = pending;
    const data: TailCompactionData = {
      startEntryId: request.startEntryId,
      sourceLeafId,
      fromUserInputIndex: request.fromUserInputIndex,
      summary: request.summary,
      tokensBefore: ctx.getContextUsage()?.tokens ?? 0,
    };

    try {
      // ExtensionContext 暴露的是只读类型，但底层对象就是 Pi 的
      // SessionManager。这里复用它公开的 branch()，保持同一个 JSONL tree。
      const sessionManager =
        ctx.sessionManager as unknown as SessionManager;
      sessionManager.branch(request.startEntryId);

      // branch() 只改变持久化 tree 的 leaf；sendMessage 同时把 summary
      // 追加到 AgentSession 的内存消息和当前新 leaf，避免下一轮仍使用旧后缀。
      // 压缩完成后固定自动继续一轮，主 agent 基于交接文档摘要继续工作。
      pi.sendMessage(
        {
          customType: SESSION_SQUASH_TYPE,
          content: request.summary,
          display: true,
          details: data,
        },
        { triggerTurn: true },
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
      handler: handleConfigCommand,
    });
  }
}

/** 配置命令的注册名（双命名，对齐其他公开插件）。 */
const CONFIG_COMMAND_NAMES = [
  "config:session-tools",
  "pi-session-tools",
] as const;

/** 配置命令：交互式设置压缩阈值（支持 k / 百分比 / 数字）。
 * 带参数时直接保存并返回；无参数时展示当前值并弹输入框。 */
async function handleConfigCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(i18n.t("configNoUi"), "warning");
    return;
  }
  const requested = args.trim();
  if (requested) {
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
  const tokens = ctx.getContextUsage()?.tokens ?? 0;
  if (tokens <= 0) return;

  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionId !== hintSessionId) {
    notifiedThresholds.clear();
    hintSessionId = sessionId;
  }

  const contextWindow = ctx.model?.contextWindow || FALLBACK_CONTEXT_WINDOW;
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
  const thresholdText = formatTokens(candidate.resolved);
  ctx.ui.notify(
    i18n.t("contextHintNotice", {
      tokens: tokensText,
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
