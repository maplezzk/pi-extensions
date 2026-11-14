import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createModelRequester } from "pi-model-request";
import { basename } from "node:path";
import { i18n } from "./i18n.ts";
import { DEFAULT_TITLE_CONFIG, type TitleConfig } from "./config.ts";

/** 生成标题所需的最小 session 上下文；终端消费者可复用该契约。 */
export type SessionNameContext = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">;

/** 可注入的标题 completion，便于终端消费者和测试复用同一套请求逻辑。 */
export type SessionNameCompletion = (...args: Parameters<typeof completeSimple>) => ReturnType<typeof completeSimple>;

type SessionNameModel = Parameters<SessionNameCompletion>[0];

/** 计算标题请求的输出预算：取配置的预算与模型输出上限的较小值。 */
export function resolveTitleMaxTokens(
  model: Pick<SessionNameModel, "maxTokens">,
  configuredMaxTokens: number,
): number {
  // 推理模型的思考与标题共用同一份输出预算。预算过小时思考会把额度整个吃掉，
  // 响应因 max_output_tokens 截断且不含标题文本，最终报“没有返回有效标题”。
  // 因此预算由 title.maxTokens 统一控制，默认 2048 留出思考余量。
  return Math.min(model.maxTokens, configuredMaxTokens);
}

/** 单轮会话摘要输入：包含用户消息与该轮模型的最后一次文本输出。 */
export interface SessionNamingTurn {
  userMessage: string;
  assistantOutput?: string;
}

/** 标题请求参数；可传 turns（含用户消息与每轮最后输出）或 userMessages。 */
export type SessionNameRequest = {
  userMessages?: readonly string[];
  turns?: readonly SessionNamingTurn[];
  ctx: SessionNameContext;
  signal?: AbortSignal;
  completion?: SessionNameCompletion;
  title?: Readonly<TitleConfig>;
};

/** 包内标题生成器契约，不绑定终端复用器。 */
export type SessionNameRequester = (request: SessionNameRequest) => Promise<string>;

/** 从字符串或内容块中提取文本；未知内容类型按空文本处理。 */
function getTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

type UserSessionMessageEntry = Extract<SessionEntry, { type: "message" }> & {
  message: { role: "user"; content: unknown };
};

type AssistantSessionMessageEntry = Extract<SessionEntry, { type: "message" }> & {
  message: { role: "assistant"; content: unknown };
};

/** 判断 session 条目是否为用户消息。 */
function isUserMessageEntry(entry: SessionEntry): entry is UserSessionMessageEntry {
  return entry.type === "message" && entry.message.role === "user";
}

/** 判断 session 条目是否为模型输出消息。 */
function isAssistantMessageEntry(entry: SessionEntry): entry is AssistantSessionMessageEntry {
  return entry.type === "message" && entry.message.role === "assistant";
}

/** 提取当前会话分支中的用户输入，不把 assistant/tool/custom 消息交给命名模型。 */
export function getSessionUserMessages(entries: readonly SessionEntry[]): string[] {
  return entries
    .filter(isUserMessageEntry)
    .map((entry) => getTextContent(entry.message.content).trim())
    .filter((message) => message.length > 0);
}

/** 提取当前会话分支中每轮的用户消息及该轮模型最后一次非空文本输出。 */
export function getSessionNamingTurns(entries: readonly SessionEntry[]): SessionNamingTurn[] {
  const turns: SessionNamingTurn[] = [];
  let currentTurn: SessionNamingTurn | undefined;

  for (const entry of entries) {
    if (isUserMessageEntry(entry)) {
      const userMessage = getTextContent(entry.message.content).trim();
      if (userMessage.length > 0) {
        currentTurn = { userMessage };
        turns.push(currentTurn);
      } else {
        currentTurn = undefined;
      }
      continue;
    }

    if (currentTurn && isAssistantMessageEntry(entry)) {
      const assistantOutput = getTextContent(entry.message.content).trim();
      if (assistantOutput.length > 0) {
        currentTurn.assistantOutput = assistantOutput;
      }
    }
  }

  return turns;
}

/** 从当前 session 分支提取用户消息，供命名请求使用。 */
export function getCurrentSessionUserMessages(
  ctx: Pick<ExtensionContext, "sessionManager">,
): string[] {
  return getSessionUserMessages(ctx.sessionManager.getBranch());
}

/** 从当前 session 分支提取每轮用户消息与模型最后输出，供手动命名请求使用。 */
export function getCurrentSessionNamingTurns(
  ctx: Pick<ExtensionContext, "sessionManager">,
): SessionNamingTurn[] {
  return getSessionNamingTurns(ctx.sessionManager.getBranch());
}

function isNamingTurn(value: string | SessionNamingTurn): value is SessionNamingTurn {
  return typeof value === "object" && value !== null && "userMessage" in value;
}

/** 构造带消息边界的命名提示词，避免把用户文本或模型输出当作控制指令。 */
export function buildSessionNamePrompt(
  input: readonly string[] | readonly SessionNamingTurn[],
): string {
  const first = input[0];
  if (first !== undefined && isNamingTurn(first)) {
    const turns = (input as readonly SessionNamingTurn[])
      .map((turn, index) => {
        const parts = [
          `<turn index="${index + 1}">`,
          `<user-message>\n${turn.userMessage}\n</user-message>`,
        ];
        if (turn.assistantOutput) {
          parts.push(`<assistant-output>\n${turn.assistantOutput}\n</assistant-output>`);
        }
        parts.push("</turn>");
        return parts.join("\n");
      })
      .join("\n\n");

    return [
      i18n.t("sessionNamePrompt"),
      "",
      "<conversation-turns>",
      turns,
      "</conversation-turns>",
    ].join("\n");
  }

  const messages = (input as readonly string[])
    .map(
      (message, index) =>
        `<user-message index="${index + 1}">\n${message}\n</user-message>`,
    )
    .join("\n\n");

  return [
    i18n.t("sessionNamePrompt"),
    "",
    "<user-messages>",
    messages,
    "</user-messages>",
  ].join("\n");
}

/** 移除模型可能添加的成对引号，支持中英文常见引号。 */
function removeWrappingQuotes(value: string): string {
  const quotePairs: Array<[string, string]> = [
    ["\"", "\""],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"],
  ];

  for (const [opening, closing] of quotePairs) {
    if (value.startsWith(opening) && value.endsWith(closing)) {
      return value.slice(opening.length, value.length - closing.length).trim();
    }
  }
  return value;
}

/** 把模型的自由文本响应收敛成可作为 session 名称的单行文本。 */
export function normalizeSessionName(raw: string, maxLength = DEFAULT_TITLE_CONFIG.maxLength): string {
  let name = raw.trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .split(/\r?\n/, 1)[0]
    .trim()
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .trim();

  name = removeWrappingQuotes(name).replace(/\s+/g, " ").trim();
  return Array.from(name).slice(0, maxLength).join("").trim();
}

/** 用首条非空提示词和目录名生成标题，保留字面文本，不做模型响应格式清理。 */
export function buildPromptSessionName(
  userMessages: readonly string[],
  cwd: string,
  maxLength = DEFAULT_TITLE_CONFIG.maxLength,
): string {
  const singleLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const prompt = userMessages.map(singleLine).find(Boolean);
  if (!prompt) throw new Error(i18n.t("sessionNameNoMessages"));
  const promptPoints = Array.from(prompt);
  const directory = Array.from(singleLine(basename(cwd) || cwd));
  // 至少给提示词留一半空间；极短上限只显示提示词，避免目录前缀挤掉整个主题。
  if (directory.length === 0 || maxLength < 5) return promptPoints.slice(0, maxLength).join("").trim();
  const directoryLength = Math.min(directory.length, Math.floor((maxLength - 2) / 2));
  return `${directory.slice(0, directoryLength).join("")}: ${promptPoints.slice(0, maxLength - directoryLength - 2).join("")}`.trim();
}

/** 调用当前 session 模型生成名称，并把鉴权、空响应和模型错误显式抛出。 */
export async function requestSessionName({
  userMessages,
  turns,
  ctx,
  signal,
  completion = completeSimple,
  title = DEFAULT_TITLE_CONFIG,
}: SessionNameRequest): Promise<string> {
  const normalizedTurns: SessionNamingTurn[] = turns && turns.length > 0
    ? turns
        .map((turn) => ({
          userMessage: turn.userMessage.trim(),
          ...(turn.assistantOutput?.trim() ? { assistantOutput: turn.assistantOutput.trim() } : {}),
        }))
        .filter((turn) => turn.userMessage.length > 0)
    : (userMessages ?? [])
        .map((message) => message.trim())
        .filter((message) => message.length > 0)
        .map((userMessage) => ({ userMessage }));

  if (normalizedTurns.length === 0) {
    throw new Error(i18n.t("sessionNameNoMessages"));
  }

  const promptInput = normalizedTurns.some((turn) => Boolean(turn.assistantOutput))
    ? normalizedTurns
    : normalizedTurns.map((turn) => turn.userMessage);

  const model = ctx.model as SessionNameModel | undefined;
  if (!model) {
    throw new Error(i18n.t("sessionNameNoModel"));
  }

  // 命名请求由扩展自己发出：鉴权与 provider 会话头交给共享请求器，与 Pi 核心行为一致。
  const request = createModelRequester(ctx, {
    base: completion,
    authError: (error) => new Error(i18n.t("sessionNameAuthFailed", { error })),
  });

  const response = await request(
    model,
    {
      systemPrompt: [
        i18n.t("sessionNameSystem", { maxLength: title.maxLength, preferredLength: title.preferredLength }),
        title.language === "auto"
          ? i18n.t("sessionNameLanguageAuto")
          : i18n.t("sessionNameLanguage", { language: title.language }),
        title.instructions,
      ].filter(Boolean).join("\n"),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildSessionNamePrompt(promptInput) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: resolveTitleMaxTokens(model, title.maxTokens),
      // 命名不需要高强度推理；档位可配置，降低思考占用预算的波动。
      reasoning: title.effort,
      signal,
    },
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(
      i18n.t("sessionNameRequestFailed", {
        error: response.errorMessage ?? response.stopReason,
      }),
    );
  }

  const rawName = response.content
    .filter(
      (content): content is { type: "text"; text: string } =>
        content.type === "text" && typeof content.text === "string",
    )
    .map((content) => content.text)
    .join("\n");
  const name = normalizeSessionName(rawName, title.maxLength);
  if (!name) {
    throw new Error(i18n.t("sessionNameEmpty"));
  }
  return name;
}

/** 标题请求的超时包装参数。 */
export type SessionNameWithTimeoutRequest = {
  userMessages?: readonly string[];
  turns?: readonly SessionNamingTurn[];
  ctx: SessionNameContext;
  requestName?: SessionNameRequester;
  timeoutMs?: number;
  title?: Readonly<TitleConfig>;
};

/**
 * 在固定时间内完成标题请求，并用 AbortSignal 中止底层模型调用。
 * requestName 可替换为终端消费者自己的生成器，但请求契约保持不变。
 */
export async function requestSessionNameWithTimeout({
  userMessages,
  turns,
  ctx,
  requestName = requestSessionName,
  title = DEFAULT_TITLE_CONFIG,
  timeoutMs = title.timeoutMs,
}: SessionNameWithTimeoutRequest): Promise<string> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(i18n.t("sessionNameTimeout")));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      requestName({ userMessages, turns, ctx, signal: controller.signal, title }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
