import assert from "node:assert/strict";
import { test } from "node:test";
import { collectTurnSnapshot, getTextContent, readLastAssistantStopReason, truncateText, type TurnSnapshotOptions } from "../src/session-context.ts";

/** 默认测试参数：足够大，避免无关注释。 */
const OPTIONS: TurnSnapshotOptions = {
  maxUserRequestChars: 1000,
  maxFinalOutputChars: 1000,
  maxToolTraceEntries: 10,
  includeToolTrace: true,
  maxUserAnswerChars: 1000,
};

/** 构造一条工具结果条目。 */
function toolResultEntry(toolName: string, text: string): {
  type: string;
  message: { role: string; toolName: string; content: unknown };
} {
  return { type: "message", message: { role: "toolResult", toolName, content: [{ type: "text", text }] } };
}

/** 一条提问工具返回的用户回答，与真实会话里的内容一致。 */
function askUserAnswer(text: string): string {
  return `User has answered your questions: "范围？"="${text}". You can now continue with the user's answers in mind.`;
}

/** 构造一条 session 消息条目。 */
function messageEntry(role: string, content: unknown): { type: string; message: { role: string; content: unknown } } {
  return { type: "message", message: { role, content } };
}

/** 一段包含工具调用的 assistant 内容。 */
function assistantWithTool(text: string, name: string, args: Record<string, unknown>): unknown {
  return [{ type: "text", text }, { type: "toolCall", name, arguments: args }];
}

test("getTextContent 只拼接文本块", () => {
  assert.equal(getTextContent("纯字符串"), "纯字符串");
  assert.equal(getTextContent([
    { type: "text", text: "第一段" },
    { type: "image", data: "x" },
    { type: "text", text: "第二段" },
  ]), "第一段第二段");
  assert.equal(getTextContent(undefined), "");
});

test("truncateText 超长时截断并标注", () => {
  assert.equal(truncateText("abc", 5), "abc");
  const truncated = truncateText("abcdefghij", 4);
  assert.match(truncated, /^abcd\n/);
  assert.match(truncated, /已截断 6 字符/);
});

test("快照包含用户请求、最后输出与工具轨迹", () => {
  const snapshot = collectTurnSnapshot([
    messageEntry("user", [{ type: "text", text: "把 a.ts 改好并跑测试" }]),
    messageEntry("assistant", assistantWithTool("先读文件。", "read", { path: "a.ts" })),
    messageEntry("toolResult", [{ type: "text", text: "file content" }]),
    messageEntry("assistant", [{ type: "text", text: "已经改好 a.ts。" }]),
  ], OPTIONS);

  assert.ok(snapshot);
  assert.equal(snapshot.userRequest, "把 a.ts 改好并跑测试");
  assert.equal(snapshot.finalOutput, "已经改好 a.ts。");
  assert.equal(snapshot.toolTrace.length, 1);
  assert.match(snapshot.toolTrace[0], /^- read \{"path":"a\.ts"\}$/);
  assert.deepEqual(snapshot.userAnswers, []);
});

test("提问工具带回的用户回答计入本轮上下文", () => {
  const answer = askUserAnswer("先停下，我自己看");
  const snapshot = collectTurnSnapshot([
    messageEntry("user", "把这批配置都改一遍"),
    messageEntry("assistant", assistantWithTool("先问清楚范围。", "ask_user_question", { questions: [] })),
    toolResultEntry("ask_user_question", answer),
    messageEntry("assistant", [{ type: "text", text: "好，那先不动。" }]),
  ], OPTIONS);

  assert.ok(snapshot);
  assert.deepEqual(snapshot.userAnswers, [answer]);
  assert.equal(snapshot.userRequest, "把这批配置都改一遍");
});

test("只收提问工具的回答，且只取最后一条真实用户消息之后的", () => {
  const oldAnswer = askUserAnswer("上一轮的回答");
  const newAnswer = askUserAnswer("这一轮的回答");
  const snapshot = collectTurnSnapshot([
    messageEntry("user", "上一轮请求"),
    toolResultEntry("ask_user_question", oldAnswer),
    messageEntry("assistant", [{ type: "text", text: "上一轮结束。" }]),
    messageEntry("user", "这一轮请求"),
    // 其它工具的结果看起来像用户输入也不是用户输入，不能混进来。
    toolResultEntry("bash", "用户输入：随便写点东西"),
    toolResultEntry("ask_user_question", newAnswer),
    messageEntry("assistant", [{ type: "text", text: "这一轮结束。" }]),
  ], OPTIONS);

  assert.ok(snapshot);
  assert.deepEqual(snapshot.userAnswers, [newAnswer]);
});

test("用户回答按配置长度截断，空回答不入快照", () => {
  const snapshot = collectTurnSnapshot([
    messageEntry("user", "任务"),
    toolResultEntry("ask_user_question", "0123456789"),
    toolResultEntry("ask_user_question", "   "),
  ], { ...OPTIONS, maxUserAnswerChars: 3 });

  assert.ok(snapshot);
  assert.equal(snapshot.userAnswers.length, 1);
  assert.match(snapshot.userAnswers[0], /^012\n/);
  assert.match(snapshot.userAnswers[0], /已截断 7 字符/);
});

test("扩展注入的催促消息不会被当成用户请求", () => {
  const snapshot = collectTurnSnapshot([
    messageEntry("user", "实现登录并补测试"),
    messageEntry("assistant", [{ type: "text", text: "登录做完了。" }]),
    // 催促是 custom 角色的消息，不是用户输入。
    messageEntry("custom", "【自动监督】你在任务中途停下了。"),
    messageEntry("assistant", [{ type: "text", text: "测试还没补。" }]),
  ], OPTIONS);

  assert.ok(snapshot);
  assert.equal(snapshot.userRequest, "实现登录并补测试");
  assert.equal(snapshot.finalOutput, "测试还没补。");
});

test("找不到真实用户消息时返回 undefined", () => {
  assert.equal(collectTurnSnapshot([
    messageEntry("assistant", [{ type: "text", text: "好的" }]),
  ], OPTIONS), undefined);
  assert.equal(collectTurnSnapshot([], OPTIONS), undefined);
  assert.equal(collectTurnSnapshot([
    messageEntry("user", "   "),
  ], OPTIONS), undefined);
});

test("工具轨迹按开关关闭，并按上限只保留最后若干条", () => {
  const entries = [
    messageEntry("user", "多步任务"),
    messageEntry("assistant", assistantWithTool("", "read", { path: "1.ts" })),
    messageEntry("assistant", assistantWithTool("", "edit", { path: "1.ts" })),
    messageEntry("assistant", assistantWithTool("", "bash", { command: "npm test" })),
  ];

  const disabled = collectTurnSnapshot(entries, { ...OPTIONS, includeToolTrace: false });
  assert.deepEqual(disabled?.toolTrace, []);
  // 关掉轨迹时明确标出来源为空，提示词不会把「没收集」说成「本轮没有工具调用」。
  assert.equal(disabled?.toolTraceOmitted, true);

  const limited = collectTurnSnapshot(entries, { ...OPTIONS, maxToolTraceEntries: 2 });
  assert.equal(limited?.toolTrace.length, 2);
  assert.equal(limited?.toolTraceOmitted, false);
  assert.match(limited?.toolTrace[0] ?? "", /edit/);
  assert.match(limited?.toolTrace[1] ?? "", /npm test/);

  const none = collectTurnSnapshot(entries, { ...OPTIONS, maxToolTraceEntries: 0 });
  assert.deepEqual(none?.toolTrace, []);
});

test("用户请求与最后输出按配置长度截断", () => {
  const snapshot = collectTurnSnapshot([
    messageEntry("user", "0123456789"),
    messageEntry("assistant", [{ type: "text", text: "abcdefghij" }]),
  ], { ...OPTIONS, maxUserRequestChars: 3, maxFinalOutputChars: 4 });

  assert.ok(snapshot);
  assert.match(snapshot.userRequest, /^012\n/);
  assert.match(snapshot.finalOutput, /^abcd\n/);
});

test("assistant 只有工具调用没有文本时，最后输出为空字符串", () => {
  const snapshot = collectTurnSnapshot([
    messageEntry("user", "任务"),
    messageEntry("assistant", [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }]),
  ], OPTIONS);

  assert.ok(snapshot);
  assert.equal(snapshot.finalOutput, "");
});

/** 构造一条带结束原因的 session 消息条目。 */
function assistantEntry(stopReason?: string): { type: string; message: { role: string; content: unknown; stopReason?: string } } {
  return { type: "message", message: { role: "assistant", content: [], stopReason } };
}

test("读取最后一条 assistant 的结束原因，用于区分「被取消」与「自己停下」", () => {
  assert.equal(readLastAssistantStopReason([
    messageEntry("user", "任务"),
    assistantEntry("stop"),
    assistantEntry("aborted"),
  ]), "aborted");

  assert.equal(readLastAssistantStopReason([
    messageEntry("user", "任务"),
    assistantEntry("aborted"),
    messageEntry("user", "又来一轮"),
    assistantEntry("stop"),
  ]), "stop");

  // 没有结束原因的 assistant（例如流式中断留下的残缺消息）不能当成取消。
  assert.equal(readLastAssistantStopReason([assistantEntry(undefined)]), undefined);
  assert.equal(readLastAssistantStopReason([messageEntry("user", "任务")]), undefined);
  assert.equal(readLastAssistantStopReason([]), undefined);
});
