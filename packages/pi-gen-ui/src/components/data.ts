import { visibleWidth } from "@earendil-works/pi-tui";
import type { ComponentRenderer, RenderContext } from "../types.ts";
import { bool, list, num, oneOf, optionalNum, optionalStr, str } from "../props.ts";
import { SGR, bg, fg, style } from "../ansi.ts";
import { centerLine, clampLine, drawBorder, padLine, rightAlignLine, trimTrailingPadding } from "../layout.ts";

const ALIGNMENTS = ["left", "center", "right"] as const;
/** Sparkline block characters, lowest to highest. */
const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
/** Spinner frames; the first frame is the static fallback. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One table column definition. */
interface Column {
  header: string;
  key: string;
  width?: number;
  align: "left" | "center" | "right";
}

/** Read and validate the column definitions. */
function columnsOf(props: Record<string, unknown>): Column[] {
  return list<Record<string, unknown>>(props, "columns").map((column) => ({
    header: str(column, "header"),
    key: str(column, "key"),
    width: optionalNum(column, "width"),
    align: oneOf(column, "align", ALIGNMENTS) ?? "left",
  }));
}

/** Place a cell value inside its column. */
function placeCell(value: string, width: number, align: "left" | "center" | "right"): string {
  const clamped = clampLine(trimTrailingPadding(value), width);
  if (align === "center") return centerLine(clamped, width);
  if (align === "right") return rightAlignLine(clamped, width);
  return padLine(clamped, width);
}

/** Shrink column widths until the table fits the available columns. */
function fitColumns(widths: number[], available: number, gap: number, frame: number): number[] {
  const result = [...widths];
  const total = (): number => result.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, result.length - 1) + frame;
  let guard = 0;
  while (total() > available && guard < 5000) {
    guard += 1;
    let widest = -1;
    let widestValue = 3;
    result.forEach((value, index) => {
      if (value > widestValue) {
        widestValue = value;
        widest = index;
      }
    });
    if (widest < 0) break;
    result[widest] -= 1;
  }
  return result;
}

/** Render a Table element. */
const table: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const columns = columnsOf(props);
  if (columns.length === 0) return [];
  const rows = list<Record<string, unknown>>(props, "rows");
  const available = Math.max(1, Math.floor(width));
  const borderStyle = optionalStr(props, "borderStyle");
  const gap = borderStyle ? 3 : 2;
  const frame = borderStyle ? 2 : 0;

  const natural = columns.map((column) => {
    const headerWidth = visibleWidth(column.header);
    const cellWidth = rows.reduce(
      (max, row) => Math.max(max, visibleWidth(String(row[column.key] ?? ""))),
      0,
    );
    return column.width ? Math.floor(column.width) : Math.max(headerWidth, cellWidth, 3);
  });
  const widths = fitColumns(natural, available, gap, frame);

  const gapText = borderStyle ? " │ " : "  ";
  const headerColor = optionalStr(props, "headerColor") ?? "cyan";
  const headerLine = columns
    .map((column, index) => style(SGR.bold, fg(headerColor, placeCell(column.header, widths[index], column.align))))
    .join(gapText);

  const body = rows.map((row) =>
    columns
      .map((column, index) => placeCell(String(row[column.key] ?? ""), widths[index], column.align))
      .join(gapText),
  );

  let lines: string[];
  if (borderStyle) {
    // The gap connector must line up with the ` │ ` separators of the data rows,
    // and the outer frame comes from drawBorder rather than this separator.
    const separator = widths.map((value) => "─".repeat(Math.max(0, value))).join("─┼─");
    lines = [headerLine, separator, ...body];
    lines = drawBorder({
      content: lines,
      width: available,
      borderStyle,
    });
  } else {
    lines = [headerLine, widths.map((value) => "─".repeat(Math.max(0, value))).join("  "), ...body];
  }

  const backgroundColor = optionalStr(props, "backgroundColor");
  return backgroundColor ? lines.map((line) => bg(backgroundColor, padLine(clampLine(line, available), available))) : lines;
};

/** Render a ProgressBar element. */
const progressBar: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const ratio = Math.max(0, Math.min(1, num(props, "progress", 0)));
  const label = optionalStr(props, "label");
  const labelWidth = label ? visibleWidth(label) + 1 : 0;
  const percent = ` ${Math.round(ratio * 100)}%`;
  const available = Math.max(1, Math.floor(width));
  const requested = num(props, "width", 30);
  const barWidth = Math.max(1, Math.min(Math.floor(requested), available - labelWidth - visibleWidth(percent)));
  const filled = Math.round(ratio * barWidth);
  const color = optionalStr(props, "color") ?? "green";
  const bar = style(SGR.bold, fg(color, "█".repeat(filled))) + fg("gray", "░".repeat(Math.max(0, barWidth - filled)));
  const prefix = label ? style(SGR.bold, `${label} `) : "";
  return [clampLine(`${prefix}${bar}${percent}`, available)];
};

/** Reduce a series to `width` points by averaging buckets. */
function downsample(data: number[], width: number): number[] {
  if (data.length <= width) return data;
  const bucketSize = data.length / width;
  const result: number[] = [];
  for (let index = 0; index < width; index += 1) {
    const start = Math.floor(index * bucketSize);
    const end = Math.min(data.length, Math.max(start + 1, Math.floor((index + 1) * bucketSize)));
    const slice = data.slice(start, end);
    result.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
  }
  return result;
}

/** Render a Sparkline element. */
const sparkline: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const data = list<number>(props, "data").filter((value) => Number.isFinite(value));
  const label = optionalStr(props, "label");
  const labelWidth = label ? visibleWidth(label) + 1 : 0;
  const available = Math.max(1, Math.floor(width));
  const requested = optionalNum(props, "width");
  const plotWidth = Math.max(
    1,
    Math.min(requested ? Math.floor(requested) : available - labelWidth, available - labelWidth),
  );
  const points = downsample(data, plotWidth);
  const min = optionalNum(props, "min") ?? Math.min(...points, 0);
  const max = optionalNum(props, "max") ?? Math.max(...points, 1);
  const span = max - min || 1;
  const color = optionalStr(props, "color");
  const glyphs = points
    .map((value) => {
      const stepped = Math.max(0, Math.min(SPARK_BLOCKS.length - 1, Math.round(((value - min) / span) * (SPARK_BLOCKS.length - 1))));
      return SPARK_BLOCKS[stepped];
    })
    .join("");
  const prefix = label ? style(SGR.bold, `${label} `) : "";
  return [clampLine(`${prefix}${fg(color, glyphs)}`, available)];
};

/** Render a BarChart element. */
const barChart: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const data = list<Record<string, unknown>>(props, "data");
  if (data.length === 0) return [];
  const showValues = bool(props, "showValues");
  const showPercentage = bool(props, "showPercentage");
  const available = Math.max(1, Math.floor(width));

  const labels = data.map((item) => str(item, "label"));
  const values = data.map((item) => num(item, "value", 0));
  const labelWidth = Math.min(16, labels.reduce((max, value) => Math.max(max, visibleWidth(value)), 0));
  const total = values.reduce((sum, value) => sum + Math.abs(value), 0) || 1;
  const suffixWidth =
    (showValues ? ` ${Math.max(...values.map((value) => String(Math.round(value)).length))}`.length : 0) +
    (showPercentage ? 6 : 0);
  const requested = num(props, "width", 30);
  const barWidth = Math.max(1, Math.min(Math.floor(requested), available - labelWidth - 1 - suffixWidth));

  return data.map((item, index) => {
    const value = values[index];
    const ratio = Math.max(0, Math.min(1, Math.abs(value) / Math.max(...values.map(Math.abs), 1)));
    const filled = Math.max(value === 0 ? 0 : 1, Math.round(ratio * barWidth));
    const color = optionalStr(item, "color") ?? "cyan";
    const suffix =
      (showValues ? ` ${Math.round(value)}` : "") +
      (showPercentage ? ` (${Math.round((Math.abs(value) / total) * 100)}%)` : "");
    return clampLine(
      `${padLine(fg("gray", clampLine(labels[index], labelWidth)), labelWidth)} ${fg(color, "█".repeat(filled))}${suffix}`,
      available,
    );
  });
};

/** Local-state key holding the current animation frame. */
const FRAME_KEY = "spinnerFrame";

/** Spinner frame index for the current render pass. */
function spinnerFrame(ctx: RenderContext): number {
  const counter = ctx.local.get(FRAME_KEY);
  const index = typeof counter === "number" ? Math.floor(counter) : 0;
  return ((index % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
}

/** Render a Spinner element. */
const spinner: ComponentRenderer = ({ node, ctx }) => {
  const props = node.props;
  const color = optionalStr(props, "color") ?? "cyan";
  const label = optionalStr(props, "label");
  const frame = SPINNER_FRAMES[spinnerFrame(ctx)];
  return [`${fg(color, frame)}${label ? ` ${label}` : ""}`];
};

export const dataComponents = {
  Table: table,
  ProgressBar: progressBar,
  Sparkline: sparkline,
  BarChart: barChart,
  Spinner: spinner,
} satisfies Record<string, ComponentRenderer>;
