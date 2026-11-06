import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import piAutoGoal, { NUDGE_CUSTOM_TYPE } from "../src/index.ts";

/** 假的 Pi agent 运行目录；用环境变量隔离，避免读到本机真实配置。 */
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-auto-goal-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
after(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

/** 写一份让判定直接给出「提前停止」的配置，测试因此不需要真实模型调用。 */
function writeForcedContinueConfig(): void {
  const dir = join(AGENT_DIR, "extensions", "pi-auto-goal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ forcedDecision: "continue" }, null, 2)}\n`, "utf8");
}

/** 假 Pi 与假 ctx 的记录容器。 */
interface Harness {
  /** 记录出去的催促消息。 */
  sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
  /** 记录出去的伪造用户消息；入口不该再产生这种调用。 */
  sentUserMessages: unknown[];
  /** 触发一个已注册的事件处理器。 */
  runEvent: (event: string) => Promise<void>;
  /** 触发已注册的 context 处理器并取出它返回的消息列表。 */
  runContext: (messages: unknown[]) => unknown;
}

/** 建一个记录调用的假 Pi 与假 ctx，并加载扩展入口。 */
function createHarness(): Harness {
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  const sentMessages: Harness["sentMessages"] = [];
  const sentUserMessages: unknown[] = [];

  const api = {
    /** 收集扩展注册的事件处理器，测试按事件名回放。 */
    on(event: string, handler: (...args: never[]) => unknown): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    /** 配置命令注册：本测试不关心。 */
    registerCommand(): void {},
    /** 提示块渲染器注册：本测试不关心（提示会退回 ui.notify）。 */
    registerEntryRenderer(): void {},
    /** 记录催促注入的自定义消息。 */
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void {
      sentMessages.push({ message, options });
    },
    /** 记录伪造用户消息的调用；新实现里应该一次都没有。 */
    sendUserMessage(content: unknown): void {
      sentUserMessages.push(content);
    },
  };

  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "正式执行的后缀去掉，统一用【】" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "明白，最终标题统一为……" }], stopReason: "stop" } },
  ];
  const ctx = {
    mode: "tui",
    hasUI: true,
    signal: undefined,
    /** 判定只处理已空闲的会话。 */
    isIdle: () => true,
    /** 没有排队消息才会介入。 */
    hasPendingMessages: () => false,
    ui: {
      /** 提示出口：记录用不上，吞掉即可。 */
      notify: () => {},
      theme: {
        /** 测试主题：原样返回文本。 */
        fg: (_color: string, text: string) => text,
      },
    },
    modelRegistry: {
      /** 本测试不取模型列表。 */
      getAvailable: () => [],
      /** 本测试不做模型解析（判定被配置强制）。 */
      find: () => undefined,
    },
    sessionManager: {
      /** 固定会话 id。 */
      getSessionId: () => "session-1",
      /** 固定叶节点 id，用于「判定期间会话是否被接管」的比较。 */
      getLeafId: () => "leaf-1",
      /** 本轮分支：一条用户请求 + 一条正常收尾的 assistant 输出。 */
      getBranch: () => branch,
    },
  };

  piAutoGoal(api as never);

  return {
    sentMessages,
    sentUserMessages,
    runEvent: async (event) => {
      for (const handler of handlers.get(event) ?? []) {
        await (handler as (a: unknown, b: unknown) => Promise<void>)(undefined, ctx);
      }
    },
    runContext: (messages) => {
      let result: unknown;
      for (const handler of handlers.get("context") ?? []) {
        result = (handler as (a: unknown) => unknown)({ type: "context", messages });
      }
      return result;
    },
  };
}

test("判定为提前停止时注入 system 催促，不再发伪造的用户消息", async () => {
  writeForcedContinueConfig();
  const harness = createHarness();

  await harness.runEvent("agent_settled");

  assert.equal(harness.sentUserMessages.length, 0, "用户模式已废弃，不能再调用 sendUserMessage");
  assert.equal(harness.sentMessages.length, 1);
  const [sent] = harness.sentMessages;
  assert.equal(sent.message.customType, NUDGE_CUSTOM_TYPE);
  assert.equal(sent.message.display, false);
  assert.deepEqual(sent.options, { triggerTurn: true });
  assert.match(String(sent.message.content), /立即继续执行剩余步骤/);
});

test("催促那一轮的请求里，催促是 system 消息而不是用户消息", async () => {
  writeForcedContinueConfig();
  const harness = createHarness();
  await harness.runEvent("agent_settled");

  const [sent] = harness.sentMessages;
  const nudge = {
    role: "custom",
    customType: NUDGE_CUSTOM_TYPE,
    content: sent.message.content,
    display: false,
    timestamp: 7,
  };
  const result = harness.runContext([
    { role: "system", content: "系统提示", timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "正式执行的后缀去掉，统一用【】" }] },
    nudge,
  ]) as { messages: Array<Record<string, unknown>> } | undefined;

  assert.ok(result);
  const last = result.messages[2];
  assert.equal(last.role, "system");
  assert.equal(last.content, sent.message.content);
  assert.equal(result.messages.some((message) => message.role === "custom"), false);
});
