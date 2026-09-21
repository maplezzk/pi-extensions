import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  NUDGE_CUSTOM_TYPE,
  createNudgeDelivery,
  isNudgeMessage,
  registerNudgeContext,
  triggerSystemNudge,
} from "../src/system-nudge.ts";

/** context 消息列表里的单条消息。 */
type ContextMessage = ContextEvent["messages"][number];

/** 催促文本。 */
const NUDGE_TEXT = "【自动监督】你在任务尚未完成时停下了。";

/** 一条本扩展注入的催促消息（会话里的形态）。 */
function nudgeMessage(): ContextMessage {
  return {
    role: "custom",
    customType: NUDGE_CUSTOM_TYPE,
    content: NUDGE_TEXT,
    display: false,
    timestamp: 42,
  } as unknown as ContextMessage;
}

/** 一条普通自定义消息，用来确认钩子不误伤别家的消息。 */
function foreignMessage(): ContextMessage {
  return {
    role: "custom",
    customType: "other-extension",
    content: "别的扩展",
    display: true,
    timestamp: 1,
  } as unknown as ContextMessage;
}

/** 运行时自带的 system 消息（Pi 0.86 起系统提示就在消息列表里）。 */
function runtimeSystemMessage(): ContextMessage {
  return { role: "system", content: "系统提示", timestamp: 0 } as unknown as ContextMessage;
}

/** 用户消息。 */
function userMessage(text: string): ContextMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 3 } as unknown as ContextMessage;
}

/** 建一个只记录 context 处理器与 sendMessage 调用的假 Pi。 */
function createApiStub(): {
  api: ExtensionAPI;
  runContext: (messages: ContextMessage[]) => ContextEvent["messages"] | undefined;
  sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }>;
} {
  const handlers: Array<(event: ContextEvent) => unknown> = [];
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
  const api = {
    on(event: string, handler: (event: ContextEvent) => unknown): void {
      if (event === "context") handlers.push(handler);
    },
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    runContext: (messages) => {
      let result: ContextEvent["messages"] | undefined;
      for (const handler of handlers) {
        const output = handler({ type: "context", messages }) as { messages?: ContextEvent["messages"] } | undefined;
        if (output?.messages) result = output.messages;
      }
      return result;
    },
    sent,
  };
}

/** 读出消息的正文文本。 */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("");
}

test("isNudgeMessage 只认本扩展注入的催促消息", () => {
  assert.equal(isNudgeMessage(nudgeMessage()), true);
  assert.equal(isNudgeMessage(foreignMessage()), false);
  assert.equal(isNudgeMessage(userMessage("催一下")), false);
  assert.equal(isNudgeMessage(undefined), false);
});

test("催促那一轮把催促消息换成同位置的 system 消息", () => {
  const { api, runContext } = createApiStub();
  const delivery = createNudgeDelivery();
  registerNudgeContext(api, delivery);

  const nudge = nudgeMessage();
  const messages: ContextMessage[] = [runtimeSystemMessage(), userMessage("把命名改掉"), nudge];
  delivery.active = true;

  const next = runContext(messages);
  assert.ok(next);
  // 催促之外的上下文保持原样，催促被替换成 system 消息且位置不变。
  assert.deepEqual(next.slice(0, 2), messages.slice(0, 2));
  assert.equal(next.length, 3);
  const replaced = next[2] as { role?: string; content?: unknown; timestamp?: number };
  assert.equal(replaced.role, "system");
  assert.equal(replaced.content, NUDGE_TEXT);
  assert.equal(replaced.timestamp, 42);
});

test("催促轮结束后催促消息不再进入上下文", () => {
  const { api, runContext } = createApiStub();
  const delivery = createNudgeDelivery();
  registerNudgeContext(api, delivery);

  delivery.active = true;
  runContext([runtimeSystemMessage(), nudgeMessage()]);
  delivery.active = false;

  const next = runContext([runtimeSystemMessage(), nudgeMessage(), userMessage("继续")]);
  assert.ok(next);
  assert.equal(next.length, 2);
  assert.equal(next.some(isNudgeMessage), false);
});

test("运行时没有 system 消息时不动上下文，退回催促消息本身", () => {
  const { api, runContext } = createApiStub();
  const delivery = createNudgeDelivery();
  registerNudgeContext(api, delivery);

  const messages: ContextMessage[] = [userMessage("把命名改掉"), nudgeMessage()];
  delivery.active = true;

  // 旧运行时会把消息列表里的 system 消息静默丢掉，此时保持原样，模型至少能看到催促。
  assert.equal(runContext(messages), undefined);
});

test("没有催促消息时钩子完全不介入", () => {
  const { api, runContext } = createApiStub();
  registerNudgeContext(api, createNudgeDelivery());

  assert.equal(runContext([runtimeSystemMessage(), userMessage("随便聊聊")]), undefined);
  assert.equal(runContext([runtimeSystemMessage(), foreignMessage()]), undefined);
});

test("triggerSystemNudge 用不可见自定义消息触发一轮并标记催促", () => {
  const { api, sent } = createApiStub();
  const delivery = createNudgeDelivery();

  triggerSystemNudge(api, delivery, NUDGE_TEXT);

  assert.equal(delivery.active, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, NUDGE_CUSTOM_TYPE);
  assert.equal(messageText(sent[0].message), NUDGE_TEXT);
  // 会话区不渲染这条消息，用户只在判定提示块里看到「已注入的催促」。
  assert.equal(sent[0].message.display, false);
  assert.deepEqual(sent[0].options, { triggerTurn: true });
});
