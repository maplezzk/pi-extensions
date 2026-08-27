import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertToLlm, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  SESSION_SQUASH_FORCE_TYPE,
  SESSION_SQUASH_HINT_TYPE,
  SESSION_SQUASH_TYPE,
} from "../src/session-tail-compaction-utils.ts";

type RegisteredTool = {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters: {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  execute: (
    toolCallId: string,
    params: {
      from: number;
      summary: string;
      continuation?: "auto" | "next-user";
    },
    signal: undefined,
    onUpdate: undefined,
    context: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError: boolean;
    terminate?: boolean;
  }>;
};

type EventHandler = (
  event: {
    toolName?: string;
    messages?: Array<{ role?: string; stopReason?: string }>;
  },
  context: unknown,
) => unknown | Promise<unknown>;

type RegisteredCommand = {
  handler: (args: string, context: unknown) => Promise<void>;
};

const VALID_HANDOFF_SUMMARY = [
  "# Handoff: test",
  "## Timeline of user and agent work",
  "- User: 提出需要继续核对的任务。",
  "- Agent: 完成当前阶段的验证。",
  "## Current focus",
  "objective：继续核对当前状态；准确停点：等待下一步。",
  "### Background and problem origin",
  "此前存在需要纠正的方向。",
  "## Errors and resolutions",
  "已记录并停止错误方向。",
  "## Code and artifact state",
  "无新的代码改动。",
  "## Environment and repository state",
  "工作区状态已核对。",
  "## Completed work and decisions",
  "已完成当前阶段。",
  "## Active issues and next actions",
  "等待下一步。",
  "## Important context and boundaries",
  "不扩大任务范围。",
  "## Suggested skills",
  "None observed.",
].join("\n");

/** 验证强制门禁、稳定的压缩锚点和两种接续模式。 */
test("强制模式限制工具，并按 continuation 控制压缩后接续", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-session-tools-force-"));
  const configDir = join(agentDir, "extensions", "pi-session-tools");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ forceSquashContextThreshold: 0.5 }),
    "utf8",
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(agentDir, { recursive: true, force: true });
  });
  const moduleUrl = new URL("../src/session-tail-compaction.ts", import.meta.url);
  moduleUrl.searchParams.set("force-test", "enabled");
  const { default: sessionTailCompaction } = await import(moduleUrl.href);

  const tools: RegisteredTool[] = [];
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, EventHandler>();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  let activeTools = ["read", "bash", "session_log", "session_squash"];
  const pi = {
    /** 收集扩展注册的工具定义，供测试直接调用。 */
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    /** 收集配置命令，验证 force off 会立即退出强制状态。 */
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    /** 保存生命周期处理器，供测试模拟 turn_end、tool_call 和 agent_settled。 */
    on(eventName: string, handler: EventHandler) {
      handlers.set(eventName, handler);
    },
    /** 返回当前活动工具快照。 */
    getActiveTools() {
      return [...activeTools];
    },
    /** 模拟 Pi 切换活动工具集合。 */
    setActiveTools(toolNames: string[]) {
      activeTools = [...toolNames];
    },
    /** 记录扩展发送的强制任务和压缩摘要消息。 */
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
  assert.deepEqual(squashTool.parameters.required, [
    "from",
    "summary",
    "continuation",
  ]);
  assert.ok(squashTool.parameters.properties?.continuation);
  assert.ok(
    squashTool.promptGuidelines?.some((guideline) =>
      guideline.includes("Timeline of user and agent work")
    ),
  );
  assert.ok(
    squashTool.promptGuidelines?.every((guideline) =>
      guideline.includes("session_squash")
    ),
  );
  assert.ok(
    squashTool.promptGuidelines?.some((guideline) =>
      guideline.includes("next-user")
    ),
  );

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
  let abortCount = 0;
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
    model: { contextWindow: 2000 },
    hasUI: true,
    getContextUsage: () => ({
      tokens: 1234,
      contextWindow: 4000,
      percent: 30.85,
    }),
    /** 记录工具批结束后的强制中止。 */
    abort() {
      abortCount += 1;
    },
    ui: {
      /** 记录折叠完成通知。 */
      notify(text: string) {
        notifications.push(text);
      },
    },
  };

  const turnEnd = handlers.get("turn_end");
  const toolCall = handlers.get("tool_call");
  const agentEnd = handlers.get("agent_end");
  const settled = handlers.get("agent_settled");
  assert.ok(turnEnd);
  assert.ok(toolCall);
  assert.ok(agentEnd);
  assert.ok(settled);

  await turnEnd({}, context);
  assert.equal(abortCount, 1);
  assert.deepEqual(activeTools, ["session_log", "session_squash"]);
  const blockedCall = await toolCall({ toolName: "bash" }, context) as {
    block: boolean;
    terminate: boolean;
    reason: string;
  };
  assert.equal(blockedCall.block, true);
  assert.equal(blockedCall.terminate, true);
  assert.match(blockedCall.reason, /bash/);

  const configCommand = commands.get("config:session-tools");
  assert.ok(configCommand);
  await configCommand.handler("force off", context);
  assert.deepEqual(activeTools, ["read", "bash", "session_log", "session_squash"]);
  await settled({}, context);
  assert.equal(sentMessages.length, 0);

  await configCommand.handler("1k", context);
  await agentEnd(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    context,
  );
  await settled({}, context);
  const hintMessage = sentMessages.find(({ message }) =>
    (message as { customType?: string }).customType === SESSION_SQUASH_HINT_TYPE
  )?.message as { content: Array<{ type: "text"; text: string }> } | undefined;
  assert.ok(hintMessage);
  assert.match(hintMessage.content[0]?.text ?? "", /1\.2k \/ 4k/);
  assert.match(hintMessage.content[0]?.text ?? "", /30\.9%/);

  await configCommand.handler("force 90%", context);
  await turnEnd({}, context);
  assert.equal(abortCount, 1);
  assert.deepEqual(activeTools, ["read", "bash", "session_log", "session_squash"]);

  await configCommand.handler("force 0", context);
  await turnEnd({}, context);
  assert.equal(abortCount, 2);
  assert.deepEqual(activeTools, ["session_log", "session_squash"]);
  await configCommand.handler("force off", context);

  await configCommand.handler("force 0.5", context);
  const persistedConfig: unknown = JSON.parse(
    readFileSync(join(configDir, "config.json"), "utf8"),
  );
  assert.ok(persistedConfig && typeof persistedConfig === "object");
  assert.equal(
    (persistedConfig as { forceSquashContextThreshold?: number })
      .forceSquashContextThreshold,
    0.5,
  );
  await turnEnd({}, context);
  assert.equal(abortCount, 3);
  assert.deepEqual(activeTools, ["session_log", "session_squash"]);

  await settled({}, context);
  await settled({}, context);
  const forceMessages = sentMessages.filter(({ message }) =>
    (message as { customType?: string }).customType === SESSION_SQUASH_FORCE_TYPE
  );
  assert.equal(forceMessages.length, 2);
  const forceText = (forceMessages[0]?.message as {
    content: Array<{ type: "text"; text: string }>;
  }).content[0]?.text ?? "";
  assert.match(forceText, /Timeline of user and agent work/);
  assert.match(forceText, /Completed.*Remaining.*Resume/s);

  const invalidResult = await squashTool.execute(
    "invalid-summary",
    {
      from: 0,
      summary: "## Work Completed\n不完整快照",
      continuation: "next-user",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(invalidResult.isError, true);
  assert.match(invalidResult.content[0]?.text ?? "", /快照结构不完整|snapshot is incomplete/);
  assert.deepEqual(branchTargets, []);

  const result = await squashTool.execute(
    "tool-1",
    {
      from: 0,
      summary: VALID_HANDOFF_SUMMARY,
      continuation: "next-user",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(result.isError, false);
  assert.equal(result.terminate, true);
  await settled({}, context);

  assert.deepEqual(branchTargets, ["u1"]);
  assert.deepEqual(activeTools, ["read", "bash", "session_log", "session_squash"]);
  const squashMessages = sentMessages.filter(({ message }) =>
    (message as { customType?: string }).customType === SESSION_SQUASH_TYPE
  );
  assert.equal(squashMessages.length, 1);
  assert.deepEqual(squashMessages[0]?.options, { triggerTurn: false });
  const sent = squashMessages[0]?.message as {
    customType: string;
    content: string;
    details: { summary: string };
  };
  assert.equal(sent.customType, SESSION_SQUASH_TYPE);
  assert.match(sent.content, /任务状态快照|Task state snapshot/);
  assert.match(sent.content, /不是新的用户需求|not a new user request/);
  assert.doesNotMatch(sent.content, /session_log|session_squash|上下文阈值/);
  assert.ok(sent.content.endsWith(VALID_HANDOFF_SUMMARY));
  assert.doesNotMatch(sent.content, /<read-files>/);
  assert.equal(sent.details.summary, sent.content);
  assert.ok(notifications.length >= 5);

  await configCommand.handler("force off", context);
  const normalResult = await squashTool.execute(
    "tool-2",
    {
      from: 0,
      summary: VALID_HANDOFF_SUMMARY,
      continuation: "auto",
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(normalResult.isError, false);
  assert.equal(normalResult.terminate, true);
  await settled({}, context);

  assert.deepEqual(branchTargets, ["u1", "u1"]);
  const allSquashMessages = sentMessages.filter(({ message }) =>
    (message as { customType?: string }).customType === SESSION_SQUASH_TYPE
  );
  assert.equal(allSquashMessages.length, 2);
  assert.deepEqual(allSquashMessages[1]?.options, { triggerTurn: true });
});

test("session-squash 快照以 compaction summary 语义注入上下文", async () => {
  type ContextHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  const moduleUrl = new URL("../src/session-tail-compaction.ts", import.meta.url);
  moduleUrl.searchParams.set("handoff-context-test", "enabled");
  const { default: sessionTailCompaction } = await import(moduleUrl.href);
  const handlers = new Map<string, ContextHandler>();
  const snapshot = "[Task state snapshot]\n## Current State\n继续执行 Resume";
  const squashEntry: SessionEntry = {
    type: "custom_message",
    id: "squash-1",
    parentId: "user-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: SESSION_SQUASH_TYPE,
    content: snapshot,
    display: true,
    details: {
      startEntryId: "user-1",
      sourceLeafId: "leaf-1",
      fromUserInputIndex: 0,
      summary: snapshot,
      tokensBefore: 1234,
    },
  };
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: (eventName: string, handler: ContextHandler) => handlers.set(eventName, handler),
  } as unknown as ExtensionAPI;
  sessionTailCompaction(pi);

  const result = await handlers.get("context")?.({}, {
    sessionManager: {
      getBranch: () => [squashEntry],
      buildContextEntries: () => [squashEntry],
    },
  }) as { messages: Array<{ role?: string; summary?: string; tokensBefore?: number }> };
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.role, "compactionSummary");
  assert.equal(result.messages[0]?.summary, snapshot);
  assert.equal(result.messages[0]?.tokensBefore, 1234);

  const llmMessages = convertToLlm(result.messages as Parameters<typeof convertToLlm>[0]);
  const llmContent = llmMessages[0]?.content;
  const llmText = typeof llmContent === "string"
    ? llmContent
    : llmContent?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
  assert.match(llmText, /^The conversation history before this point was compacted into the following summary:/);
  assert.match(llmText, /## Current State/);
});
