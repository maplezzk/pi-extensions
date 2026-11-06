import { visibleWidth } from "@earendil-works/pi-tui";
import type { ComponentRenderer } from "../types.ts";
import { bool, list, num, oneOf, optionalStr, str } from "../props.ts";
import { SGR, bg, fg, hyperlink, style } from "../ansi.ts";
import { centerLine, clampLine, padLine, paint, rightAlignLine, rule, wrap } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";

const HEADING_LEVELS = ["h1", "h2", "h3", "h4"] as const;
const BADGE_VARIANTS = ["default", "info", "success", "warning", "error"] as const;
const STATUS_VALUES = ["info", "success", "warning", "error"] as const;
const CALLOUT_TYPES = ["info", "tip", "warning", "important"] as const;
const TRENDS = ["up", "down", "neutral"] as const;
const TIMELINE_STATUSES = ["completed", "current", "upcoming"] as const;

/** Colors used for semantic variants. */
const VARIANT_COLOR: Readonly<Record<string, string>> = {
  default: "gray",
  info: "blue",
  success: "green",
  warning: "yellow",
  error: "red",
  tip: "green",
  important: "magenta",
};

/** Default StatusLine icons per status. */
const STATUS_ICON: Readonly<Record<string, string>> = {
  info: "ℹ",
  success: "✔",
  warning: "⚠",
  error: "✖",
};

/** Trend arrows for the Metric component. */
const TREND_ARROW: Readonly<Record<string, string>> = { up: "↑", down: "↓", neutral: "→" };
const TREND_COLOR: Readonly<Record<string, string>> = { up: "green", down: "red", neutral: "gray" };

/** Heading styles per level. */
const HEADING_STYLE: Readonly<Record<string, { bold?: boolean; underline?: boolean; dim?: boolean }>> = {
  h1: { bold: true, underline: true },
  h2: { bold: true },
  h3: { bold: true, dim: true },
  h4: { dim: true },
};

/** Render a Heading element. */
const heading: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const level = oneOf(props, "level", HEADING_LEVELS) ?? "h1";
  const shape = HEADING_STYLE[level];
  const lines = wrap(str(props, "text"), Math.max(1, width));
  return lines.map((line) =>
    paint(line, { bold: shape.bold, underline: shape.underline, dimColor: shape.dim, color: optionalStr(props, "color") }),
  );
};

/** Render a Divider element, optionally with a centered title. */
const divider: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const character = optionalStr(props, "character") ?? "─";
  const requested = num(props, "width", 0);
  const available = Math.max(1, Math.floor(width));
  const total = requested > 0 ? Math.min(Math.floor(requested), available) : Math.min(available, 40);
  const apply = (text: string): string =>
    paint(text, { dimColor: bool(props, "dimColor"), color: optionalStr(props, "color") });

  const title = optionalStr(props, "title");
  if (!title || visibleWidth(title) + 2 >= total) {
    return [apply(rule(character, total))];
  }

  const label = ` ${title} `;
  const remaining = total - visibleWidth(label);
  const left = Math.floor(remaining / 2);
  return [apply(rule(character, left) + label + rule(character, remaining - left))];
};

/** Render a Badge element. */
const badge: ComponentRenderer = ({ node }) => {
  const variant = oneOf(node.props, "variant", BADGE_VARIANTS) ?? "default";
  const color = VARIANT_COLOR[variant] ?? "gray";
  return [bg(color, style(SGR.bold, ` ${str(node.props, "label")} `))];
};

/** Render a Card element: optional title plus children on a plain background. */
const card: ComponentRenderer = ({ node, width, children }) => {
  const padding = Math.max(0, Math.floor(num(node.props, "padding", 1)));
  const innerWidth = Math.max(1, Math.floor(width) - padding * 2);
  const title = optionalStr(node.props, "title");
  const body = children(innerWidth);
  const lines = [...(title ? [style(SGR.bold, clampLine(title, innerWidth))] : []), ...body];
  const padded = [
    ...Array.from({ length: padding }, () => ""),
    ...lines.map((line) => " ".repeat(padding) + line),
    ...Array.from({ length: padding }, () => ""),
  ];
  const backgroundColor = optionalStr(node.props, "backgroundColor");
  return padded.map((line) => {
    const full = padLine(clampLine(line, Math.floor(width)), Math.floor(width));
    return backgroundColor ? bg(backgroundColor, full) : full;
  });
};

/** Render a KeyValue element. */
const keyValue: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const separator = optionalStr(props, "separator") ?? ":";
  const rawValue = props.value;
  const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue ?? "");
  const label = fg(optionalStr(props, "labelColor") ?? "cyan", `${str(props, "label")}${separator}`);
  const text = `${label} ${value}`;
  return wrap(text, Math.max(1, width)).map((line) => clampLine(line, Math.max(1, width)));
};

/** Render a Link element as an OSC 8 hyperlink. */
const link: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const url = str(props, "url");
  const label = optionalStr(props, "label");
  const text = label ? `${label} (${url})` : url;
  const styled = paint(hyperlink(url, text), { underline: true, color: optionalStr(props, "color") ?? "blue" });
  return wrap(styled, Math.max(1, width));
};

/** Render a StatusLine element. */
const statusLine: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const status = oneOf(props, "status", STATUS_VALUES) ?? "info";
  const color = VARIANT_COLOR[status] ?? "gray";
  const icon = optionalStr(props, "icon") ?? STATUS_ICON[status] ?? "ℹ";
  const text = `${fg(color, icon)} ${str(props, "text")}`;
  return wrap(text, Math.max(1, width)).map((line) => clampLine(line, Math.max(1, width)));
};

/** Render a List element. */
const listComponent: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const items = list<string>(props, "items");
  const ordered = bool(props, "ordered");
  const bulletChar = optionalStr(props, "bulletChar");
  const spacing = Math.max(0, Math.floor(num(props, "spacing", 0)));
  const out: string[] = [];
  items.forEach((item, index) => {
    if (index > 0) for (let line = 0; line < spacing; line += 1) out.push("");
    const marker = bulletChar ?? (ordered ? `${index + 1}.` : "•");
    const prefix = `${marker} `;
    const indent = " ".repeat(visibleWidth(prefix));
    const wrapped = wrap(String(item), Math.max(1, width - visibleWidth(prefix)));
    wrapped.forEach((line, position) => {
      out.push(clampLine(position === 0 ? fg("cyan", prefix) + line : indent + line, Math.max(1, width)));
    });
  });
  return out;
};

/** Render a ListItem element: title row with optional leading/trailing text, then subtitle. */
const listItem: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const available = Math.max(1, Math.floor(width));
  const leading = optionalStr(props, "leading");
  const trailing = optionalStr(props, "trailing");
  const title = `${leading ? `${leading} ` : ""}${str(props, "title")}`;
  const trailingWidth = trailing ? visibleWidth(trailing) + 2 : 0;
  const head = padLine(clampLine(title, Math.max(1, available - trailingWidth)), Math.max(1, available - trailingWidth));
  const first = trailing ? style(SGR.bold, head) + "  " + fg("gray", trailing) : style(SGR.bold, head);
  const lines = [clampLine(first, available)];
  const subtitle = optionalStr(props, "subtitle");
  if (subtitle) {
    for (const line of wrap(subtitle, available - 2)) lines.push(fg("gray", `  ${line}`));
  }
  return lines;
};

/** Render a Markdown element with the built-in lightweight renderer. */
const markdown: ComponentRenderer = ({ node, width }) =>
  renderMarkdown(str(node.props, "text"), Math.max(1, width));

/** Render a Callout element with a colored left border. */
const callout: ComponentRenderer = ({ node, width }) => {
  const props = node.props;
  const type = oneOf(props, "type", CALLOUT_TYPES) ?? "info";
  const color = VARIANT_COLOR[type] ?? "blue";
  const available = Math.max(1, Math.floor(width));
  const innerWidth = Math.max(1, available - 2);
  const title = optionalStr(props, "title");
  const body = wrap(str(props, "content"), innerWidth);
  const content = [...(title ? [style(SGR.bold, clampLine(title, innerWidth))] : []), ...body];
  return content.map((line) => fg(color, "│ ") + clampLine(line, innerWidth));
};

/** Render a Metric element. */
const metric: ComponentRenderer = ({ node }) => {
  const props = node.props;
  const trend = oneOf(props, "trend", TRENDS);
  const arrow = trend ? ` ${fg(TREND_COLOR[trend] ?? "gray", TREND_ARROW[trend] ?? "")}` : "";
  const detail = optionalStr(props, "detail");
  return [
    fg("gray", str(props, "label")),
    `${style(SGR.bold, str(props, "value"))}${arrow}`,
    ...(detail ? [fg("dim", detail)] : []),
  ];
};

/** Render a Timeline element. */
const timeline: ComponentRenderer = ({ node, width }) => {
  const items = list<Record<string, unknown>>(node.props, "items");
  const available = Math.max(1, Math.floor(width));
  const out: string[] = [];

  items.forEach((item, index) => {
    const status = oneOf(item, "status", TIMELINE_STATUSES) ?? "upcoming";
    const color = status === "completed" ? "green" : status === "current" ? "cyan" : "gray";
    const dot = status === "completed" ? "✔" : status === "current" ? "●" : "○";
    const date = optionalStr(item, "date");
    const title = str(item, "title");
    const dateWidth = date ? visibleWidth(date) + 2 : 0;
    const head = clampLine(title, Math.max(1, available - 4 - dateWidth));
    const row = padLine(style(SGR.bold, head), Math.max(1, available - 4 - dateWidth));
    out.push(`${fg(color, dot)} ${row}${date ? "  " + fg("gray", date) : ""}`.trimEnd());

    const description = optionalStr(item, "description");
    if (description) {
      for (const line of wrap(description, Math.max(1, available - 4))) {
        out.push(fg("gray", index === items.length - 1 ? "  " : "│ ") + " " + line);
      }
    }
    if (index < items.length - 1 && !description) out.push(fg("gray", "│"));
  });

  return out;
};

export const contentComponents = {
  Heading: heading,
  Divider: divider,
  Badge: badge,
  Card: card,
  KeyValue: keyValue,
  Link: link,
  StatusLine: statusLine,
  List: listComponent,
  ListItem: listItem,
  Markdown: markdown,
  Callout: callout,
  Metric: metric,
  Timeline: timeline,
} satisfies Record<string, ComponentRenderer>;

export { VARIANT_COLOR, centerLine, rightAlignLine, rule };
