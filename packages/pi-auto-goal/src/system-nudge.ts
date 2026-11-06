/**
 * 催促投递：把自动催促作为 system 提示送给模型，而不是伪装成一条用户消息。
 *
 * 触发新一轮必须发一条消息：扩展 API 里只有 `sendMessage`（自定义消息）能在 agent 空闲时
 * 直接起一轮，而它不会走 `before_agent_start`。所以投递分两步：
 * 1. 发一条内容为催促文本、`display: false` 的自定义消息触发新一轮 —— 会话区不渲染用户消息框，
 *    用户只在判定提示块里看到「已注入的催促」；
 * 2. `context` 钩子在请求发出前把每条催促消息原地换成 system 消息，模型收到的是 system 指令。
 *
 * 转换只依赖消息本身、不看「这一轮是不是催促轮」：会话转写因此只追加、不回溯，
 * 每轮请求的前缀与上一轮完全一致，提示缓存才能命中。反过来，按轮次决定保留或删除某条催促，
 * 会让整个会话从那条消息的位置起整体位移（历史上一条旧催促就能让几万 token 的前缀作废，
 * 表现成「缓存失效、全量重算」）。历史催促留在原位同时也如实反映了模型当时确实收到的指令。
 *
 * 运行时不认识消息列表里的 system 消息时（Pi 0.85 及更早），退回自定义消息本身：
 * 模型仍会收到催促，宁可按消息形式说一句，也不静默丢掉指令。
 */
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTextContent } from "./session-context.ts";

/** 催促消息的自定义类型；context 钩子靠它认出自己注入的那条消息。 */
export const NUDGE_CUSTOM_TYPE = "auto-goal-nudge";

/** context 钩子里的单条消息。 */
type ContextMessage = ContextEvent["messages"][number];

/** 判定消息角色与自定义类型所需的最小结构。 */
type MessageLike = { role?: unknown; customType?: unknown; content?: unknown; timestamp?: unknown };

/** 是否为本次扩展注入的催促消息。 */
export function isNudgeMessage(message: unknown): boolean {
  const candidate = message as MessageLike | null | undefined;
  return candidate?.role === "custom" && candidate.customType === NUDGE_CUSTOM_TYPE;
}

/**
 * 运行时是否认识消息列表里的 system 消息。
 * Pi 0.86 起系统提示本身就以 system 消息存放在消息列表里；旧版本只有 user/assistant/toolResult，
 * 往列表里塞 system 消息会被静默丢弃，所以要先探测再决定用哪种投递方式。
 */
function supportsRuntimeSystemMessages(messages: readonly ContextMessage[]): boolean {
  return messages.some((message) => (message as MessageLike).role === "system");
}

/** 把催促消息换成同位置的 system 消息。 */
function toSystemMessage(message: ContextMessage): ContextMessage {
  const source = message as MessageLike;
  return {
    role: "system",
    content: getTextContent(source.content),
    timestamp: typeof source.timestamp === "number" ? source.timestamp : 0,
  } as unknown as ContextMessage;
}

/**
 * 注册催促投递的 context 钩子：每条催促消息都原地转成 system 消息，位置与条数都不变。
 * 纯函数式的替换保证同一段转写每轮都得到同样的请求前缀，历史催促不会被删掉又复活。
 */
export function registerNudgeContext(pi: ExtensionAPI): void {
  pi.on("context", (event) => {
    const messages = event.messages ?? [];
    if (!messages.some(isNudgeMessage)) return;
    if (!supportsRuntimeSystemMessages(messages)) return;
    return {
      messages: messages.map((message) => (isNudgeMessage(message) ? toSystemMessage(message) : message)),
    };
  });
}

/** 触发一轮催促；发送失败由调用方处理，抛出时这一轮不会起。 */
export function triggerSystemNudge(pi: ExtensionAPI, text: string): void {
  pi.sendMessage(
    { customType: NUDGE_CUSTOM_TYPE, content: text, display: false },
    { triggerTurn: true },
  );
}
