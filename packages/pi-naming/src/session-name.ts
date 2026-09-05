import { complete } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";

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
};

/** 标题生成器契约，供其他扩展调用，不绑定终端复用器。 */
export type SessionNameRequester = (request: SessionNameRequest) => Promise<string>;

/** Session 名称允许的最大字符数。 */
export const MAX_SESSION_NAME_LENGTH = 15;

/** 提示词要求模型优先控制在的字符数。 */
export const PREFERRED_SESSION_NAME_LENGTH = 10;

/** 后台自动命名请求的最长等待时间。 */
export const SESSION_NAME_TIMEOUT_MS = 10_000;

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
export function normalizeSessionName(raw: string): string {
  let name = raw.trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .split(/\r?\n/, 1)[0]
    .trim()
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .trim();

  name = removeWrappingQuotes(name).replace(/\s+/g, " ").trim();
  return Array.from(name).slice(0, MAX_SESSION_NAME_LENGTH).join("").trim();
}

/** 调用当前 session 模型生成名称，并把鉴权、空响应和模型错误显式抛出。 */
export async function requestSessionName({
  userMessages,
  ctx,
  signal,
  completion = complete,
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
      systemPrompt: i18n.t("sessionNameSystem"),
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
      maxTokens: 64,
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
  const name = normalizeSessionName(rawName);
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
};

/**
 * 在固定时间内完成标题请求，并用 AbortSignal 中止底层模型调用。
 * requestName 可替换为终端消费者自己的生成器，但请求契约保持不变。
 */
export async function requestSessionNameWithTimeout({
  userMessages,
  ctx,
  requestName = requestSessionName,
  timeoutMs = SESSION_NAME_TIMEOUT_MS,
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
      requestName({ userMessages, ctx, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** 将 unknown 错误转换为可展示给用户的消息。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AutomaticNameState = {
  generation: number;
  eligible: boolean;
  attempted: boolean;
};

type AutomaticNameRequest = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: AutomaticNameState;
  generation: number;
  userMessages: readonly string[];
  requestName: SessionNameRequester;
};

/** 完成首条用户输入触发的后台命名，并在 session 切换时丢弃过期结果。 */
async function applyAutomaticName({
  pi,
  ctx,
  state,
  generation,
  userMessages,
  requestName,
}: AutomaticNameRequest): Promise<void> {
  const label = await requestSessionNameWithTimeout({
    userMessages,
    ctx,
    requestName,
  });

  if (state.generation !== generation || pi.getSessionName()) return;

  pi.setSessionName(label);
  if (ctx.hasUI) {
    ctx.ui.notify(i18n.t("autoSessionNameDone", { label }), "info");
  }
}

/** 注册新 session 第一条真实用户输入后的自动命名监听。 */
export function registerAutomaticSessionNaming(
  pi: ExtensionAPI,
  requestName: SessionNameRequester = requestSessionName,
  enabled = true,
): void {
  if (!enabled) return;
  const state: AutomaticNameState = {
    generation: 0,
    eligible: false,
    attempted: false,
  };

  pi.on("session_start", (_event, ctx) => {
    const userMessages = getCurrentSessionUserMessages(ctx);
    state.generation += 1;
    state.eligible = !ctx.sessionManager.getSessionName() && userMessages.length === 0;
    state.attempted = false;
  });

  // reload/切换会销毁旧扩展实例，不能只依赖新实例的 session_start。
  pi.on("session_shutdown", () => {
    state.generation += 1;
    state.eligible = false;
  });

  pi.on("input", (event, ctx) => {
    if (
      !state.eligible ||
      state.attempted ||
      event.source === "extension" ||
      pi.getSessionName()
    ) {
      return;
    }

    const text = event.text.trim();
    if (!text) return;

    state.attempted = true;
    const generation = state.generation;
    void applyAutomaticName({
      pi,
      ctx,
      state,
      generation,
      userMessages: [text],
      requestName,
    }).catch((error: unknown) => {
      if (state.generation !== generation) return;
      if (ctx.hasUI) {
        ctx.ui.notify(
          i18n.t("autoNameFailed", { error: errorMessage(error) }),
          "warning",
        );
      }
    });
  });
}
