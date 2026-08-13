import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildSquashTaskPrompt,
  computeSquashDocPath,
  formatTokens,
  getTailCompactions,
  isInsideSquashDocDir,
  listUserInputs,
  parseSquashThresholds,
  resolveThresholdTokens,
  SESSION_SQUASH_HINT_TYPE,
  SESSION_SQUASH_TASK_TYPE,
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

test("已有后缀折叠时，不允许从旧范围内重新开始", () => {
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
  const rejected = validateTailStart(inputs, 1, branch);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, TAIL_START_ERROR.overlapWithExisting);
  assert.equal(rejected.from, 1);

  const accepted = validateTailStart(inputs, 2, branch);
  assert.equal(accepted.ok, true);
});

test("validateTailStart 对不存在与未完成的索引返回对应错误码", () => {
  const branch = [
    message({ id: "01", parentId: null, role: "user", content: "实现代码" }),
    message({ id: "02", parentId: "01", role: "assistant", content: "完成" }),
    message({ id: "03", parentId: "02", role: "user", content: "未完任务" }),
  ];
  const inputs = listUserInputs(branch, "[图片]");

  const notFound = validateTailStart(inputs, 5, branch);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.code, TAIL_START_ERROR.inputNotFound);
  assert.equal(notFound.from, 5);

  const incomplete = validateTailStart(inputs, 1, branch);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, TAIL_START_ERROR.inputIncomplete);
  assert.equal(incomplete.from, 1);
});

test("computeSquashDocPath 生成临时目录内的唯一交接文档路径", () => {
  const docPath = computeSquashDocPath("019f-xxxx-12345678-abcd", 3);
  assert.ok(docPath.startsWith(join(tmpdir(), "pi-session-tools")));
  assert.match(docPath, /squash-019fxxxx-from-3\.md$/);
});

test("isInsideSquashDocDir 只放行约定目录内的路径", () => {
  const inside = computeSquashDocPath("019f", 1);
  assert.equal(isInsideSquashDocDir(inside), true);

  assert.equal(isInsideSquashDocDir(join(tmpdir(), "other", "a.md")), false);
  assert.equal(
    isInsideSquashDocDir(join(tmpdir(), "pi-session-tools-extra", "a.md")),
    false,
  );
});

test("buildSquashTaskPrompt 替换 from/preview/docPath 占位符", () => {
  const prompt = buildSquashTaskPrompt(
    "从 {from} 开始，预览：{preview}，写入 {docPath}",
    { from: 2, preview: "分析需求", docPath: "/tmp/x.md" },
  );
  assert.equal(prompt, "从 2 开始，预览：分析需求，写入 /tmp/x.md");
});

test("SESSION_SQUASH_TASK_TYPE 与 SESSION_SQUASH_TYPE 不同", () => {
  assert.equal(SESSION_SQUASH_TASK_TYPE, "session-squash-task");
  assert.equal(SESSION_SQUASH_HINT_TYPE, "session-squash-hint");
  assert.notEqual(SESSION_SQUASH_TASK_TYPE, SESSION_SQUASH_TYPE);
  assert.notEqual(SESSION_SQUASH_HINT_TYPE, SESSION_SQUASH_TYPE);
});

test("parseSquashThresholds 支持数字、百分比和数字字符串混合", () => {
  assert.deepEqual(parseSquashThresholds([150000, "75%", "200000"]), [
    { kind: "tokens", value: 150000 },
    { kind: "percent", value: 75 },
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
