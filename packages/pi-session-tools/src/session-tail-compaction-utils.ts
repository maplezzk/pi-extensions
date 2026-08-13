import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/** 作为 custom_message.customType 使用，同时也是折叠操作的持久化标识。 */
export const SESSION_SQUASH_TYPE = "session-squash";

/** 内部任务消息的 customType：让主 agent 生成交接文档。 */
export const SESSION_SQUASH_TASK_TYPE = "session-squash-task";

/** 上下文阈值提示消息的 customType：建议主 agent 考虑压缩。 */
export const SESSION_SQUASH_HINT_TYPE = "session-squash-hint";

/** 阈值类型：绝对 token 值，或相对 contextWindow 的百分比。 */
export type SquashThreshold =
  | { kind: "tokens"; value: number }
  | { kind: "percent"; value: number };

/** 百分比阈值允许的最大值。 */
const PERCENT_THRESHOLD_MAX = 100;

/**
 * 解析阈值配置：数组元素支持 number（绝对 token 值）、
 * "75%"（百分比字符串）或 "150000"（数字字符串，供环境变量使用）。
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
      const trimmed = item.trim();
      const percentMatch = trimmed.match(/^(\d+(?:\.\d+)?)%$/);
      if (percentMatch) {
        const value = Number.parseFloat(percentMatch[1]);
        if (value > 0 && value <= PERCENT_THRESHOLD_MAX) {
          result.push({ kind: "percent", value });
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
  return Math.floor((contextWindow * threshold.value) / 100);
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

/** 交接文档目录名（位于系统临时目录下，跨平台，不绑定本机）。 */
const SQUASH_DOC_DIR_NAME = "pi-session-tools";

/** 交接文档文件名前缀。 */
const SQUASH_DOC_FILE_PREFIX = "squash-";

/** 交接文档文件名中 sessionId 与索引之间的分隔符。 */
const SQUASH_DOC_FILE_SEPARATOR = "-from-";

/** sessionId 无法用于命名时的回退标识。 */
const SQUASH_DOC_FILE_FALLBACK = "session";

/** 交接文档扩展名。 */
const SQUASH_DOC_FILE_EXTENSION = ".md";

/** sessionId 用于文件名时的截断长度。 */
const SESSION_ID_SHORT_LENGTH = 8;

/** 交接文档目录：系统临时目录下的 pi-session-tools 子目录（跨平台，不绑定本机）。 */
export function squashDocDir(): string {
  return join(tmpdir(), SQUASH_DOC_DIR_NAME);
}

/** 生成唯一的交接文档路径：squash-<sessionId短>-from-<索引>.md。 */
export function computeSquashDocPath(
  sessionId: string,
  fromUserInputIndex: number,
): string {
  const short =
    sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, SESSION_ID_SHORT_LENGTH) ||
    SQUASH_DOC_FILE_FALLBACK;
  return join(
    squashDocDir(),
    `${SQUASH_DOC_FILE_PREFIX}${short}${SQUASH_DOC_FILE_SEPARATOR}${fromUserInputIndex}${SQUASH_DOC_FILE_EXTENSION}`,
  );
}

/** 判断文档路径是否位于约定的交接文档目录内（finalize 的安全校验）。 */
export function isInsideSquashDocDir(path: string): boolean {
  const resolved = resolve(path);
  return resolved.startsWith(squashDocDir() + sep);
}

export interface SquashTaskPromptInput {
  from: number;
  preview: string;
  docPath: string;
}

/** 用已翻译的模板构造内部任务消息；模板占位符为 {from}/{preview}/{docPath}。 */
export function buildSquashTaskPrompt(
  template: string,
  input: SquashTaskPromptInput,
): string {
  return template
    .replaceAll("{from}", String(input.from))
    .replaceAll("{preview}", input.preview)
    .replaceAll("{docPath}", input.docPath);
}

export interface TailCompactionData {
  /** 被保留在新 active branch 中的起始 user entry。 */
  startEntryId: string;
  /** 原始完整后缀所在旧 branch 的 leaf。 */
  sourceLeafId: string;
  fromUserInputIndex: number;
  summary: string;
  tokensBefore: number;
  /** 主 agent 生成的交接文档路径（可复用/交接）。 */
  docPath?: string;
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
  overlapWithExisting: "overlapWithExisting",
} as const;

/** validateTailStart 失败原因编码类型。 */
export type TailStartErrorCode =
  (typeof TAIL_START_ERROR)[keyof typeof TAIL_START_ERROR];

/**
 * 当前 MVP 只允许在已有尾部折叠之后继续折叠更新的 user turn，
 * 不允许重新覆盖已经折叠的历史范围。
 */
export function validateTailStart(
  inputs: UserInputIndex[],
  from: number,
  branch: SessionEntry[],
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

  const latest = getTailCompactions(branch).at(-1);
  if (latest && from <= latest.data.fromUserInputIndex) {
    return { ok: false, code: TAIL_START_ERROR.overlapWithExisting, from };
  }

  return { ok: true, input };
}
