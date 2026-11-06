import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ComponentRenderer, RenderContext, RenderedNode } from "../types.ts";
import { bool, num, oneOf, optionalStr, str } from "../props.ts";
import { isSupportedBorderStyle } from "../layout.ts";
import {
  allocateRowWidths,
  centerLine,
  clampLine,
  drawBorder,
  joinRowCells,
  padLine,
  paint,
  rightAlignLine,
} from "../layout.ts";
import { renderNode } from "../renderer.ts";
import { bg, stripAnsi } from "../ansi.ts";

const DIRECTIONS = ["row", "row-reverse", "column", "column-reverse"] as const;
const ALIGN_ITEMS = ["flex-start", "center", "flex-end", "stretch"] as const;
const JUSTIFY = ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"] as const;
const WRAP_MODES = ["wrap", "truncate", "truncate-end", "truncate-middle", "truncate-start"] as const;

/** Resolved padding on all four sides. */
export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Resolve `padding` / `paddingX` / `paddingY` / per-side props into one record. */
export function paddingOf(props: Record<string, unknown>): Padding {
  const all = Math.max(0, num(props, "padding", 0));
  const x = Math.max(0, num(props, "paddingX", all));
  const y = Math.max(0, num(props, "paddingY", all));
  return {
    top: Math.max(0, num(props, "paddingTop", y)),
    right: Math.max(0, num(props, "paddingRight", x)),
    bottom: Math.max(0, num(props, "paddingBottom", y)),
    left: Math.max(0, num(props, "paddingLeft", x)),
  };
}

/** Resolve `gap` / `columnGap` / `rowGap` for the main axis. */
function gapOf(props: Record<string, unknown>, vertical: boolean): number {
  const fallback = Math.max(0, num(props, "gap", 0));
  return Math.max(0, num(props, vertical ? "rowGap" : "columnGap", fallback));
}

/** Resolve a `width` prop (number or percentage string) against the available columns. */
export function resolveWidth(value: unknown, available: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.min(Math.floor(value), available));
  if (typeof value === "string") {
    const percent = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (percent) return Math.max(1, Math.min(Math.floor((available * Number(percent[1])) / 100), available));
  }
  return undefined;
}

/**
 * Natural width of a rendered block, capped by the space it was rendered in.
 *
 * Trailing padding is ignored: components that highlight a full-width row (an
 * active Select option, a padded table cell) would otherwise measure as wide as
 * the whole container and starve their row siblings. Trailing spaces sit before
 * the closing reset sequence, so the line is stripped of ANSI before trimming.
 */
function naturalWidth(lines: string[], cap: number): number {
  return Math.min(
    cap,
    lines.reduce((max, line) => Math.max(max, visibleWidth(stripAnsi(line).trimEnd())), 0),
  );
}

/** Whether a child element opts into absorbing leftover row space. */
function grows(child: RenderedNode): boolean {
  return child.element.type === "Spacer" || num(child.props, "flexGrow", 0) > 0;
}

/** Whether a child element accepts being narrowed below its natural width. */
function shrinks(child: RenderedNode): boolean {
  return num(child.props, "flexShrink", 1) !== 0;
}

/** Align one line inside `width` columns. */
function placeLine(line: string, width: number, align: "left" | "center" | "right"): string {
  const clamped = clampLine(line, width);
  if (align === "center") return centerLine(clamped, width);
  if (align === "right") return rightAlignLine(clamped, width);
  return padLine(clamped, width);
}

/** Pad a block with blank lines so every row cell shares one height. */
function fillHeight(lines: string[], height: number, align: "top" | "center" | "bottom"): string[] {
  if (lines.length >= height) return lines.slice(0, height);
  const missing = height - lines.length;
  const top = align === "center" ? Math.floor(missing / 2) : align === "bottom" ? missing : 0;
  return [...Array.from({ length: top }, () => ""), ...lines, ...Array.from({ length: missing - top }, () => "")];
}

/** Options for stacking child blocks vertically. */
interface ColumnLayoutOptions {
  /** One rendered block per child element. */
  blocks: string[][];
  /** Inner width available to children. */
  contentWidth: number;
  /** Blank lines between blocks. */
  gap: number;
  /** `alignItems` value; controls horizontal placement. */
  alignItems: string | undefined;
}

/**
 * Stack blocks vertically.
 *
 * Only `alignItems` (the cross axis) is applied. `justifyContent` needs a
 * fixed container height to distribute, which terminal layout does not have,
 * so the Box reports it instead of guessing.
 */
function layoutColumn(options: ColumnLayoutOptions): string[] {
  const { blocks, contentWidth, gap, alignItems } = options;
  const align = alignItems === "center" ? "center" : alignItems === "flex-end" ? "right" : "left";
  const present = blocks.filter((block) => block.length > 0);
  const pieces: string[] = [];
  present.forEach((block, index) => {
    if (index > 0) {
      for (let line = 0; line < gap; line += 1) pieces.push(" ".repeat(contentWidth));
    }
    for (const line of block) pieces.push(placeLine(line, contentWidth, align));
  });
  return pieces;
}

/** Options for laying children out side by side. */
interface RowLayoutOptions {
  /** Parent node whose children form the row. */
  node: RenderedNode;
  /** Inner width available to the row. */
  contentWidth: number;
  /** Columns between cells. */
  gap: number;
  /** `justifyContent` value; controls horizontal distribution. */
  justifyContent: string | undefined;
  /** `alignItems` value; controls vertical placement inside the row. */
  alignItems: string | undefined;
  /** Render context, used to render individual children at allocated widths. */
  ctx: RenderContext;
}

/** Lay children out side by side, re-rendering them after width allocation. */
function layoutRow(options: RowLayoutOptions): string[] {
  const { node, contentWidth, gap, justifyContent, alignItems, ctx } = options;

  // Pass 1: render at full inner width to measure natural sizes.
  const measured = node.children.map((child) => renderNode(child, contentWidth, ctx, ctx.components));
  const slots = node.children.map((child, index) => ({
    basis: resolveWidth(child.props.width, contentWidth) ?? naturalWidth(measured[index], contentWidth),
    grow: grows(child),
    shrink: shrinks(child),
  }));
  const widths = allocateRowWidths(slots, contentWidth, gap);

  // Pass 2: render each child at its allocated width so text wraps instead of being cut.
  const cells = node.children.map((child, index) => ({
    lines: renderNode(child, widths[index], ctx, ctx.components),
    align: "left" as const,
  }));

  const rowWidth = widths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, widths.length - 1);
  const leftover = Math.max(0, contentWidth - rowWidth);
  const height = cells.reduce((max, cell) => Math.max(max, cell.lines.length), 0);
  const vAlign = alignItems === "center" ? "center" : alignItems === "flex-end" ? "bottom" : "top";
  const filled = cells.map((cell) => ({ lines: fillHeight(cell.lines, height, vAlign), align: cell.align }));

  const isSpaceMode = justifyContent === "space-between" || justifyContent === "space-around" || justifyContent === "space-evenly";
  const gapCount =
    justifyContent === "space-evenly"
      ? cells.length + 1
      : justifyContent === "space-around"
        ? cells.length
        : Math.max(0, cells.length - 1);
  const extraGap = isSpaceMode && gapCount > 0 ? Math.floor(leftover / gapCount) : 0;
  const leading =
    justifyContent === "center"
      ? Math.floor(leftover / 2)
      : justifyContent === "flex-end"
        ? leftover
        : justifyContent === "space-evenly"
          ? extraGap
          : justifyContent === "space-around"
            ? Math.floor(extraGap / 2)
            : 0;

  if (leading === 0 && extraGap === 0) {
    return joinRowCells(filled, widths, gap).map((line) => padLine(clampLine(line, contentWidth), contentWidth));
  }

  const extraPerGap = Array.from({ length: Math.max(0, cells.length - 1) }, () => extraGap);
  return mergeRowWithGaps({ cells: filled, widths, gap, leading, extraPerGap, height }).map((line) =>
    padLine(clampLine(line, contentWidth), contentWidth),
  );
}

/** Options for rebuilding a row with extra spacing between cells. */
interface MergeRowOptions {
  /** Already-rendered cells, all padded to the same height. */
  cells: { lines: string[]; align?: "left" | "center" | "right" }[];
  /** Allocated width per cell. */
  widths: number[];
  /** Base gap between cells. */
  gap: number;
  /** Blank columns inserted before the first cell. */
  leading: number;
  /** Extra columns inserted before each cell after the first. */
  extraPerGap: number[];
  /** Row height in lines. */
  height: number;
}

/** Rebuild a row with extra columns for `space-*` and centering justify modes. */
function mergeRowWithGaps(options: MergeRowOptions): string[] {
  const { cells, widths, gap, leading, extraPerGap, height } = options;
  const rows: string[] = [];
  for (let line = 0; line < height; line += 1) {
    const parts: string[] = [" ".repeat(leading)];
    cells.forEach((cell, index) => {
      if (index > 0) parts.push(" ".repeat(Math.max(0, gap + (extraPerGap[index - 1] ?? 0))));
      const raw = cell.lines[line];
      const cellWidth = Math.max(0, widths[index] ?? 0);
      parts.push(raw === undefined ? " ".repeat(cellWidth) : placeLine(raw, cellWidth, cell.align ?? "left"));
    });
    rows.push(parts.join(""));
  }
  return rows;
}

/** Resolved border configuration. */
interface BorderConfig {
  style?: string;
  columns: number;
  sides: { top: boolean; bottom: boolean; left: boolean; right: boolean };
}

/** Resolve border configuration and report an undrawable style. */
function borderOf(props: Record<string, unknown>, elementKey: string, warn: (message: string) => void): BorderConfig {
  const style = optionalStr(props, "borderStyle");
  const noSides = { top: false, bottom: false, left: false, right: false };
  if (!style) return { columns: 0, sides: noSides };

  const supported = isSupportedBorderStyle(style);
  if (!supported) {
    warn(
      `Element "${elementKey}" (Box): borderStyle "${style}" cannot be drawn in Pi; using "single". Supported: single, double, round, bold, classic.`,
    );
  }
  const sides = {
    top: bool(props, "borderTop", true),
    bottom: bool(props, "borderBottom", true),
    left: bool(props, "borderLeft", true),
    right: bool(props, "borderRight", true),
  };
  return {
    style: supported ? style.toLowerCase() : "single",
    columns: (sides.left ? 1 : 0) + (sides.right ? 1 : 0),
    sides,
  };
}

/** Render a Box. */
const box: ComponentRenderer = ({ node, width, ctx }) => {
  const props = node.props;
  if (oneOf(props, "display", ["flex", "none"]) === "none") return [];

  const available = Math.max(1, Math.floor(width));
  const outerWidth = resolveWidth(props.width, available) ?? available;
  const padding = paddingOf(props);
  const border = borderOf(props, node.key, ctx.warn);
  const innerWidth = Math.max(1, outerWidth - border.columns - padding.left - padding.right);

  const direction = oneOf(props, "flexDirection", DIRECTIONS) ?? "row";
  const vertical = direction === "column" || direction === "column-reverse";
  const reversed = direction === "row-reverse" || direction === "column-reverse";
  if (reversed) node = { ...node, children: [...node.children].reverse() };

  const alignItems = oneOf(props, "alignItems", ALIGN_ITEMS);
  const justifyContent = oneOf(props, "justifyContent", JUSTIFY);
  const gap = gapOf(props, vertical);

  if (vertical && justifyContent && justifyContent !== "flex-start") {
    ctx.warn(
      `Element "${node.key}" (Box): justifyContent "${justifyContent}" needs a fixed height, which terminal layout does not provide; children stack from the top instead.`,
    );
  }

  let content: string[];
  if (vertical) {
    const blocks = node.children.map((child) => renderNode(child, innerWidth, ctx, ctx.components));
    content = layoutColumn({ blocks, contentWidth: innerWidth, gap, alignItems });
  } else {
    content = layoutRow({ node, contentWidth: innerWidth, gap, justifyContent, alignItems, ctx });
  }

  const withPadding = [
    ...Array.from({ length: padding.top }, () => " ".repeat(innerWidth)),
    ...content.map((line) => " ".repeat(padding.left) + line + " ".repeat(padding.right)),
    ...Array.from({ length: padding.bottom }, () => " ".repeat(innerWidth)),
  ];

  const framed = border.style
    ? drawBorder({
        content: withPadding,
        width: outerWidth,
        borderStyle: border.style,
        color: optionalStr(props, "borderColor"),
        sides: border.sides,
      })
    : withPadding;

  const clamped = framed.map((line) => padLine(clampLine(line, outerWidth), outerWidth));
  const backgroundColor = optionalStr(props, "backgroundColor");
  return backgroundColor ? clamped.map((line) => bg(backgroundColor, line)) : clamped;
};

/** Render a Text element. */
const text: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const wrapMode = oneOf(props, "wrap", WRAP_MODES);
  const apply = (line: string): string =>
    paint(line, {
      bold: bool(props, "bold"),
      italic: bool(props, "italic"),
      underline: bool(props, "underline"),
      strikethrough: bool(props, "strikethrough"),
      dimColor: bool(props, "dimColor"),
      inverse: bool(props, "inverse"),
      color: optionalStr(props, "color"),
      backgroundColor: optionalStr(props, "backgroundColor"),
    });

  const safeWidth = Math.max(1, Math.floor(width));
  const lines = str(props, "text").replace(/\r\n?/g, "\n").split("\n");

  if (wrapMode && wrapMode !== "wrap") {
    return lines.map((line) => apply(clampLine(line, safeWidth)));
  }

  const out: string[] = [];
  for (const line of lines) {
    const styled = apply(line);
    if (visibleWidth(line) <= safeWidth) {
      out.push(styled);
      continue;
    }
    for (const wrapped of wrapTextWithAnsi(styled, safeWidth)) out.push(wrapped);
  }
  return out.length > 0 ? out : [""];
};

/** Render one or more blank lines. */
const newline: ComponentRenderer = ({ node }) =>
  Array.from({ length: Math.max(0, Math.floor(num(node.props, "count", 1))) }, () => "");

/** Flexible space; the enclosing Box expands it. */
const spacer: ComponentRenderer = () => [];

export const layoutComponents = {
  Box: box,
  Text: text,
  Newline: newline,
  Spacer: spacer,
} satisfies Record<string, ComponentRenderer>;
