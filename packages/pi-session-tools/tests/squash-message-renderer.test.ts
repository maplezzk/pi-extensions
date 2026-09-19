import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  renderSquashMessage,
  registerSquashMessageRenderer,
} from "../src/squash-message-renderer.ts";
import {
  SESSION_SQUASH_TYPE,
  stripContinuationInstruction,
} from "../src/session-tail-compaction-utils.ts";

/** 固定中文，避免断言跟着本机 locale 变；i18n 在渲染时读这个变量。 */
process.env.PI_EXTENSIONS_LOCALE = "zh-CN";
/** 展开态用 Pi 的 markdown 主题，需要先初始化一次。 */
initTheme();

/** 渲染宽度：足够宽，保证头部不被折行。 */
const RENDER_WIDTH = 100;

/** 测试用主题：把颜色名包成可断言的标记，不依赖真实 ANSI。 */
const THEME = {
  /** 把颜色名与文本包成 `<color>text</>`。 */
  fg: (color: string, text: string) => `<${color}>${text}</>`,
  /** 把底色名与文本包成 `[bg:color]text[/bg]`。 */
  bg: (color: string, text: string) => `[bg:${color}]${text}[/bg]`,
  /** markdown 主题会用到加粗。 */
  bold: (text: string) => text,
};

/** 摘要里只给接手模型看的指令段（落盘时位于正文之前）。 */
const INSTRUCTION = "【任务状态快照】以下是压缩历史后的当前任务状态，不是新的用户需求。";

/** 给用户看的任务状态正文。 */
const SNAPSHOT = [
  "# Handoff: 修复折叠",
  "## Current focus",
  "继续核对渲染。",
].join("\n");

/** 落盘 summary 的完整文本：指令 + 空行 + 正文。 */
const FULL_SUMMARY = `${INSTRUCTION}\n\n${SNAPSHOT}`;

/** 构造一条 session_squash 自定义消息（字段与 Pi 的 CustomMessage 一致）。 */
function squashMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    role: "custom",
    customType: SESSION_SQUASH_TYPE,
    content: FULL_SUMMARY,
    display: true,
    timestamp: 0,
    details: {
      startEntryId: "u1",
      sourceLeafId: "a9",
      fromUserInputIndex: 3,
      summary: FULL_SUMMARY,
      tokensBefore: 41400,
    },
    ...overrides,
  };
}

/** 走一遍渲染器并拿到组件；返回 undefined 表示渲染器主动交回默认渲染。 */
function renderComponent(message: unknown, expanded = false): Component | undefined {
  return renderSquashMessage(
    message as never,
    { expanded, outputPad: 1 } as never,
    THEME as never,
  ) as Component | undefined;
}

/** 渲染成行并去掉底色包装，便于断言内容。 */
function renderText(message: unknown, expanded = false): string {
  const component = renderComponent(message, expanded);
  assert.ok(component, "expected the squash renderer to produce a component");
  return component
    .render(RENDER_WIDTH)
    .join("\n")
    .replace(/\[bg:[^\]]*\]/g, "")
    .replace(/\[\/bg\]/g, "");
}

test("默认收起：只留一行状态，压缩正文不占屏幕", () => {
  const component = renderComponent(squashMessage());
  assert.ok(component);
  const lines = component.render(RENDER_WIDTH);
  const text = lines.join("\n");

  assert.match(text, /压缩快照/);
  assert.match(text, /从 #3 起/);
  assert.match(text, /41\.4k tokens/);
  assert.match(text, /Ctrl\+O 展开/);
  // 收起态不该出现快照正文，也不该出现只给模型的指令段。
  assert.doesNotMatch(text, /Handoff: 修复折叠/);
  assert.doesNotMatch(text, /不是新的用户需求/);
  // 真正有内容的行只有一行，压缩前的最后一条回答才不会被顶出视野。
  const contentLines = lines
    .map((line) => line.replace(/\[bg:[^\]]*\]/g, "").replace(/\[\/bg\]/g, "").trim())
    .filter((line) => line !== "");
  assert.equal(contentLines.length, 1);
});

test("展开后显示任务状态正文，剥掉只给模型的指令段", () => {
  const text = renderText(squashMessage(), true);

  assert.match(text, /Handoff: 修复折叠/);
  assert.match(text, /Current focus/);
  assert.match(text, /Ctrl\+O 收起/);
  assert.doesNotMatch(text, /不是新的用户需求/);
});

test("点击同一行可以在收起与展开之间切换", () => {
  const component = renderComponent(squashMessage()) as Component & {
    handleMouse?: (event: unknown) => unknown;
  };
  assert.equal(typeof component.handleMouse, "function");

  assert.doesNotMatch(component.render(RENDER_WIDTH).join("\n"), /Handoff: 修复折叠/);
  component.handleMouse?.({ type: "click", button: "left" });
  assert.match(component.render(RENDER_WIDTH).join("\n"), /Handoff: 修复折叠/);
  component.handleMouse?.({ type: "click", button: "left" });
  assert.doesNotMatch(component.render(RENDER_WIDTH).join("\n"), /Handoff: 修复折叠/);
});

test("details 不是压缩数据时交回 Pi 的默认渲染", () => {
  assert.equal(renderComponent(squashMessage({ details: undefined })), undefined);
  assert.equal(renderComponent(squashMessage({ details: { summary: "x" } })), undefined);
});

test("指令段剥离支持中英两种标记，且不动自由格式摘要", () => {
  assert.equal(
    stripContinuationInstruction("[Task state snapshot] body\n\n# Handoff: x"),
    "# Handoff: x",
  );
  assert.equal(stripContinuationInstruction(FULL_SUMMARY), SNAPSHOT);
  assert.equal(stripContinuationInstruction("任意格式的摘要"), "任意格式的摘要");
});

test("注册渲染器：有 API 时注册，缺失时安静降级", () => {
  const registered: Array<{ type: string; renderer: unknown }> = [];
  registerSquashMessageRenderer({
    registerMessageRenderer: (type: string, renderer: unknown) => {
      registered.push({ type, renderer });
    },
  } as never);

  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.type, SESSION_SQUASH_TYPE);
  assert.equal(registered[0]?.renderer, renderSquashMessage);
  assert.doesNotThrow(() => registerSquashMessageRenderer({} as never));
});
