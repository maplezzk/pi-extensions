import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  computeFileLists,
  ensureHandoffTimeline,
  extractFileOps,
  formatContextPercentage,
  formatConversationTimeline,
  formatFileOperations,
  formatPercentage,
  formatThreshold,
  formatTokens,
  getTailCompactions,
  listSquashCandidates,
  listUserInputs,
  parseSquashThresholds,
  resolveThresholdTokens,
  SESSION_SQUASH_FORCE_TYPE,
  SESSION_SQUASH_HINT_TYPE,
  SESSION_SQUASH_TYPE,
  TAIL_START_ERROR,
  thresholdKey,
  validateTailStart,
} from "../src/session-tail-compaction-utils.ts";

/** 构造一条 message entry 测试数据。 */
function message(input: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
}): SessionEntry {
  const { id, parentId, role, content } = input;
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-01-01T00:00:${id}Z`,
    message:
      role === "user"
        ? { role, content, timestamp: 1 }
        : {
            role,
            content: [{ type: "text", text: content }],
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
            timestamp: 1,
          },
  } as SessionEntry;
}

/** 构造一条已应用折叠的 custom_message entry 测试数据。 */
function tailFoldMessage(input: {
  id: string;
  parentId: string;
  startEntryId: string;
  sourceLeafId: string;
  fromUserInputIndex: number;
}): SessionEntry {
  const { id, parentId, startEntryId, sourceLeafId, fromUserInputIndex } = input;
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:10.000Z",
    customType: SESSION_SQUASH_TYPE,
    content: "## Review 摘要\n- 已完成 review",
    display: true,
    details: {
      startEntryId,
      sourceLeafId,
      fromUserInputIndex,
      summary: "## Review 摘要\n- 已完成 review",
      tokensBefore: 100,
    },
  };
}

test("只列出 user message，并为未完成的尾部输入标记 complete=false", () => {
  const branch = [
    message({ id: "01", parentId: null, role: "user", content: "分析需求" }),
    message({ id: "02", parentId: "01", role: "assistant", content: "已分析" }),
    message({ id: "03", parentId: "02", role: "user", content: "进行 review" }),
  ];

  assert.deepEqual(listUserInputs(branch, "[图片]"), [
    { index: 0, entryId: "01", content: "分析需求", complete: true },
    { index: 1, entryId: "03", content: "进行 review", complete: false },
  ]);
});

test("图片内容块使用调用方传入的占位符", () => {
  const branch = [
    {
      type: "message",
      id: "01",
      parentId: null,
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这张图" },
          { type: "image", mime: "image/png" },
        ],
        timestamp: 1,
      },
    } as SessionEntry,
  ];

  const inputs = listUserInputs(branch, "[image]");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.content, "看这张图\n[image]");
});

test("能够从 active branch 读取真正的 fold custom message", () => {
  const branch = [
    message({ id: "01", parentId: null, role: "user", content: "实现代码" }),
    message({ id: "02", parentId: "01", role: "assistant", content: "完成" }),
    message({ id: "03", parentId: "02", role: "user", content: "review" }),
    tailFoldMessage({
      id: "04",
      parentId: "03",
      startEntryId: "03",
      sourceLeafId: "02",
      fromUserInputIndex: 1,
    }),
  ];

  const folds = getTailCompactions(branch);
  assert.equal(folds.length, 1);
  assert.equal(folds[0]?.data.fromUserInputIndex, 1);
  assert.equal(folds[0]?.data.sourceLeafId, "02");
});

test("已有后缀折叠时，允许从更早索引重新压缩", () => {
  const branch = [
    message({ id: "01", parentId: null, role: "user", content: "实现代码" }),
    message({ id: "02", parentId: "01", role: "assistant", content: "完成" }),
    message({ id: "03", parentId: "02", role: "user", content: "review" }),
    tailFoldMessage({
      id: "04",
      parentId: "03",
      startEntryId: "03",
      sourceLeafId: "02",
      fromUserInputIndex: 1,
    }),
    message({ id: "05", parentId: "04", role: "user", content: "下一项任务" }),
    message({ id: "06", parentId: "05", role: "assistant", content: "继续" }),
  ];

  const inputs = listUserInputs(branch, "[图片]");
  assert.equal(validateTailStart(inputs, 0).ok, true);
  assert.equal(validateTailStart(inputs, 1).ok, true);
  assert.equal(validateTailStart(inputs, 2).ok, true);
});

/** 已用过的 user anchor 仍可覆盖快照后的自动续接内容。 */
test("session_log 保留已压缩起点并维持原索引", () => {
  const branch = [
    message({ id: "01", parentId: null, role: "user", content: "实现代码" }),
    message({ id: "02", parentId: "01", role: "assistant", content: "完成" }),
    message({ id: "03", parentId: "02", role: "user", content: "review" }),
    tailFoldMessage({
      id: "04",
      parentId: "03",
      startEntryId: "03",
      sourceLeafId: "02",
      fromUserInputIndex: 1,
    }),
    message({
      id: "05",
      parentId: "04",
      role: "assistant",
      content: "压缩后自动续接",
    }),
    message({ id: "06", parentId: "05", role: "user", content: "下一项任务" }),
    message({ id: "07", parentId: "06", role: "assistant", content: "继续" }),
  ];

  assert.deepEqual(listSquashCandidates(branch, "[图片]"), [
    { index: 0, entryId: "01", content: "实现代码", complete: true },
    { index: 1, entryId: "03", content: "review", complete: true },
    { index: 2, entryId: "06", content: "下一项任务", complete: true },
  ]);
});

test("validateTailStart 对不存在与未完成的索引返回对应错误码", () => {
  const branch = [
    message({ id: "01", parentId: null, role: "user", content: "实现代码" }),
    message({ id: "02", parentId: "01", role: "assistant", content: "完成" }),
    message({ id: "03", parentId: "02", role: "user", content: "未完任务" }),
  ];
  const inputs = listUserInputs(branch, "[图片]");

  const notFound = validateTailStart(inputs, 5);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.code, TAIL_START_ERROR.inputNotFound);
  assert.equal(notFound.from, 5);

  const incomplete = validateTailStart(inputs, 1);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, TAIL_START_ERROR.inputIncomplete);
  assert.equal(incomplete.from, 1);
});

test("提示与强制消息类型均和压缩摘要类型不同", () => {
  assert.equal(SESSION_SQUASH_HINT_TYPE, "session-squash-hint");
  assert.equal(SESSION_SQUASH_FORCE_TYPE, "session-squash-force");
  assert.notEqual(SESSION_SQUASH_HINT_TYPE, SESSION_SQUASH_TYPE);
  assert.notEqual(SESSION_SQUASH_FORCE_TYPE, SESSION_SQUASH_TYPE);
});

test("parseSquashThresholds 支持数字、百分比和数字字符串混合", () => {
  assert.deepEqual(parseSquashThresholds([150000, "75%", "200000"]), [
    { kind: "tokens", value: 150000 },
    { kind: "percent", value: 75 },
    { kind: "tokens", value: 200000 },
  ]);
});

test("parseSquashThresholds 支持 k 后缀与小数 k", () => {
  assert.deepEqual(parseSquashThresholds(["150k", "1.5k", "200K"]), [
    { kind: "tokens", value: 150000 },
    { kind: "tokens", value: 1500 },
    { kind: "tokens", value: 200000 },
  ]);
});

test("parseSquashThresholds 跳过非法元素，非数组返回空", () => {
  assert.deepEqual(parseSquashThresholds([0, -1, "abc", "101%", null, "0%"]), []);
  assert.deepEqual(parseSquashThresholds("150000"), []);
  assert.deepEqual(parseSquashThresholds(undefined), []);
});

test("resolveThresholdTokens 按类型换算", () => {
  assert.equal(
    resolveThresholdTokens({ kind: "tokens", value: 150000 }, 200000),
    150000,
  );
  assert.equal(
    resolveThresholdTokens({ kind: "percent", value: 75 }, 200000),
    150000,
  );
});

test("thresholdKey 区分类型", () => {
  assert.equal(thresholdKey({ kind: "tokens", value: 75 }), "tokens:75");
  assert.equal(thresholdKey({ kind: "percent", value: 75 }), "percent:75");
  assert.notEqual(
    thresholdKey({ kind: "tokens", value: 75 }),
    thresholdKey({ kind: "percent", value: 75 }),
  );
});

test("formatTokens 大数字缩写为 k", () => {
  assert.equal(formatTokens(150000), "150k");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(999), "999");
});

test("百分比格式最多保留一位小数", () => {
  assert.equal(formatPercentage(76.54), "76.5%");
  assert.equal(formatContextPercentage(153000, 200000), "76.5%");
  assert.equal(formatContextPercentage(150000, 200000), "75%");
  assert.equal(formatContextPercentage(100, 0), "0%");
});

test("formatThreshold 序列化 k 与百分比，与 parse 可回环", () => {
  assert.equal(formatThreshold({ kind: "tokens", value: 150000 }), "150k");
  assert.equal(formatThreshold({ kind: "percent", value: 75 }), "75%");
  // 回环：150k → 150000 → 150k
  const parsed = parseSquashThresholds(["150k", "75%"]);
  assert.deepEqual(parsed.map(formatThreshold), ["150k", "75%"]);
});

/** 构造一条带 toolCall 块的 assistant message entry。 */
function assistantWithToolCalls(
  id: string,
  calls: Array<{ name: string; path: string }>,
  text = "done",
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: `2026-01-01T00:00:${id}Z`,
    message: {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...calls.map((call) => ({
          type: "toolCall",
          name: call.name,
          arguments: { path: call.path },
        })),
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
      timestamp: 1,
    },
  } as SessionEntry;
}

test("formatConversationTimeline 忽略工具调用并保留 Agent 文本", () => {
  const entries: SessionEntry[] = [
    message({ id: "01", parentId: null, role: "user", content: "排查问题" }),
    assistantWithToolCalls("02", [{ name: "read", path: "/a/read.ts" }], ""),
    assistantWithToolCalls(
      "03",
      [{ name: "edit", path: "/a/edited.ts" }],
      "已确认并修复问题",
    ),
  ];

  const timeline = formatConversationTimeline(entries, "[image]");
  assert.equal(
    timeline,
    "## Timeline of user and agent work\n- User: 排查问题\n- Agent: 已确认并修复问题",
  );
  assert.doesNotMatch(timeline, /tools:|\/a\/read\.ts|\/a\/edited\.ts/);
});

test("extractFileOps 从 assistant 工具调用提取 read/write/edit 路径", () => {
  const entries: SessionEntry[] = [
    message({ id: "01", parentId: null, role: "user", content: "改代码" }),
    assistantWithToolCalls("02", [
      { name: "read", path: "/a/read-only.ts" },
      { name: "write", path: "/a/written.ts" },
      { name: "edit", path: "/a/edited.ts" },
    ]),
  ];

  const ops = extractFileOps(entries);
  assert.deepEqual([...ops.read], ["/a/read-only.ts"]);
  assert.deepEqual([...ops.written], ["/a/written.ts"]);
  assert.deepEqual([...ops.edited], ["/a/edited.ts"]);
});

test("extractFileOps 忽略非 toolCall 块与无 path 的调用", () => {
  const entries: SessionEntry[] = [
    assistantWithToolCalls("02", [
      { name: "read", path: "/a/real.ts" },
      { name: "grep", path: "/a/grep.ts" },
    ]),
    {
      type: "message",
      id: "03",
      parentId: null,
      timestamp: "2026-01-01T00:00:03Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: {} },
          { type: "toolCall", name: "read", arguments: { path: 123 } },
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
        timestamp: 1,
      },
    } as SessionEntry,
  ];

  const ops = extractFileOps(entries);
  assert.deepEqual([...ops.read], ["/a/real.ts"]);
});

test("computeFileLists 合并 written/edited 为 modified，read 排除已改", () => {
  const ops = {
    read: new Set(["/a/only-read.ts", "/a/also-edited.ts"]),
    written: new Set(["/a/written.ts"]),
    edited: new Set(["/a/also-edited.ts", "/a/edited.ts"]),
  };
  const { readFiles, modifiedFiles } = computeFileLists(ops);
  assert.deepEqual(readFiles, ["/a/only-read.ts"]);
  assert.deepEqual(modifiedFiles, [
    "/a/also-edited.ts",
    "/a/edited.ts",
    "/a/written.ts",
  ]);
});

test("formatFileOperations 输出与 Pi 一致的 XML 块，空列表返回空串", () => {
  assert.equal(formatFileOperations([], []), "");
  assert.equal(
    formatFileOperations(["/a/r1.ts", "/a/r2.ts"], ["/a/m1.ts"]),
    "\n\n<read-files>\n/a/r1.ts\n/a/r2.ts\n</read-files>\n\n<modified-files>\n/a/m1.ts\n</modified-files>",
  );
  assert.equal(
    formatFileOperations([], ["/a/m1.ts"]),
    "\n\n<modified-files>\n/a/m1.ts\n</modified-files>",
  );
});

test("handoff 自动补充标题和时间线", () => {
  const entries: SessionEntry[] = [
    message({
      id: "u1",
      parentId: null,
      role: "user",
      content: "用户纠正了当前方向",
    }),
    message({
      id: "a1",
      parentId: "u1",
      role: "assistant",
      content: "已停止错误调查并核对现有数据",
    }),
  ];
  const timeline = formatConversationTimeline(entries, "[image]");
  assert.match(timeline, /^## Timeline of user and agent work\n- User: 用户纠正了当前方向\n- Agent: 已停止错误调查并核对现有数据$/);

  const prepared = ensureHandoffTimeline("任意格式的总结", entries, "[image]");
  assert.match(prepared, /^# Handoff: Session continuation\n\n## Timeline of user and agent work\n/);
  assert.ok(prepared.endsWith("任意格式的总结"));
});
