import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/** 作为 custom_message.customType 使用，同时也是折叠操作的持久化标识。 */
export const SESSION_SQUASH_TYPE = "session-squash";

/** 上下文阈值提示消息的 customType：建议主 agent 考虑压缩。 */
export const SESSION_SQUASH_HINT_TYPE = "session-squash-hint";

/** 强制压缩任务消息的 customType：要求主 agent 立即压缩。 */
export const SESSION_SQUASH_FORCE_TYPE = "session-squash-force";

const ASSISTANT_ROLE = "assistant";
const NORMAL_STOP_REASON = "stop";

/** Handoff 时间线标题。 */
const HANDOFF_TIMELINE_HEADING = "## Timeline of user and agent work";
const HANDOFF_DEFAULT_TITLE = "# Handoff: Session continuation";
const HANDOFF_TIMELINE_MAX_CHARS = 180;
const HANDOFF_TIMELINE_MAX_ITEMS = 40;
const HANDOFF_TIMELINE_HEAD_ITEMS = 8;

/** 判断最近一条 assistant 消息是否由模型主动正常停止。 */
export function didAgentStopNormally(
  messages: readonly { role?: string; stopReason?: string }[] | undefined,
): boolean {
  if (!messages) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === ASSISTANT_ROLE) {
      return message.stopReason === NORMAL_STOP_REASON;
    }
  }

  return false;
}

/** 阈值类型：绝对 token 值，或相对 contextWindow 的百分比。 */
export type SquashThreshold =
  | { kind: "tokens"; value: number }
  | { kind: "percent"; value: number };

/** 百分比阈值允许的最大值。 */
const PERCENT_THRESHOLD_MAX = 100;

/** 比例换算为百分数时使用的基数。 */
const PERCENTAGE_SCALE = 100;

/** k 后缀换算为 token 数的比例（1k = 1000 token）。 */
const TOKENS_PER_K = 1000;

/**
 * 解析阈值配置：数组元素支持 number（绝对 token 值）、
 * "75%"（百分比字符串）、"150000"（数字字符串）、
 * 或 "150k"/"1.5k"（k 后缀，供斜杠命令与配置使用，k = 1000）。
 * 非法元素跳过；返回空数组表示配置无效，由调用方降级。
 */
export function parseSquashThresholds(input: unknown): SquashThreshold[] {
  if (!Array.isArray(input)) return [];
  const result: SquashThreshold[] = [];
  for (const item of input) {
    if (typeof item === "number" && Number.isFinite(item) && item > 0) {
      result.push({ kind: "tokens", value: Math.floor(item) });
      continue;
    }
    if (typeof item === "string") {
      const trimmed = item.trim().toLowerCase();
      const percentMatch = trimmed.match(/^(\d+(?:\.\d+)?)%$/);
      if (percentMatch) {
        const value = Number.parseFloat(percentMatch[1]);
        if (value > 0 && value <= PERCENT_THRESHOLD_MAX) {
          result.push({ kind: "percent", value });
        }
        continue;
      }
      const kMatch = trimmed.match(/^(\d+(?:\.\d+)?)k$/);
      if (kMatch) {
        const value = Number.parseFloat(kMatch[1]) * TOKENS_PER_K;
        if (Number.isFinite(value) && value > 0) {
          result.push({ kind: "tokens", value: Math.floor(value) });
        }
        continue;
      }
      const numeric = Number.parseFloat(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) {
        result.push({ kind: "tokens", value: Math.floor(numeric) });
      }
    }
  }
  return result;
}

/** 把阈值换算为具体 token 数；percent 需要 contextWindow。 */
export function resolveThresholdTokens(
  threshold: SquashThreshold,
  contextWindow: number,
): number {
  if (threshold.kind === "tokens") return threshold.value;
  return Math.floor((contextWindow * threshold.value) / PERCENTAGE_SCALE);
}

/** 阈值去重/记录用的稳定 key。 */
export function thresholdKey(threshold: SquashThreshold): string {
  return `${threshold.kind}:${threshold.value}`;
}

/** 大数字缩写显示：150000 → "150k"。 */
export function formatTokens(tokens: number): string {
  const THOUSAND = 1000;
  if (tokens >= THOUSAND) {
    const k = tokens / THOUSAND;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(tokens);
}

/** 百分数最多保留一位小数。 */
export function formatPercentage(percentage: number): string {
  return `${Number.isInteger(percentage) ? percentage : percentage.toFixed(1)}%`;
}

/** 上下文用量占 context window 的百分比。 */
export function formatContextPercentage(
  tokens: number,
  contextWindow: number,
): string {
  if (contextWindow <= 0) return "0%";
  return formatPercentage((tokens * PERCENTAGE_SCALE) / contextWindow);
}

/** 阈值序列化为可读字符串（k 单位或百分比），与 parseSquashThresholds 可回环。 */
export function formatThreshold(threshold: SquashThreshold): string {
  if (threshold.kind === "percent") return `${threshold.value}%`;
  return formatTokens(threshold.value);
}

/** 文件操作集合：read=只读、written=写入、edited=编辑。 */
export interface FileOps {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/**
 * 从 session entries 中提取 assistant 工具调用的文件路径。
 * 与 Pi 内置摘要一致：read → 读过、write → 写入、edit → 编辑。
 */
export function extractFileOps(entries: SessionEntry[]): FileOps {
  const fileOps: FileOps = {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  };
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const item = block as {
        type?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (item.type !== "toolCall") continue;
      if (typeof item.name !== "string") continue;
      const args = item.arguments as { path?: unknown } | undefined;
      const path = typeof args?.path === "string" ? args.path : undefined;
      if (!path) continue;
      if (item.name === "read") fileOps.read.add(path);
      else if (item.name === "write") fileOps.written.add(path);
      else if (item.name === "edit") fileOps.edited.add(path);
    }
  }
  return fileOps;
}

/** 计算最终文件列表：modified = written ∪ edited；readFiles = read - modified（排序）。 */
export function computeFileLists(fileOps: FileOps): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.written, ...fileOps.edited]);
  const readFiles = [...fileOps.read]
    .filter((path) => !modified.has(path))
    .sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

/** 把文件列表格式化为 <read-files>/<modified-files> XML 块（与 Pi 内置摘要一致）。 */
export function formatFileOperations(
  readFiles: string[],
  modifiedFiles: string[],
): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

export interface TailCompactionData {
  /** 被保留在新 active branch 中的起始 user entry。 */
  startEntryId: string;
  /** 原始完整后缀所在旧 branch 的 leaf。 */
  sourceLeafId: string;
  fromUserInputIndex: number;
  summary: string;
  tokensBefore: number;
}

export interface UserInputIndex {
  index: number;
  entryId: string;
  content: string;
  complete: boolean;
}

/**
 * 把 user message 内容转为纯文本；image 块用传入的 imagePlaceholder 替代
 * （由调用方经 i18n 提供双语占位文案，保持本模块纯函数可测）。
 */
function messageContentToText(
  content: unknown,
  imagePlaceholder: string,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as { type?: unknown; text?: unknown };
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "image") return imagePlaceholder;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 压缩时间线单项文本，避免用户正文或 Agent 回复撑大快照。 */
function compactTimelineText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= HANDOFF_TIMELINE_MAX_CHARS) return compact;
  return `${compact.slice(0, HANDOFF_TIMELINE_MAX_CHARS - 1)}…`;
}

/** 从 assistant 消息中提取不含参数的工具名，避免把工具载荷复制进快照。 */
function assistantToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return [
    ...new Set(
      content
        .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
        .filter((block) => block.type === "toolCall" && typeof block.name === "string")
        .map((block) => block.name as string),
    ),
  ];
}

/**
 * 生成事实性的紧凑时间线；只复制用户消息和 assistant 的文字/工具名，跳过原始工具结果。
 * 这样即使主 agent 遗漏时间线，用户的后续纠正仍会进入下一份快照。
 */
export function formatConversationTimeline(
  entries: SessionEntry[],
  imagePlaceholder: string,
): string {
  const items: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = messageContentToText(message.content, imagePlaceholder);
      if (text.trim()) items.push(`- User: ${compactTimelineText(text)}`);
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = messageContentToText(message.content, imagePlaceholder);
    const toolNames = assistantToolNames(message.content);
    const activity = toolNames.length > 0
      ? `tools: ${toolNames.join(", ")}`
      : text.trim()
        ? compactTimelineText(text)
        : "";
    if (activity) items.push(`- Agent: ${activity}`);
  }

  if (items.length === 0) {
    return "## Timeline of user and agent work\n- User: No user message was available in the compressed range.\n- Agent: No assistant activity was available in the compressed range.";
  }
  if (items.length <= HANDOFF_TIMELINE_MAX_ITEMS) {
    return `## Timeline of user and agent work\n${items.join("\n")}`;
  }

  const tailCount = HANDOFF_TIMELINE_MAX_ITEMS - HANDOFF_TIMELINE_HEAD_ITEMS - 1;
  const omitted = items.length - HANDOFF_TIMELINE_HEAD_ITEMS - tailCount;
  return [
    "## Timeline of user and agent work",
    ...items.slice(0, HANDOFF_TIMELINE_HEAD_ITEMS),
    `- Agent: ${omitted} earlier timeline entries omitted; verify against the preserved branch if needed.`,
    ...items.slice(-tailCount),
  ].join("\n");
}

/** 如果主 agent 没有写时间线或标题，在快照中补齐紧凑事实时间线和默认标题。 */
export function ensureHandoffTimeline(
  summary: string,
  entries: SessionEntry[],
  imagePlaceholder: string,
): string {
  const trimmed = summary.trim();
  const titleMatch = trimmed.match(/^(# Handoff:[^\r\n]+)(?:\r?\n+)([\s\S]*)$/i);
  const title = titleMatch?.[1] ?? HANDOFF_DEFAULT_TITLE;
  const body = titleMatch?.[2]?.trim() ?? trimmed;
  const hasTimeline = body
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === HANDOFF_TIMELINE_HEADING.toLowerCase());
  if (titleMatch && hasTimeline) return trimmed;
  const bodyWithTimeline = hasTimeline
    ? body
    : `${formatConversationTimeline(entries, imagePlaceholder)}\n\n${body}`;
  return `${title}\n\n${bodyWithTimeline}`;
}


/**
 * 从原始 active branch 中列出 user message。
 * 索引只针对 user message，不包含 assistant/tool/custom entry。
 * imagePlaceholder 由调用方传入（i18n 双语文案），保持本模块纯函数可测。
 */
export function listUserInputs(
  branch: SessionEntry[],
  imagePlaceholder: string,
): UserInputIndex[] {
  const userEntries = branch.filter(
    (entry): entry is SessionMessageEntry =>
      entry.type === "message" && entry.message.role === "user",
  );

  return userEntries.map((entry, index) => {
    const branchIndex = branch.indexOf(entry);
    const hasLaterMessage = branch
      .slice(branchIndex + 1)
      .some(
        (candidate) =>
          candidate.type === "message" || candidate.type === "custom_message",
      );

    return {
      index,
      entryId: entry.id,
      content: messageContentToText(
        "content" in entry.message ? entry.message.content : "",
        imagePlaceholder,
      ),
      complete: hasLaterMessage,
    };
  });
}

/**
 * 列出 session_log 应展示的 active-branch 用户消息。
 * 已作为压缩起点的 user turn 仍是稳定分支锚点，必须允许重复选择，
 * 才能把上次快照之后、下一条 user turn 之前的自动续接内容重新折叠。
 */
export function listSquashCandidates(
  branch: SessionEntry[],
  imagePlaceholder: string,
): UserInputIndex[] {
  return listUserInputs(branch, imagePlaceholder);
}

/** 校验 custom message details 是否包含完整、可用的尾部压缩元数据。 */
function isTailCompactionData(value: unknown): value is TailCompactionData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<TailCompactionData>;
  return (
    typeof data.startEntryId === "string" &&
    typeof data.sourceLeafId === "string" &&
    typeof data.fromUserInputIndex === "number" &&
    typeof data.summary === "string" &&
    typeof data.tokensBefore === "number"
  );
}

/** 从 active branch 中读取已经应用的尾部折叠消息。 */
export function getTailCompactions(branch: SessionEntry[]): Array<{
  entry: SessionEntry;
  data: TailCompactionData;
}> {
  return branch.flatMap((entry) => {
    if (
      entry.type === "custom_message" &&
      entry.customType === SESSION_SQUASH_TYPE &&
      isTailCompactionData(entry.details)
    ) {
      return [{ entry, data: entry.details }];
    }
    return [];
  });
}

/** validateTailStart 失败原因编码常量；文案由调用方经 i18n 渲染。 */
export const TAIL_START_ERROR = {
  inputNotFound: "inputNotFound",
  inputIncomplete: "inputIncomplete",
} as const;

/** validateTailStart 失败原因编码类型。 */
export type TailStartErrorCode =
  (typeof TAIL_START_ERROR)[keyof typeof TAIL_START_ERROR];

/** 校验指定索引存在且对应回合已经完成；允许从更早索引重新压缩。 */
export function validateTailStart(
  inputs: UserInputIndex[],
  from: number,
):
  | { ok: true; input: UserInputIndex }
  | { ok: false; code: TailStartErrorCode; from: number } {
  const input = inputs.find((item) => item.index === from);
  if (!input) {
    return { ok: false, code: TAIL_START_ERROR.inputNotFound, from };
  }
  if (!input.complete) {
    return { ok: false, code: TAIL_START_ERROR.inputIncomplete, from };
  }

  return { ok: true, input };
}
