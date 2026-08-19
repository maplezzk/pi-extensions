import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import sessionTailCompaction from "../src/session-tail-compaction.ts";
import { SESSION_SQUASH_TYPE } from "../src/session-tail-compaction-utils.ts";

type RegisteredTool = {
  name: string;
  parameters: { required?: string[] };
  execute: (
    toolCallId: string,
    params: { from: number; summary: string },
    signal: undefined,
    onUpdate: undefined,
    context: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError: boolean;
  }>;
};

test("session_squash 直接接收摘要并在 agent_settled 后完成分支切换", async () => {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    /** 收集扩展注册的工具定义，供测试直接调用。 */
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    /** 本测试不覆盖斜杠命令，仅满足扩展注册接口。 */
    registerCommand() {},
    /** 保存生命周期处理器，供测试模拟 agent_settled。 */
    on(eventName: string, handler: (event: unknown, context: unknown) => Promise<void>) {
      handlers.set(eventName, handler);
    },
    /** 记录扩展发送到新分支的摘要消息。 */
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  sessionTailCompaction(pi);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["session_log", "session_squash"],
  );
  const squashTool = tools.find((tool) => tool.name === "session_squash");
  assert.ok(squashTool);
  assert.deepEqual(squashTool.parameters.required, ["from", "summary"]);

  const branch: SessionEntry[] = [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "已完成任务", timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "/tmp/context.ts" },
          },
        ],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
  const branchTargets: string[] = [];
  const notifications: string[] = [];
  const sessionManager = {
    getBranch: () => branch,
    getSessionId: () => "session-1",
    getLeafId: () => "a1",
    /** 记录折叠时选择的分支起点。 */
    branch(entryId: string) {
      branchTargets.push(entryId);
    },
    buildContextEntries: () => branch,
  };
  const context = {
    sessionManager,
    getContextUsage: () => ({ tokens: 1234 }),
    ui: {
      /** 记录折叠完成通知。 */
      notify(text: string) {
        notifications.push(text);
      },
    },
  };

  const result = await squashTool.execute(
    "tool-1",
    { from: 0, summary: "## Goal\n完成压缩" },
    undefined,
    undefined,
    context,
  );
  assert.equal(result.isError, false);

  const settled = handlers.get("agent_settled");
  assert.ok(settled);
  await settled({}, context);

  assert.deepEqual(branchTargets, ["u1"]);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0]?.options, { triggerTurn: true });
  const sent = sentMessages[0]?.message as {
    customType: string;
    content: string;
    details: { summary: string };
  };
  assert.equal(sent.customType, SESSION_SQUASH_TYPE);
  assert.equal(
    sent.content,
    "## Goal\n完成压缩\n\n<read-files>\n/tmp/context.ts\n</read-files>",
  );
  assert.equal(sent.details.summary, sent.content);
  assert.equal(notifications.length, 1);
});
