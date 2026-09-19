import { CURSOR_MARKER, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";import type { ComponentArgs, ComponentRenderer } from "../types.ts";
import { bool, list, num, optionalStr, str } from "../props.ts";
import { SGR, fg, style } from "../ansi.ts";
import { clampLine, padLine } from "../layout.ts";

/** Component names that accept keyboard focus. */
export const INTERACTIVE_COMPONENTS: readonly string[] = [
  "TextInput",
  "Select",
  "MultiSelect",
  "ConfirmInput",
  "Tabs",
];

/** Local-state key for an interactive element's cursor. */
function cursorKey(elementKey: string): string {
  return `cursor:${elementKey}`;
}

/** Local-state key for an interactive element's edit buffer. */
function bufferKey(elementKey: string): string {
  return `buffer:${elementKey}`;
}

/** Local-state key tracking whether an element has been interacted with. */
function touchedKey(elementKey: string): string {
  return `touched:${elementKey}`;
}

/** Read a numeric cursor from local state, clamped to the option count. */
function readCursor(ctx: ComponentArgs["ctx"], elementKey: string, count: number, fallback: number): number {
  const raw = ctx.local.get(cursorKey(elementKey));
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, value));
}

/** Persist the cursor in local state and ask for a re-render. */
function writeCursor(ctx: ComponentArgs["ctx"], elementKey: string, index: number): void {
  ctx.setLocal(cursorKey(elementKey), index);
}

/** Whether the renderer gave this element keyboard focus. */
function isFocused(ctx: ComponentArgs["ctx"], elementKey: string): boolean {
  return ctx.focusOrder.length === 0 || ctx.focusOrder.includes(elementKey);
}

/** Write a bound value into the state model; falls back to local state without a binding. */
function commitValue(args: ComponentArgs, propName: string, value: unknown): void {
  const path = args.node.bindings?.[propName];
  if (path) {
    args.ctx.setState(path, value);
    args.ctx.setLocal(touchedKey(args.node.key), true);
    return;
  }
  args.ctx.setLocal(`${args.node.key}:${propName}`, value);
  args.ctx.setLocal(touchedKey(args.node.key), true);
}

/** Current value of a bound prop: the edit buffer when present, else the resolved prop. */
function currentValue(args: ComponentArgs, propName: string, fallback: unknown): unknown {
  const buffer = args.ctx.local.get(bufferKey(args.node.key));
  if (buffer !== undefined) return buffer;
  const local = args.ctx.local.get(`${args.node.key}:${propName}`);
  if (local !== undefined) return local;
  const resolved = args.node.props[propName];
  return resolved === undefined || resolved === null ? fallback : resolved;
}

/** Render a single-line text input. */
const textInput: ComponentRenderer = (args) => {
  const { node, ctx, width } = args;
  const label = optionalStr(node.props, "label");
  const placeholder = optionalStr(node.props, "placeholder") ?? "";
  const mask = optionalStr(node.props, "mask");
  const value = String(currentValue(args, "value", "") ?? "");
  const focused = isFocused(ctx, node.key);
  const display = mask ? mask.repeat(value.length) : value;
  const body = value.length === 0 ? fg("gray", placeholder) : display;
  // The marker only helps when Pi actually positions the hardware cursor; a
  // raw APC sequence in the transcript would otherwise leak into copied text.
  const cursor = focused && ctx.hardwareCursor ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : "";
  const prefix = label ? `${style(SGR.bold, label)}: ` : "";
  const available = Math.max(1, Math.floor(width));
  const lines = [clampLine(`${prefix}${body}${cursor}`, available)];

  ctx.registerInteractive({
    id: node.key,
    elementKey: node.key,
    component: "TextInput",
    height: lines.length,
    handleInput(data: string): boolean {
      if (matchesKey(data, Key.enter)) {
        commitValue(args, "value", value);
        ctx.dispatch(node.key, "submit", node.element.on?.submit ?? node.element.on?.press ?? []);
        return true;
      }
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        const next = value.slice(0, -1);
        commitValue(args, "value", next);
        ctx.setLocal(bufferKey(node.key), next);
        ctx.dispatch(node.key, "change", node.element.on?.change ?? []);
        return true;
      }
      const printable = data.length === 1 && data >= " " && data !== "\x7f";
      if (printable) {
        const next = value + data;
        commitValue(args, "value", next);
        ctx.setLocal(bufferKey(node.key), next);
        ctx.dispatch(node.key, "change", node.element.on?.change ?? []);
        return true;
      }
      return false;
    },
  });

  return lines;
};

/** Render a single-choice selection list. */
const select: ComponentRenderer = (args) => {
  const { node, ctx, width } = args;
  const options = list<{ label?: unknown; value?: unknown }>(node.props, "options").map((option) => ({
    label: str(option as Record<string, unknown>, "label"),
    value: str(option as Record<string, unknown>, "value"),
  }));
  const label = optionalStr(node.props, "label");
  const selected = String(currentValue(args, "value", options[0]?.value ?? "") ?? "");
  const currentIndex = Math.max(0, options.findIndex((option) => option.value === selected));
  const focused = isFocused(ctx, node.key);
  const cursor = readCursor(ctx, node.key, options.length, currentIndex);
  const available = Math.max(1, Math.floor(width));

  const lines: string[] = [];
  if (label) lines.push(style(SGR.bold, label));
  options.forEach((option, index) => {
    const active = index === (focused ? cursor : currentIndex);
    const marker = focused && index === cursor ? "› " : "  ";
    const text = clampLine(`${marker}${option.label}`, available);
    lines.push(active ? fg("cyan", style(SGR.bold, padLine(text, available))) : text);
  });

  ctx.registerInteractive({
    id: node.key,
    elementKey: node.key,
    component: "Select",
    height: lines.length,
    handleInput(data: string): boolean {
      if (options.length === 0) return false;
      if (matchesKey(data, Key.up)) {
        writeCursor(ctx, node.key, Math.max(0, cursor - 1));
        return true;
      }
      if (matchesKey(data, Key.down)) {
        writeCursor(ctx, node.key, Math.min(options.length - 1, cursor + 1));
        return true;
      }
      if (matchesKey(data, Key.enter)) {
        commitValue(args, "value", options[cursor]?.value ?? "");
        ctx.dispatch(node.key, "change", node.element.on?.change ?? []);
        return true;
      }
      return false;
    },
  });

  return lines;
};

/** Render a multi-choice selection list. */
const multiSelect: ComponentRenderer = (args) => {
  const { node, ctx, width } = args;
  const options = list<{ label?: unknown; value?: unknown }>(node.props, "options").map((option) => ({
    label: str(option as Record<string, unknown>, "label"),
    value: str(option as Record<string, unknown>, "value"),
  }));
  const label = optionalStr(node.props, "label");
  const rawSelected = currentValue(args, "value", []);
  const selectedValues = new Set((Array.isArray(rawSelected) ? rawSelected : []).map((value) => String(value)));
  const focused = isFocused(ctx, node.key);
  const cursor = readCursor(ctx, node.key, options.length, 0);
  const min = num(node.props, "min", 0);
  const max = num(node.props, "max", Number.POSITIVE_INFINITY);
  const available = Math.max(1, Math.floor(width));

  const lines: string[] = [];
  if (label) lines.push(style(SGR.bold, label));
  options.forEach((option, index) => {
    const checked = selectedValues.has(option.value);
    const marker = focused && index === cursor ? "› " : "  ";
    const box = checked ? fg("green", "[x]") : fg("gray", "[ ]");
    lines.push(clampLine(`${marker}${box} ${option.label}`, available));
  });

  ctx.registerInteractive({
    id: node.key,
    elementKey: node.key,
    component: "MultiSelect",
    height: lines.length,
    handleInput(data: string): boolean {
      if (options.length === 0) return false;
      if (matchesKey(data, Key.up)) {
        writeCursor(ctx, node.key, Math.max(0, cursor - 1));
        return true;
      }
      if (matchesKey(data, Key.down)) {
        writeCursor(ctx, node.key, Math.min(options.length - 1, cursor + 1));
        return true;
      }
      if (matchesKey(data, Key.space)) {
        const next = new Set(selectedValues);
        const value = options[cursor]?.value ?? "";
        if (next.has(value)) next.delete(value);
        else if (next.size < max) next.add(value);
        if (next.size < min) {
          ctx.warn(`Element "${node.key}" (MultiSelect) requires at least ${min} selections; the toggle was rejected.`);
          return true;
        }
        commitValue(args, "value", [...next]);
        ctx.dispatch(node.key, "change", node.element.on?.change ?? []);
        return true;
      }
      if (matchesKey(data, Key.enter)) {
        if (selectedValues.size < min) {
          ctx.warn(
            `Element "${node.key}" (MultiSelect) needs at least ${min} selections before submitting; currently ${selectedValues.size}.`,
          );
          return true;
        }
        commitValue(args, "value", [...selectedValues]);
        ctx.dispatch(node.key, "submit", node.element.on?.submit ?? []);
        return true;
      }
      return false;
    },
  });

  return lines;
};

/** Render a yes/no confirmation prompt. */
const confirmInput: ComponentRenderer = (args) => {
  const { node, ctx, width } = args;
  const message = optionalStr(node.props, "message") ?? "Confirm?";
  const defaultYes = bool(node.props, "defaultValue");
  const yesLabel = optionalStr(node.props, "yesLabel") ?? "y";
  const noLabel = optionalStr(node.props, "noLabel") ?? "n";
  const hint = defaultYes ? `${noLabel}/[${yesLabel}]` : `[${yesLabel}]/${noLabel}`;
  const line = clampLine(`${style(SGR.bold, message)} ${fg("gray", hint)}`, Math.max(1, Math.floor(width)));

  ctx.registerInteractive({
    id: node.key,
    elementKey: node.key,
    component: "ConfirmInput",
    height: 1,
    handleInput(data: string): boolean {
      const lowered = data.toLowerCase();
      if (lowered === yesLabel.toLowerCase() || matchesKey(data, Key.enter)) {
        ctx.dispatch(node.key, "confirm", node.element.on?.confirm ?? []);
        return true;
      }
      if (lowered === noLabel.toLowerCase() || matchesKey(data, Key.escape)) {
        ctx.dispatch(node.key, "deny", node.element.on?.deny ?? []);
        return true;
      }
      return false;
    },
  });

  return [line];
};

/** Render a tab bar; the panel content stays in the element's children. */
const tabs: ComponentRenderer = (args) => {
  const { node, ctx, width } = args;
  const tabsList = list<{ label?: unknown; value?: unknown; icon?: unknown }>(node.props, "tabs").map((tab) => ({
    label: str(tab as Record<string, unknown>, "label"),
    value: str(tab as Record<string, unknown>, "value"),
    icon: optionalStr(tab as Record<string, unknown>, "icon"),
  }));
  const color = optionalStr(node.props, "color") ?? "cyan";
  const active = String(currentValue(args, "value", tabsList[0]?.value ?? "") ?? "");
  const focused = isFocused(ctx, node.key);
  const available = Math.max(1, Math.floor(width));

  const parts = tabsList.map((tab) => {
    const text = `${tab.icon ? `${tab.icon} ` : ""}${tab.label}`;
    return tab.value === active ? fg(color, style(SGR.bold, ` ${text} `)) : fg("gray", ` ${text} `);
  });
  const line = clampLine(parts.join(fg("gray", "│")), available);

  ctx.registerInteractive({
    id: node.key,
    elementKey: node.key,
    component: "Tabs",
    height: 1,
    handleInput(data: string): boolean {
      if (tabsList.length === 0) return false;
      const currentIndex = Math.max(0, tabsList.findIndex((tab) => tab.value === active));
      let nextIndex: number | undefined;
      if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
        nextIndex = (currentIndex - 1 + tabsList.length) % tabsList.length;
      } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
        nextIndex = (currentIndex + 1) % tabsList.length;
      }
      if (nextIndex === undefined) return false;
      commitValue(args, "value", tabsList[nextIndex]?.value ?? "");
      ctx.dispatch(node.key, "change", node.element.on?.change ?? []);
      return true;
    },
  });

  return [line];
};

export const interactiveComponents = {
  TextInput: textInput,
  Select: select,
  MultiSelect: multiSelect,
  ConfirmInput: confirmInput,
  Tabs: tabs,
} satisfies Record<string, ComponentRenderer>;

export { visibleWidth };
