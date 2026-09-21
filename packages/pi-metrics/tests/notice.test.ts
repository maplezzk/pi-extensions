import assert from "node:assert/strict";
import test from "node:test";
import { formatNotice } from "pi-extensions-i18n";
import { NOTICE_COLOR, NOTICE_SOURCE, NOTICE_TAG } from "../src/notice.ts";

test("metrics notice source uses a stable tag and the shared muted label color", () => {
  assert.equal(NOTICE_TAG, "metrics");
  assert.equal(NOTICE_COLOR, "muted");
  assert.deepEqual(NOTICE_SOURCE, { tag: "metrics", color: "muted" });
});

test("non-TUI notice renders the metrics tag without ANSI escapes", () => {
  const text = formatNotice({
    source: NOTICE_SOURCE,
    message: "本轮耗时 12.3s",
    mode: "print",
    theme: undefined,
  });
  assert.equal(text, "[metrics] 本轮耗时 12.3s");
  assert.ok(!text.includes("\u001b["), "非 TUI 输出不应包含 ANSI 序列");
});
