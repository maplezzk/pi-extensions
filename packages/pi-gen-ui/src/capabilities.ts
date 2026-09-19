/**
 * Which catalog props the Pi renderer actually honors.
 *
 * The catalog keeps Ink's full prop surface so specs stay interchangeable. The
 * renderer only implements a subset, so every prop that is declared but not
 * listed here is reported through `ctx.warn(...)` and returned with the tool
 * result. Silently dropping a prop would produce a UI that looks wrong for
 * reasons the model cannot see.
 */

/** Props the renderer honors, per catalog component. */
export const SUPPORTED_PROPS: Readonly<Record<string, readonly string[]>> = {
  Box: [
    "flexDirection",
    "alignItems",
    "justifyContent",
    "flexGrow",
    "flexShrink",
    "width",
    "padding",
    "paddingX",
    "paddingY",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "gap",
    "columnGap",
    "rowGap",
    "borderStyle",
    "borderColor",
    "borderTop",
    "borderBottom",
    "borderLeft",
    "borderRight",
    "display",
    "backgroundColor",
  ],
  Text: [
    "text",
    "color",
    "backgroundColor",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "dimColor",
    "inverse",
    "wrap",
  ],
  Newline: ["count"],
  Spacer: [],
  Heading: ["text", "level", "color"],
  Divider: ["character", "color", "dimColor", "title", "width"],
  Badge: ["label", "variant"],
  Spinner: ["label", "color"],
  ProgressBar: ["progress", "width", "color", "label"],
  Sparkline: ["data", "width", "color", "label", "min", "max"],
  BarChart: ["data", "width", "showValues", "showPercentage"],
  Table: ["columns", "rows", "borderStyle", "backgroundColor", "headerColor"],
  List: ["items", "ordered", "bulletChar", "spacing"],
  ListItem: ["title", "subtitle", "leading", "trailing"],
  Card: ["title", "backgroundColor", "padding"],
  KeyValue: ["label", "value", "labelColor", "separator"],
  Link: ["url", "label", "color"],
  StatusLine: ["text", "status", "icon"],
  Metric: ["label", "value", "detail", "trend"],
  Callout: ["type", "title", "content"],
  Timeline: ["items"],
  Markdown: ["text"],
  TextInput: ["placeholder", "value", "label", "mask"],
  Select: ["options", "value", "label"],
  MultiSelect: ["options", "value", "label", "min", "max"],
  ConfirmInput: ["message", "defaultValue", "yesLabel", "noLabel"],
  Tabs: ["tabs", "value", "color"],
};

/** `borderStyle` values the Pi border painter can draw. */
export const SUPPORTED_BORDER_STYLES: readonly string[] = ["single", "double", "round", "bold", "classic"];

/** Return the declared props of a component that the renderer ignores. */
export function unsupportedProps(component: string, props: Record<string, unknown>): string[] {
  const supported = SUPPORTED_PROPS[component];
  if (!supported) return Object.keys(props);
  return Object.keys(props).filter((name) => !supported.includes(name));
}
