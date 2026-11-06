/**
 * 从当前会话分支中提取「本轮用户请求 + 用户回答 + agent 停止前最后的输出 + 工具调用轨迹」。
 *
 * 只做读取与结构解析，不做模型调用，便于用固定 session 数据做确定性测试。
 */

/** 工具调用参数摘要的字符上限，避免 edit/write 全文挤占判定上下文。 */
const TOOL_ARGUMENT_CHARS = 160;
/** 工具轨迹单行前缀，保持判定提示词里的人类可读性。 */
const TOOL_TRACE_PREFIX = "- ";
/** 工具结果条目在会话里的角色名。 */
const TOOL_RESULT_ROLE = "toolResult";
/**
 * 向用户提问的工具名。
 * 这些工具的返回值是用户当场输入的回答，在会话里却是 toolResult 而不是 user 消息，
 * 单独收集出来交给判定模型，否则判定看不到用户已经改过范围 / 要求停下。
 */
const USER_ANSWER_TOOL_NAMES: ReadonlySet<string> = new Set(["ask_user_question"]);

/** 会话条目中与本次提取相关的最小结构。 */
type EntryLike = {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
    /** 工具结果条目上的工具名，用来识别提问类工具。 */
    toolName?: unknown;
  };
};

/** 文本内容块结构。 */
type TextContentLike = { type?: unknown; text?: unknown };

/** 工具调用内容块结构。 */
type ToolCallLike = { type?: unknown; name?: unknown; arguments?: unknown };

/** 提取本轮快照时可调参数。 */
export interface TurnSnapshotOptions {
  /** 用户请求截断长度。 */
  maxUserRequestChars: number;
  /** agent 最后输出截断长度。 */
  maxFinalOutputChars: number;
  /** 工具轨迹最多保留条数。 */
  maxToolTraceEntries: number;
  /** 是否收集工具轨迹。 */
  includeToolTrace: boolean;
  /** 单条用户回答的截断长度。 */
  maxUserAnswerChars: number;
}

/** 判定模型需要的本轮上下文。 */
export interface TurnSnapshot {
  /** 用户本轮的原始请求（已截断）。 */
  userRequest: string;
  /**
   * 本轮 agent 提问后用户给出的回答（原文，已截断）。
   * 内容是用户当场输入的决策，和原始请求同等重要。
   */
  userAnswers: string[];
  /** agent 停止前最后一段可见输出（已截断）。 */
  finalOutput: string;
  /** 本轮工具调用摘要行。 */
  toolTrace: string[];
  /**
   * 本轮是否根本没收集工具轨迹（`includeToolTrace` 关闭）。
   * 与「收集了但本轮确实没有工具调用」区分开，避免提示词里把「没拿到轨迹」
   * 说成「没有工具调用」。
   */
  toolTraceOmitted?: boolean;
}

/** 把字符串或内容块数组统一转成纯文本。 */
export function getTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is TextContentLike & { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as TextContentLike).type === "text" &&
        typeof (part as TextContentLike).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * 取出内容块里的工具调用，忽略其它块类型。
 * 返回顺序与消息中书写顺序一致，调用方负责截断。
 */
function getToolCalls(content: unknown): ToolCallLike[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is ToolCallLike =>
      typeof part === "object" &&
      part !== null &&
      (part as ToolCallLike).type === "toolCall" &&
      typeof (part as ToolCallLike).name === "string",
  );
}

/** 按字符数截断文本，并标记被截断的事实。 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[已截断 ${text.length - maxChars} 字符]`;
}

/** 把工具参数压成单行摘要。 */
function summarizeToolArguments(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    serialized = "[无法序列化的参数]";
  }
  if (serialized === "{}") return "";
  return serialized.length > TOOL_ARGUMENT_CHARS
    ? `${serialized.slice(0, TOOL_ARGUMENT_CHARS)}…`
    : serialized;
}

/** 判断条目是否为带指定角色的消息。 */
function isMessageEntry(entry: EntryLike, role: string): boolean {
  return entry.type === "message" && entry.message?.role === role;
}

/**
 * 从分支尾部反向查找最后一条真实用户消息的下标，找不到返回 -1。
 * 扩展注入的催促是 custom 角色的消息，不是 user，因此天然不会被当成用户请求。
 */
function findLastUserIndex(entries: readonly EntryLike[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isMessageEntry(entry, "user")) continue;
    const text = getTextContent(entry.message?.content).trim();
    if (!text) continue;
    return index;
  }
  return -1;
}

/**
 * 运行被取消的结束原因。
 * 用户按 Esc 打断、或会话被中断时，最后一条 assistant 消息都是这个原因。
 */
export const STOP_REASON_ABORTED = "aborted";

/**
 * 读取最后一条 assistant 消息的结束原因。
 * 调用方用它区分「agent 自己决定停下」与「这一轮被取消」：
 * 被取消的轮次不是 agent 的停止决定，不能当成提前停止去催。
 */
export function readLastAssistantStopReason(entries: readonly EntryLike[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isMessageEntry(entry, "assistant")) continue;
    const stopReason = entry.message?.stopReason;
    return typeof stopReason === "string" ? stopReason : undefined;
  }
  return undefined;
}

/**
 * 收集本轮里由提问工具带回来的用户回答。
 * 只取最后一条真实用户消息之后的工具结果，避免把上一轮的提问当成这一轮的上下文。
 */
function collectUserAnswers(
  entries: readonly EntryLike[],
  fromIndex: number,
  maxChars: number,
): string[] {
  const answers: string[] = [];
  for (let index = fromIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isMessageEntry(entry, TOOL_RESULT_ROLE)) continue;
    const toolName = entry.message?.toolName;
    if (typeof toolName !== "string" || !USER_ANSWER_TOOL_NAMES.has(toolName)) continue;
    const text = getTextContent(entry.message?.content).trim();
    if (!text) continue;
    answers.push(truncateText(text, maxChars));
  }
  return answers;
}

/** 在给定下标之后查找最后一段 assistant 文本输出。 */
function findFinalAssistantOutput(entries: readonly EntryLike[], fromIndex: number): string {
  for (let index = entries.length - 1; index > fromIndex; index -= 1) {
    const entry = entries[index];
    if (!isMessageEntry(entry, "assistant")) continue;
    const text = getTextContent(entry.message?.content).trim();
    if (text) return text;
  }
  return "";
}

/** 收集下标之后的工具调用摘要行，只保留最后 N 条。 */
function collectToolTrace(entries: readonly EntryLike[], fromIndex: number, limit: number): string[] {
  if (limit <= 0) return [];
  const lines: string[] = [];
  for (let index = fromIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isMessageEntry(entry, "assistant")) continue;
    for (const call of getToolCalls(entry.message?.content)) {
      const args = summarizeToolArguments(call.arguments);
      lines.push(`${TOOL_TRACE_PREFIX}${String(call.name)}${args ? ` ${args}` : ""}`);
    }
  }
  return lines.slice(-limit);
}

/**
 * 提取本轮快照。
 * 找不到真实用户消息时返回 undefined，调用方应跳过判定而不是猜测任务目标。
 */
export function collectTurnSnapshot(
  entries: readonly EntryLike[],
  options: TurnSnapshotOptions,
): TurnSnapshot | undefined {
  const lastUserIndex = findLastUserIndex(entries);
  if (lastUserIndex < 0) return undefined;

  const userRequest = truncateText(
    getTextContent(entries[lastUserIndex].message?.content).trim(),
    options.maxUserRequestChars,
  );
  const finalOutput = truncateText(
    findFinalAssistantOutput(entries, lastUserIndex),
    options.maxFinalOutputChars,
  );

  return {
    userRequest,
    userAnswers: collectUserAnswers(entries, lastUserIndex, options.maxUserAnswerChars),
    finalOutput,
    toolTrace: options.includeToolTrace
      ? collectToolTrace(entries, lastUserIndex, options.maxToolTraceEntries)
      : [],
    toolTraceOmitted: !options.includeToolTrace,
  };
}
