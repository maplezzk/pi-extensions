/**
 * session_squash 摘要消息的 TUI 渲染。
 *
 * 为什么需要单独注册渲染器：Pi 默认的 custom message 渲染不看 expanded，
 * 快照有多长就画多长。而压缩发生在轮次结束的位置，一份几 KB 的快照会把
 * 压缩前的最后一条回答顶出屏幕，用户想回看就得往前翻。
 *
 * 这里改成和 pi-extensions-i18n 提示块一致的行为：
 * - 默认只画一行状态（起点、压缩前 tokens、展开提示），最后一条回答留在视野里；
 * - Ctrl+O（app.tools.expand）或全屏模式下点击这一行，展开完整任务状态；
 * - 展开内容只画给用户看的任务状态正文，剥掉只给接手模型看的 continuation 指令段
 *   （指令仍保留在消息 content 里，模型上下文不受影响）。
 *
 * 只依赖结构化类型，便于独立测试；老版本 Pi 没有 registerMessageRenderer 或
 * pi-tui 太老没有 MouseRegion 时逐级降级（默认渲染 / 只用键盘展开）。
 */

import * as piTui from "@earendil-works/pi-tui";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";
import {
  formatTokens,
  readTailCompactionData,
  SESSION_SQUASH_TYPE,
  stripContinuationInstruction,
  type TailCompactionData,
} from "./session-tail-compaction-utils.ts";

/** 渲染只用到的前景色与底色能力；Pi 的 Theme 满足它。 */
interface SquashRenderTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

/** 摘要块的底色：与 Pi 自带的扩展消息同款，视觉上仍是扩展消息。 */
const BACKGROUND_COLOR = "customMessageBg";
/** 摘要块的水平内边距；垂直为 0，收起时只占一行。 */
const BOX_PADDING_X = 1;
const BOX_PADDING_Y = 0;
/** 收起/展开方向箭头。 */
const COLLAPSED_ARROW = "▸";
const EXPANDED_ARROW = "▾";
/** 头部各段之间的分隔符。 */
const META_SEPARATOR = " · ";

/** 鼠标事件类型：只有左键 click 才切换展开态。 */
const MOUSE_EVENT_CLICK = "click";
/** 鼠标按键：只响应左键。 */
const MOUSE_BUTTON_LEFT = "left";

/** 鼠标事件里用得上的字段；只做结构化读取，不依赖 pi-tui 的具体类型。 */
interface SquashMouseEvent {
  type?: unknown;
  button?: unknown;
}

/** MouseRegion 的最小结构类型：包住子组件、接管它的鼠标事件。 */
type SquashMouseRegion = new (
  child: piTui.Component,
  onMouse: (event: SquashMouseEvent) => { handled?: boolean } | undefined,
) => piTui.Component;

/**
 * 取 pi-tui 的 MouseRegion。
 * 只有全屏模式才会把鼠标事件派发到消息上；老版本 pi-tui 没有这个导出时返回 undefined，
 * 消息保持不可点击，键盘展开（Ctrl+O）照常可用。
 */
function resolveMouseRegion(): SquashMouseRegion | undefined {
  const candidate: unknown = (piTui as { MouseRegion?: unknown }).MouseRegion;
  return typeof candidate === "function" ? (candidate as SquashMouseRegion) : undefined;
}

/**
 * 摘要块的渲染体。
 *
 * 展开态存在实例上，和 Pi 自己的工具输出组件一个做法：点击后宿主只请求重画、
 * 不重建组件，所以 render() 时读实例状态就够；Ctrl+O 触发的 setExpanded 会让
 * Pi 重建整条消息，此时重新跟随全局展开态。
 */
class SquashMessageBody implements piTui.Component {
  /** 点击带来的本地覆盖；undefined 表示跟随全局 Ctrl+O。 */
  private override?: boolean;
  /** 缓存的渲染结果：键是当时用的展开态。 */
  private cached?: { expanded: boolean; box: piTui.Component };

  constructor(
    private readonly details: TailCompactionData,
    private readonly globalExpanded: boolean,
    private readonly theme: SquashRenderTheme,
  ) {}

  /** 当前是否展开：本地点击覆盖优先，没点过就跟随全局 Ctrl+O。 */
  private isExpanded(): boolean {
    return this.override ?? this.globalExpanded;
  }

  /** 点击时翻转展开态。 */
  toggle(): void {
    this.override = !this.isExpanded();
    this.cached = undefined;
  }

  /** 按当前展开态渲染；只在展开态变化时重建内部组件树。 */
  render(width: number): string[] {
    const expanded = this.isExpanded();
    if (this.cached === undefined || this.cached.expanded !== expanded) {
      this.cached = {
        expanded,
        box: buildSquashBox(this.details, expanded, this.theme),
      };
    }
    return this.cached.box.render(width);
  }

  /** 转发失效通知，让内部组件树下次重新渲染。 */
  invalidate(): void {
    this.cached?.box.invalidate();
  }
}

/** 构造整条消息的渲染树：一行头部 + 展开时的快照正文。 */
function buildSquashBox(
  details: TailCompactionData,
  expanded: boolean,
  theme: SquashRenderTheme,
): piTui.Component {
  const box = new piTui.Box(BOX_PADDING_X, BOX_PADDING_Y, (text) =>
    theme.bg(BACKGROUND_COLOR, text));
  box.addChild(new piTui.Text(buildHeaderLine(details, expanded, theme), 0, 0));

  if (!expanded) return box;
  const snapshot = stripContinuationInstruction(details.summary);
  if (snapshot !== "") {
    box.addChild(new piTui.Text("", 0, 0));
    box.addChild(new piTui.Markdown(snapshot, 0, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("customMessageText", text),
    }));
  }
  return box;
}

/** 头部一行：箭头 + 标题 + 压缩范围与规模 + 展开方向提示。 */
function buildHeaderLine(
  details: TailCompactionData,
  expanded: boolean,
  theme: SquashRenderTheme,
): string {
  const arrow = theme.fg("accent", expanded ? EXPANDED_ARROW : COLLAPSED_ARROW);
  const title = theme.fg("accent", i18n.t("squashMessageTitle"));
  const meta = theme.fg("dim", i18n.t("squashMessageMeta", {
    from: details.fromUserInputIndex,
    tokens: formatTokens(details.tokensBefore),
  }));
  const hint = theme.fg(
    "dim",
    i18n.t(expanded ? "squashMessageCollapseHint" : "squashMessageExpandHint"),
  );
  return `${arrow} ${title}${META_SEPARATOR}${meta}${META_SEPARATOR}${hint}`;
}

/** 可用时把消息包一层鼠标区域，让点击切换展开态。 */
function withMouseToggle(body: SquashMessageBody): piTui.Component {
  const MouseRegion = resolveMouseRegion();
  if (MouseRegion === undefined) return body;
  return new MouseRegion(body, (event) => {
    if (event.type !== MOUSE_EVENT_CLICK || event.button !== MOUSE_BUTTON_LEFT) {
      return undefined;
    }
    body.toggle();
    return { handled: true };
  });
}

/**
 * session_squash 消息的渲染器。
 *
 * details 不是尾部压缩数据时返回 undefined，交回 Pi 的默认渲染 —— 这样旧会话里
 * 残缺的条目仍然可见，而不是变成一块空白。
 */
export const renderSquashMessage: MessageRenderer<unknown> = (message, options, theme) => {
  const details = readTailCompactionData(message.details);
  if (!details) return undefined;
  return withMouseToggle(
    new SquashMessageBody(details, options.expanded === true, theme),
  );
};

/** 注册摘要消息渲染器；老版本 Pi 没有这个能力时保持默认渲染。 */
export function registerSquashMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer?.(SESSION_SQUASH_TYPE, renderSquashMessage);
}
