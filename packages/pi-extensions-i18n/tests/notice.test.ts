import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatNotice,
  notifyWithSource,
  type NoticeContext,
  type NoticeSource,
} from "../src/index.ts";

/** 测试用来源标签。 */
const SOURCE: NoticeSource = { tag: "naming", color: "accent" };

/** 测试用主题：把颜色名包成可断言的标记，不依赖真实 ANSI。 */
const THEME = {
  /** 把颜色名与文本包成 `<color>text</>`。 */
  fg: (color: string, text: string) => `<${color}>${text}</>`,
};

test("TUI 下给来源标签上色，消息正文保持原样", () => {
  const text = formatNotice({ source: SOURCE, message: "已重命名", mode: "tui", theme: THEME });
  assert.equal(text, "<accent>[naming]</> 已重命名");
});

test("非 TUI 模式与缺少主题时输出纯文本，避免 ANSI 乱码", () => {
  const plain = "[naming] 已重命名";
  assert.equal(formatNotice({ source: SOURCE, message: "已重命名", mode: "rpc", theme: THEME }), plain);
  assert.equal(formatNotice({ source: SOURCE, message: "已重命名", mode: "print", theme: THEME }), plain);
  assert.equal(formatNotice({ source: SOURCE, message: "已重命名", mode: undefined, theme: THEME }), plain);
  assert.equal(formatNotice({ source: SOURCE, message: "已重命名", mode: "tui", theme: undefined }), plain);
});

test("提示出口带上来源标签，并原样传递级别", () => {
  const seen: Array<{ message: string; level: string | undefined }> = [];
  const ctx: NoticeContext = {
    mode: "tui",
    ui: {
      notify: (message, level) => seen.push({ message, level }),
      theme: THEME,
    },
  };

  notifyWithSource({ ctx, source: SOURCE, level: "warning", message: "重命名失败" });
  assert.deepEqual(seen, [{ message: "<accent>[naming]</> 重命名失败", level: "warning" }]);
});

test("不同扩展用不同标签，同一扩展颜色固定", () => {
  const supervisor: NoticeSource = { tag: "supervisor", color: "toolTitle" };
  const first = formatNotice({ source: SOURCE, message: "x", mode: "tui", theme: THEME });
  const second = formatNotice({ source: SOURCE, message: "y", mode: "tui", theme: THEME });
  const other = formatNotice({ source: supervisor, message: "x", mode: "tui", theme: THEME });

  assert.match(first, /\[naming\]/);
  assert.match(other, /\[supervisor\]/);
  assert.match(first, /<accent>/);
  assert.match(other, /<toolTitle>/);
  assert.equal(first.replace("x", ""), second.replace("y", ""));
});
