import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNotice } from "pi-extensions-i18n";
import { NOTICE_COLOR, NOTICE_SOURCE, NOTICE_TAG } from "../src/notice.ts";

/** 测试用主题：把颜色名与文本包成 `<color>text</>`，便于断言调用时用的颜色。 */
const THEME = {
  /** 把颜色名与文本包成标记，不依赖真实 ANSI。 */
  fg: (color: string, text: string) => `<${color}>${text}</>`,
};

test("提示来源固定为 auto-goal 标签与 warning 色", () => {
  assert.equal(NOTICE_TAG, "auto-goal");
  assert.equal(NOTICE_COLOR, "warning");
  assert.deepEqual(NOTICE_SOURCE, { tag: "auto-goal", color: "warning" });
});

test("TUI 下提示带来源标签并上标签色，非 TUI 下退化为纯文本", () => {
  const message = "已催促：只改了 1/5 个文件";
  assert.equal(
    formatNotice({ source: NOTICE_SOURCE, message, mode: "tui", theme: THEME }),
    `<warning>[auto-goal]</> ${message}`,
  );
  assert.equal(formatNotice({ source: NOTICE_SOURCE, message, mode: "rpc", theme: THEME }), `[auto-goal] ${message}`);
  assert.equal(formatNotice({ source: NOTICE_SOURCE, message, mode: "print", theme: THEME }), `[auto-goal] ${message}`);
});
