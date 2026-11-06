import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SGR, bg, fg, style } from "./ansi.ts";
import { SUPPORTED_BORDER_STYLES } from "./capabilities.ts";

/** Box-drawing characters per supported border style. */
interface BorderGlyphs {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  /** Horizontal rule character used by Divider. */
  rule: string;
}

const BORDERS: Readonly<Record<string, BorderGlyphs>> = {
  single: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    rule: "─",
  },
  double: {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    horizontal: "═",
    vertical: "║",
    rule: "═",
  },
  round: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    rule: "─",
  },
  bold: {
    topLeft: "┏",
    topRight: "┓",
    bottomLeft: "┗",
    bottomRight: "┛",
    horizontal: "━",
    vertical: "┃",
    rule: "━",
  },
  classic: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    rule: "-",
  },
};

/** Glyphs for a border style, falling back to `single` for unknown styles. */
export function borderGlyphs(borderStyle: string | null | undefined): BorderGlyphs {
  const key = typeof borderStyle === "string" ? borderStyle.toLowerCase() : "";
  return BORDERS[key] ?? BORDERS.single;
}

/** True when the border style can actually be drawn. */
export function isSupportedBorderStyle(borderStyle: string): boolean {
  return SUPPORTED_BORDER_STYLES.includes(borderStyle.toLowerCase());
}

/** Text attributes a spec can request. */
export interface TextAttributes {
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  strikethrough?: boolean | null;
  dimColor?: boolean | null;
  inverse?: boolean | null;
}

/** Attributes plus colors for one styled run of text. */
export interface TextStyle extends TextAttributes {
  color?: string | null;
  backgroundColor?: string | null;
}

/** Apply attributes and colors to text. Attribute order is fixed for stable output. */
export function paint(text: string, options: TextStyle): string {
  let result = text;
  if (options.bold) result = style(SGR.bold, result);
  if (options.dimColor) result = style(SGR.dim, result);
  if (options.italic) result = style(SGR.italic, result);
  if (options.underline) result = style(SGR.underline, result);
  if (options.strikethrough) result = style(SGR.strikethrough, result);
  if (options.inverse) result = style(SGR.inverse, result);
  if (options.backgroundColor) result = bg(options.backgroundColor, result);
  if (options.color) result = fg(options.color, result);
  return result;
}

/** Split text into hard lines, preserving empty lines. */
function hardLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** Wrap text to `width` columns, honoring explicit newlines. Never returns an empty array. */
export function wrap(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const source = hardLines(text);
  const result: string[] = [];
  for (const line of source) {
    if (visibleWidth(line) <= safeWidth) {
      result.push(line);
      continue;
    }
    for (const wrapped of wrapTextWithAnsi(line, safeWidth)) {
      result.push(wrapped);
    }
  }
  return result.length > 0 ? result : [""];
}

/** Wrap to `width` and apply styling to each resulting line. */
export function wrapStyled(text: string, width: number, apply: (line: string) => string): string[] {
  return wrap(text, width).map(apply);
}

/** Truncate one line to `width`, appending an ellipsis when content is dropped. */
export function clampLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, Math.floor(width)), "…");
}

/** Truncate every line to `width`. */
export function clampLines(lines: string[], width: number): string[] {
  return lines.map((line) => clampLine(line, width));
}

/** Pad a line on the right with spaces so its visible width is exactly `width`. */
export function padLine(line: string, width: number): string {
  const current = visibleWidth(line);
  return current >= width ? line : line + " ".repeat(width - current);
}

/** Pad every line to `width`; used before drawing vertical borders. */
export function padLines(lines: string[], width: number): string[] {
  return lines.map((line) => padLine(clampLine(line, width), width));
}

/** Center a single line inside `width` columns. */
export function centerLine(line: string, width: number): string {
  const current = visibleWidth(line);
  if (current >= width) return clampLine(line, width);
  const left = Math.floor((width - current) / 2);
  return " ".repeat(left) + line + " ".repeat(width - current - left);
}

/** Right-align a single line inside `width` columns. */
export function rightAlignLine(line: string, width: number): string {
  const current = visibleWidth(line);
  if (current >= width) return clampLine(line, width);
  return " ".repeat(width - current) + line;
}

/** Repeat a character to fill `width` columns. */
export function rule(character: string, width: number): string {
  const unit = character.length > 0 ? character : "─";
  const unitWidth = Math.max(1, visibleWidth(unit));
  const count = Math.max(0, Math.floor(width / unitWidth));
  return unit.repeat(count) + " ".repeat(Math.max(0, width - count * unitWidth));
}

/** Indent every line by `size` spaces. */
export function indent(lines: string[], size: number): string[] {
  if (size <= 0) return lines;
  const prefix = " ".repeat(size);
  return lines.map((line) => prefix + line);
}

/** Pad a block with blank lines above and below. */
export function padBlockVertically(lines: string[], top: number, bottom: number): string[] {
  return [...Array.from({ length: Math.max(0, top) }, () => ""), ...lines, ...Array.from({ length: Math.max(0, bottom) }, () => "")];
}

/** Add a blank line between blocks, keeping zero-height blocks out of the gap math. */
export function stackBlocks(blocks: string[][], gap: number): string[] {
  const present = blocks.filter((block) => block.length > 0);
  const result: string[] = [];
  present.forEach((block, index) => {
    if (index > 0) {
      for (let line = 0; line < gap; line += 1) result.push("");
    }
    result.push(...block);
  });
  return result;
}

/** One row slot: measured natural width plus flex behavior. */
export interface RowSlot {
  /** Natural width in columns, before shrinking or growing. */
  basis: number;
  /** Whether the slot absorbs leftover columns. */
  grow?: boolean;
  /** Whether the slot may shrink below its natural width. */
  shrink?: boolean;
}

/** One already-rendered row cell. */
export interface RowCell {
  lines: string[];
  align?: "left" | "center" | "right";
}

/** Split `extra` columns across growable slots. */
function distribute(slots: RowSlot[], widths: number[], extra: number): void {
  const growable = slots.map((slot, index) => (slot.grow ? index : -1)).filter((index) => index >= 0);
  if (growable.length === 0 || extra <= 0) return;
  const share = Math.floor(extra / growable.length);
  let remainder = extra - share * growable.length;
  for (const index of growable) {
    widths[index] += share;
    if (remainder > 0) {
      widths[index] += 1;
      remainder -= 1;
    }
  }
}

/**
 * Allocate column widths for a horizontal row.
 *
 * Shrinking is proportional down to one column per slot; growth goes to
 * `grow` slots. When nothing can grow and the row is still narrower than the
 * terminal, the leftover is left unused rather than smeared across slots.
 */
export function allocateRowWidths(slots: RowSlot[], width: number, gap: number): number[] {
  if (slots.length === 0) return [];
  const totalGap = gap * (slots.length - 1);
  const available = Math.max(slots.length, width - totalGap);
  const widths = slots.map((slot) => Math.max(1, Math.floor(slot.basis)));

  const total = (): number => widths.reduce((sum, value) => sum + value, 0);

  let excess = total() - available;
  while (excess > 0) {
    const shrinkable = slots.map((slot, index) => (slot.shrink === false ? -1 : index)).filter((index) => index >= 0);
    const pool = shrinkable.filter((index) => widths[index] > 1);
    if (pool.length === 0) break;
    const step = Math.max(1, Math.ceil(excess / pool.length));
    let progressed = false;
    for (const index of pool) {
      if (excess <= 0) break;
      const take = Math.min(step, widths[index] - 1, excess);
      widths[index] -= take;
      excess -= take;
      progressed = true;
    }
    if (!progressed) break;
  }

  const leftover = available - total();
  if (leftover > 0) distribute(slots, widths, leftover);
  return widths;
}

/** Trailing padding plus any escape sequences that follow it. */
const TRAILING_PADDING = /([ \t]+)((?:(?:\x1b\[[0-9;?]*[ -/]*[@-~])|(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)))*)$/;

/**
 * Drop trailing spaces and tabs while keeping every escape sequence intact.
 *
 * Components pad their output to the space they were given (a highlighted
 * Select row, a table cell), so that padding must be removed before the content
 * is re-clamped to its allocated width; otherwise the last padded space becomes
 * an ellipsis and the cell reads as truncated. Styles survive because the
 * closing sequences stay in place.
 */
export function trimTrailingPadding(line: string): string {
  let result = line;
  // Each pass removes one run of padding; interleaved resets need several passes.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = result.replace(TRAILING_PADDING, "$2");
    if (next === result) return result;
    result = next;
  }
  return result;
}

/** Place a cell value inside its column, keeping its styling. */
function placeCell(value: string, width: number, align: "left" | "center" | "right"): string {
  const clamped = clampLine(trimTrailingPadding(value), width);
  if (align === "center") return centerLine(clamped, width);
  if (align === "right") return rightAlignLine(clamped, width);
  return padLine(clamped, width);
}

/** Join already-rendered cells side by side into equal-height rows. */
export function joinRowCells(cells: RowCell[], widths: number[], gap: number): string[] {
  const height = cells.reduce((max, cell) => Math.max(max, cell.lines.length), 0);
  const spacer = " ".repeat(Math.max(0, gap));
  const rows: string[] = [];

  for (let line = 0; line < height; line += 1) {
    const parts: string[] = [];
    cells.forEach((cell, index) => {
      const cellWidth = Math.max(0, widths[index] ?? 0);
      const raw = cell.lines[line];
      parts.push(raw === undefined ? " ".repeat(cellWidth) : placeCell(raw, cellWidth, cell.align ?? "left"));
    });
    rows.push(parts.join(spacer));
  }

  return rows;
}

/** Sides of a box border that should be drawn. */
export interface BorderSides {
  top?: boolean;
  bottom?: boolean;
  left?: boolean;
  right?: boolean;
}

/** Options for drawing a box border around inner lines. */
export interface DrawBorderOptions {
  /** Already-wrapped inner lines. */
  content: string[];
  /** Total outer width, borders included. */
  width: number;
  /** Border style name; unknown styles fall back to `single`. */
  borderStyle: string;
  /** Border color; unset keeps the terminal default. */
  color?: string | null;
  /** Which sides to draw; all sides by default. */
  sides?: BorderSides;
}

/** Draw a border around inner lines. */
export function drawBorder(options: DrawBorderOptions): string[] {
  const { content, width, borderStyle, color, sides = {} } = options;
  const glyphs = borderGlyphs(borderStyle);
  const top = sides.top !== false;
  const bottom = sides.bottom !== false;
  const left = sides.left !== false;
  const right = sides.right !== false;
  const paintBorder = (text: string): string => (color ? fg(color, text) : text);

  const verticalColumns = (left ? 1 : 0) + (right ? 1 : 0);
  const innerWidth = Math.max(0, width - verticalColumns);
  const body = padLines(content, innerWidth);

  const lines: string[] = [];

  if (top) {
    const horizontalCount = Math.max(0, width - (left ? 1 : 0) - (right ? 1 : 0));
    const bar = glyphs.horizontal.repeat(horizontalCount);
    lines.push(paintBorder(`${left ? glyphs.topLeft : ""}${bar}${right ? glyphs.topRight : ""}`));
  }

  for (const line of body) {
    lines.push(`${left ? paintBorder(glyphs.vertical) : ""}${line}${right ? paintBorder(glyphs.vertical) : ""}`);
  }

  if (bottom) {
    const horizontalCount = Math.max(0, width - (left ? 1 : 0) - (right ? 1 : 0));
    const bar = glyphs.horizontal.repeat(horizontalCount);
    lines.push(paintBorder(`${left ? glyphs.bottomLeft : ""}${bar}${right ? glyphs.bottomRight : ""}`));
  }

  return lines;
}
