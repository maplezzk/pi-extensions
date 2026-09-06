import { complete } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";
import { DEFAULT_TITLE_CONFIG, type TitleConfig } from "./config.ts";

const MIN_TITLE_OUTPUT_TOKENS = 64;
const TOKENS_PER_TITLE_CODE_POINT = 4;

/** 生成标题所需的最小 session 上下文；终端消费者可复用该契约。 */
export type SessionNameContext = Pick<ExtensionContext, "model" | "modelRegistry">;

/** 可注入的标题 completion，便于终端消费者和测试复用同一套请求逻辑。 */
export type SessionNameCompletion = (...args: Parameters<typeof complete>) => ReturnType<typeof complete>;

type SessionNameModel = Parameters<SessionNameCompletion>[0];

/** 标题请求参数；userMessages 只应包含待分析的用户输入。 */
export type SessionNameRequest = {
  userMessages: readonly string[];
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

/** 判断 session 条目是否为带文本内容的用户消息。 */
function isUserMessageEntry(entry: SessionEntry): entry is UserSessionMessageEntry {
  return entry.type === "message" && entry.message.role === "user";
}

/** 提取当前会话分支中的用户输入，不把 assistant/tool/custom 消息交给命名模型。 */
export function getSessionUserMessages(entries: readonly SessionEntry[]): string[] {
  return entries
    .filter(isUserMessageEntry)
    .map((entry) => getTextContent(entry.message.content).trim())
    .filter((message) => message.length > 0);
}

/** 从当前 session 分支提取用户消息，供命名请求使用。 */
export function getCurrentSessionUserMessages(
  ctx: Pick<ExtensionContext, "sessionManager">,
): string[] {
  return getSessionUserMessages(ctx.sessionManager.getBranch());
}

/** 构造带消息边界的命名提示词，避免把用户文本当作控制指令。 */
export function buildSessionNamePrompt(userMessages: readonly string[]): string {
  const messages = userMessages
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

/** 调用当前 session 模型生成名称，并把鉴权、空响应和模型错误显式抛出。 */
export async function requestSessionName({
  userMessages,
  ctx,
  signal,
  completion = complete,
  title = DEFAULT_TITLE_CONFIG,
}: SessionNameRequest): Promise<string> {
  if (userMessages.length === 0) {
    throw new Error(i18n.t("sessionNameNoMessages"));
  }

  const model = ctx.model as SessionNameModel | undefined;
  if (!model) {
    throw new Error(i18n.t("sessionNameNoModel"));
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (auth.ok === false) {
    throw new Error(i18n.t("sessionNameAuthFailed", { error: auth.error }));
  }

  const response = await completion(
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
          content: [{ type: "text", text: buildSessionNamePrompt(userMessages) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      // 较长标题需要更多输出预算，但不能超过模型的输出上限。
      maxTokens: Math.min(
        model.maxTokens,
        Math.max(MIN_TITLE_OUTPUT_TOKENS, title.maxLength * TOKENS_PER_TITLE_CODE_POINT),
      ),
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
  userMessages: readonly string[];
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
      requestName({ userMessages, ctx, signal: controller.signal, title }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
