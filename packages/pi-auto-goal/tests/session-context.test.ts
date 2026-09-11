import assert from "node:assert/strict";
import { test } from "node:test";
import { collectTurnSnapshot, getTextContent, truncateText, type TurnSnapshotOptions } from "../src/session-context.ts";

/** 默认测试参数：足够大，避免无关注释。 */
const OPTIONS: TurnSnapshotOptions = {
  maxUserRequestChars: 1000,
  maxFinalOutputChars: 1000,
  maxToolTraceEntries: 10,
  includeToolTrace: true,
};

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
});

test("扩展注入的催促消息不会被当成用户请求", () => {
  const injected = i18nLikeContinueMessage();
  const snapshot = collectTurnSnapshot([
    messageEntry("user", "实现登录并补测试"),
    messageEntry("assistant", [{ type: "text", text: "登录做完了。" }]),
    messageEntry("user", injected),
    messageEntry("assistant", [{ type: "text", text: "测试还没补。" }]),
  ], { ...OPTIONS, injectedUserTexts: new Set([injected]) });

  assert.ok(snapshot);
  assert.equal(snapshot.userRequest, "实现登录并补测试");
  assert.equal(snapshot.finalOutput, "测试还没补。");
});

/** 模拟一条本扩展发出的催促消息文本。 */
function i18nLikeContinueMessage(): string {
  return "你停下来了，但这一轮任务并没有完成：还缺回归测试。";
}

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

  const limited = collectTurnSnapshot(entries, { ...OPTIONS, maxToolTraceEntries: 2 });
  assert.equal(limited?.toolTrace.length, 2);
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
