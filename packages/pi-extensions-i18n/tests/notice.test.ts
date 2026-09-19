import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  formatNotice,
  hasNoticeRenderer,
  installNoticeRenderer,
  notifyWithSource,
  renderNoticeEntry,
  resetNoticeRenderer,
  type NoticeApi,
  type NoticeContext,
  type NoticeEntryTheme,
  type NoticeSource,
} from "../src/index.ts";

/** 测试用来源标签。 */
const SOURCE: NoticeSource = { tag: "naming", color: "accent" };

/** 渲染宽度：足够宽，保证提示不被折行，断言只看内容（假主题的颜色标记也会被算进可见宽度）。 */
const RENDER_WIDTH = 120;

/** 测试用主题：把颜色名包成可断言的标记，不依赖真实 ANSI。 */
const THEME = {
  /** 把颜色名与文本包成 `<color>text</>`。 */
  fg: (color: string, text: string) => `<${color}>${text}</>`,
};

/** 测试用渲染主题：底色包成 `[bg:color]text[/bg]`。 */
const ENTRY_THEME: NoticeEntryTheme = {
  /** 把颜色名与文本包成 `<color>text</>`。 */
  fg: (color, text) => `<${color}>${text}</>`,
  /** 把底色名与文本包成 `[bg:color]text[/bg]`。 */
  bg: (color, text) => `[bg:${color}]${text}[/bg]`,
};

/** 假 Pi 能力的查询句柄：只暴露断言需要的信息，不暴露内部容器。 */
interface FakeApiHandle {
  /** 已写入的提示条目。 */
  entries(): unknown[];
  /** 已注册的渲染器数量。 */
  rendererCount(): number;
}

/**
 * 注入一套假 Pi 能力并跑一段断言，结束后一定清掉注入，避免影响后续测试。
 * 调用方只拿到查询句柄，不接触内部容器。
 */
function withFakeApi(run: (handle: FakeApiHandle) => void): void {
  const entries: unknown[] = [];
  const renderers = new Map<string, unknown>();
  const api: NoticeApi = {
    /** 记录条目写入，替代真实的会话写入。 */
    appendEntry: (customType, data) => {
      entries.push({ customType, data });
    },
    /** 记录渲染器注册，替代真实的 TUI 注册。 */
    registerEntryRenderer: (customType, renderer) => {
      renderers.set(customType, renderer);
    },
  };
  installNoticeRenderer(api);
  try {
    run({
      /** 已写入的提示条目。 */
      entries: () => entries,
      /** 已注册的渲染器数量。 */
      rendererCount: () => renderers.size,
    });
  } finally {
    resetNoticeRenderer();
  }
}

/** 记录 notify 调用的假 UI 上下文。 */
function createFakeCtx(mode: string): { ctx: NoticeContext; notices: Array<{ message: string; level?: string }> } {
  const notices: Array<{ message: string; level?: string }> = [];
  return {
    notices,
    ctx: {
      mode,
      ui: {
        /** 记录提示调用，替代真实的 UI 输出。 */
        notify: (message, level) => notices.push({ message, level }),
        theme: THEME,
      },
    },
  };
}

/** 渲染一个提示条目并拼成单行文本，便于断言。 */
function renderNoticeLines(data: unknown, expanded = false): string {
  return renderNoticeEntry({ data }, ENTRY_THEME, expanded).render(RENDER_WIDTH).join("\n");
}

/** 去掉底色包装后的非空内容行：用来核对提示块没有多余留白行。 */
function noticeContentLines(data: unknown, expanded = false): string[] {
  return renderNoticeEntry({ data }, ENTRY_THEME, expanded)
    .render(RENDER_WIDTH)
    .map((line) => line.replace(/\[bg:[^\]]*\]/g, "").replace(/\[\/bg\]/g, "").trim())
    .filter((line) => line !== "");
}

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

test("TUI 下提示写进会话条目，不再是一行纯文本", () => {
  withFakeApi((handle) => {
    const { ctx, notices } = createFakeCtx("tui");
    notifyWithSource({
      ctx,
      source: SOURCE,
      level: "warning",
      message: "重命名失败",
      details: ["理由：文件名非法"],
    });

    assert.deepEqual(handle.entries(), [
      {
        customType: "pi-extensions-notice",
        data: {
          tag: "naming",
          color: "accent",
          level: "warning",
          message: "重命名失败",
          textColor: undefined,
          details: ["理由：文件名非法"],
        },
      },
    ]);
    assert.deepEqual(notices, []);
    assert.equal(hasNoticeRenderer(), true);
    assert.equal(handle.rendererCount(), 1);
  });
});

test("提示条目渲染成带底色的消息块：标签带来源色、正文按级别上色", () => {
  const lines = renderNoticeLines({ tag: "naming", color: "accent", level: "info", message: "已重命名" });

  assert.match(lines, /\[bg:customMessageBg\]/);
  assert.match(lines, /<accent>\[naming\]<\/>/);
  assert.match(lines, /<customMessageText>已重命名<\/>/);
});

test("warning/error 级别用黄色/红色正文，语义色覆盖优先", () => {
  const warning = renderNoticeLines({ tag: "safety", color: "warning", level: "warning", message: "被拦截" });
  const failed = renderNoticeLines({ tag: "safety", color: "warning", level: "error", message: "被拦截" });
  const overridden = renderNoticeLines({
    tag: "auto-goal",
    color: "accent",
    level: "info",
    message: "已打断，未判定",
    textColor: "dim",
  });

  assert.match(warning, /<warning>被拦截<\/>/);
  assert.match(failed, /<error>被拦截<\/>/);
  assert.match(overridden, /<dim>已打断，未判定<\/>/);
});

test("有细节行的提示在行尾带展开箭头，展开后箭头反向", () => {
  /** 一条判定结论：正文一行，理由放在细节里。 */
  const entry = { tag: "auto-goal", color: "warning", level: "info", message: "⚖️ 判定可停止", details: ["理由：已完成"] };
  const collapsed = renderNoticeLines(entry);
  const expanded = renderNoticeLines(entry, true);

  // 收起用右三角、展开用下三角；强调色是为了让箭头不被 dim 正文吃掉。
  assert.match(collapsed, /<accent>▶<\/\>/);
  assert.doesNotMatch(collapsed, /▼/);
  assert.match(expanded, /<accent>▼<\/\>/);
  assert.doesNotMatch(expanded, /▶/);
  // 不再写按键提示：两种模式区分不出来，箭头才是两种模式下都成立的说法。
  assert.doesNotMatch(collapsed, /Ctrl\+O/);
  // 提示仍然只占一行：加了箭头也不能把会话顶满。
  assert.equal(renderNoticeEntry({ data: entry }, ENTRY_THEME, false).render(RENDER_WIDTH).length, 1);
});

test("没有细节行的提示不带展开箭头，不会指一个点了没反应的入口", () => {
  const lines = renderNoticeLines({ tag: "naming", color: "accent", level: "info", message: "已重命名" });

  assert.doesNotMatch(lines, /[▶▼]/);
  assert.match(lines, /<customMessageText>已重命名<\/\>/);
});

test("提示块不留上下空白，细节行只在展开时显示", () => {
  /** 一次判定结论的细节行：收起时不应出现，展开时应逐行追加。 */
  const details = ["理由：用户只是打招呼", "判定模型：llm-proxy/LOW"];
  const entry = { tag: "auto-goal", color: "accent", level: "info", message: "⚖️ 判定可停止 · 置信度 92%", details };
  const collapsed = renderNoticeLines(entry);
  const expanded = renderNoticeLines(entry, true);

  // 收起时只有正文，细节行不占屏。
  assert.doesNotMatch(collapsed, /理由/);
  // 展开时追加 dim 细节行。
  assert.match(expanded, /<dim>理由：用户只是打招呼<\/>/);
  assert.match(expanded, /<dim>判定模型：llm-proxy\/LOW<\/>/);
  // 每一行渲染行都有内容：提示块没有上下留白行。
  assert.equal(renderNoticeEntry({ data: entry }, ENTRY_THEME, false).render(RENDER_WIDTH).length, noticeContentLines(entry).length);
});

/** 点击测试用宽度：假主题的标记也会被算作可见字符，宽一点保证不折行。 */
const CLICK_RENDER_WIDTH = 200;

/** 构造一次左键点击事件；坐标与尺寸对断言无影响。 */
function clickEvent(): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: CLICK_RENDER_WIDTH,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

/** 把一次左键点击派发给提示块：全屏模式下走的就是这条路径。 */
function clickNotice(component: Component): void {
  component.handleMouse?.(clickEvent());
}

/** 测试用带细节行的条目：能点击展开的那种。 */
const DETAILED_ENTRY = {
  tag: "auto-goal",
  color: "warning",
  level: "info",
  message: "⚖️ 判定可停止",
  details: ["理由：已完成"],
};

test("全屏模式下点击提示块展开细节，再点一次收起", () => {
  const component = renderNoticeEntry({ data: DETAILED_ENTRY }, ENTRY_THEME, false);
  // 默认收起：只有一行，理由不占屏。
  assert.equal(component.render(CLICK_RENDER_WIDTH).length, 1);
  assert.doesNotMatch(component.render(CLICK_RENDER_WIDTH).join("\n"), /理由/);

  clickNotice(component);
  assert.match(component.render(CLICK_RENDER_WIDTH).join("\n"), /<dim>理由：已完成<\/>/);

  clickNotice(component);
  assert.equal(component.render(CLICK_RENDER_WIDTH).length, 1);
});

test("没有细节行的提示块不接管点击，避免无意义的交互", () => {
  const component = renderNoticeEntry(
    { data: { tag: "naming", color: "accent", level: "info", message: "已重命名" } },
    ENTRY_THEME,
    false,
  );
  assert.equal(component.handleMouse, undefined);
});

test("全局 Ctrl+O 已展开时，点击可以单独收起这一条", () => {
  const component = renderNoticeEntry({ data: DETAILED_ENTRY }, ENTRY_THEME, true);
  assert.match(component.render(CLICK_RENDER_WIDTH).join("\n"), /理由：已完成/);

  clickNotice(component);
  assert.equal(component.render(CLICK_RENDER_WIDTH).length, 1);
});

test("空细节行被丢弃，展开也不会出现空气泡", () => {
  const lines = renderNoticeLines(
    { tag: "distill", color: "muted", level: "info", message: "正文", details: ["", "   "] },
    true,
  );
  assert.doesNotMatch(lines, /<dim>/);
  assert.equal(
    renderNoticeEntry(
      { data: { tag: "distill", color: "muted", level: "info", message: "正文", details: ["", "   "] } },
      ENTRY_THEME,
      true,
    ).render(RENDER_WIDTH).length,
    1,
  );
});

test("条目数据缺字段或类型不符时给可读兜底，不抛出异常", () => {
  const wrongTypes = renderNoticeLines({ tag: 42, color: "nope", level: "nope" });
  assert.match(wrongTypes, /<muted>\[notice\]<\/>/);
  assert.match(wrongTypes, /\[bg:customMessageBg\]/);

  const missing = renderNoticeEntry(undefined, ENTRY_THEME).render(RENDER_WIDTH).join("\n");
  assert.match(missing, /\[notice\]/);
});

test("非 TUI 模式仍走 ui.notify，保持 RPC/print 行为不变", () => {
  withFakeApi((handle) => {
    for (const mode of ["rpc", "print", "json"]) {
      const { ctx, notices } = createFakeCtx(mode);
      notifyWithSource({ ctx, source: SOURCE, level: "warning", message: "重命名失败" });
      // 非 TUI 模式不加 ANSI，避免前端出现乱码。
      assert.deepEqual(notices, [{ message: "[naming] 重命名失败", level: "warning" }]);
    }
    assert.deepEqual(handle.entries(), []);
  });
});

test("未注入提示出口时退回 ui.notify，提示不会丢失", () => {
  resetNoticeRenderer();
  const { ctx, notices } = createFakeCtx("tui");
  notifyWithSource({ ctx, source: SOURCE, level: "info", message: "已重命名" });
  // TUI 但无渲染器时仍带标签色（旧行为），不会丢提示。
  assert.deepEqual(notices, [{ message: "<accent>[naming]</> 已重命名", level: "info" }]);
});

test("条目写入失败时退回 ui.notify，而不是抛给调用方", () => {
  const failing: NoticeApi = {
    /** 模拟会话已不可写的场景。 */
    appendEntry: () => {
      throw new Error("session is gone");
    },
    /** 注册在这里没有意义，留空实现。 */
    registerEntryRenderer: () => {},
  };
  installNoticeRenderer(failing);
  try {
    const { ctx, notices } = createFakeCtx("tui");
    notifyWithSource({ ctx, source: SOURCE, level: "info", message: "已重命名" });
    assert.deepEqual(notices, [{ message: "<accent>[naming]</> 已重命名", level: "info" }]);
  } finally {
    resetNoticeRenderer();
  }
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
