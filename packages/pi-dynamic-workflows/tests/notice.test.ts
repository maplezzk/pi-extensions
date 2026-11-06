import assert from "node:assert/strict";
import test from "node:test";
import { formatNotice, notifyWithSource, type NoticeContext } from "pi-extensions-i18n";
import { NOTICE_COLOR, NOTICE_SOURCE, NOTICE_TAG } from "../src/notice.ts";

test("workflow notice source uses a stable tag and the shared muted label color", () => {
  assert.equal(NOTICE_TAG, "workflow");
  assert.equal(NOTICE_COLOR, "muted");
  assert.deepEqual(NOTICE_SOURCE, { tag: "workflow", color: "muted" });
});

test("non-TUI notice renders the workflow tag without ANSI escapes", () => {
  const text = formatNotice({
    source: NOTICE_SOURCE,
    message: "workflow started",
    mode: "print",
    theme: undefined,
  });
  assert.equal(text, "[workflow] workflow started");
  assert.ok(!text.includes("\u001b["), "非 TUI 输出不应包含 ANSI 序列");
});

test("notifyWithSource prefixes the tag and preserves the level", () => {
  const seen: Array<{ message: string; level: string | undefined }> = [];
  const ctx: NoticeContext = {
    mode: "tui",
    ui: {
      notify: (message, level) => seen.push({ message, level }),
      // 测试用主题：把颜色名包成可断言的标记，不依赖真实 ANSI。
      theme: { fg: (color, text) => `<${color}>${text}</>` },
    },
  };

  notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: "workflow failed" });
  assert.deepEqual(seen, [{ message: "<muted>[workflow]</> workflow failed", level: "warning" }]);
});
