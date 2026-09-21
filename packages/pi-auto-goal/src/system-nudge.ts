/**
 * 催促投递：把自动催促作为 system 提示送给模型，而不是伪装成一条用户消息。
 *
 * 触发新一轮必须发一条消息：扩展 API 里只有 `sendMessage`（自定义消息）能在 agent 空闲时
 * 直接起一轮，而它不会走 `before_agent_start`。所以投递分两步：
 * 1. 发一条内容为催促文本、`display: false` 的自定义消息触发新一轮 —— 会话区不渲染用户消息框，
 *    用户只在判定提示块里看到「已注入的催促」；
 * 2. `context` 钩子在请求发出前把这条自定义消息换成同位置的 system 消息，模型收到的是 system 指令；
 *    催促那一轮结束后它不再进入上下文，不会残留到后续轮次的系统提示里。
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

/** 催促投递状态：`active` 为 true 表示当前这一轮由催促触发。 */
export interface NudgeDelivery {
  /** 催促那一轮是否还在进行。 */
  active: boolean;
}

/** 创建投递状态。 */
export function createNudgeDelivery(): NudgeDelivery {
  return { active: false };
}

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
 * 注册催促投递的 context 钩子。
 * 催促那一轮把催促消息换成 system 消息；其余时候把它从上下文里去掉，避免旧催促反复注入。
 */
export function registerNudgeContext(pi: ExtensionAPI, delivery: NudgeDelivery): void {
  pi.on("context", (event) => {
    const messages = event.messages ?? [];
    if (!messages.some(isNudgeMessage)) return;
    if (!supportsRuntimeSystemMessages(messages)) return;
    return {
      messages: messages.flatMap((message) => {
        if (!isNudgeMessage(message)) return [message];
        return delivery.active ? [toSystemMessage(message)] : [];
      }),
    };
  });
}

/**
 * 触发一轮催促，并把它标记为 system 催促。
 * 发送失败由调用方处理：抛出时不会置位 active，这一轮不会被误当成催促轮。
 */
export function triggerSystemNudge(pi: ExtensionAPI, delivery: NudgeDelivery, text: string): void {
  pi.sendMessage(
    { customType: NUDGE_CUSTOM_TYPE, content: text, display: false },
    { triggerTurn: true },
  );
  delivery.active = true;
}
