import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  EditorComponent,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  decodeKittyPrintable,
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ResourceKind, SessionResource } from "./collector.ts";
import { i18n } from "./i18n.ts";
import {
  KIND_COLORS,
  RESOURCE_ACCENT,
  kindColored,
  linkUri,
  resourceItem,
  resourceMatches,
  type ResourceSuggestion,
} from "./autocomplete.ts";

export const RESOURCE_PICKER_VISIBLE_LIMIT = 6;

/** First window index that keeps one selected row inside the visible window. */
function resourceWindowStart(itemCount: number, selectedIndex: number): number {
  if (itemCount <= RESOURCE_PICKER_VISIBLE_LIMIT) return 0;
  const centered = Math.max(0, selectedIndex - Math.floor(RESOURCE_PICKER_VISIBLE_LIMIT / 2));
  return Math.min(itemCount - RESOURCE_PICKER_VISIBLE_LIMIT, centered);
}

const PANEL_BORDER_WIDTH = 2;
const PANEL_MINIMUM_WIDTH = 4;
const DESCRIPTION_MINIMUM_WIDTH = 48;
const DESCRIPTION_MAXIMUM_WIDTH = 22;
const DESCRIPTION_WIDTH_RATIO = 0.28;
const ITEM_COLUMN_GAP = 2;
/** Joins the per-type counts in the collapsed resource button. */
const BUTTON_SUMMARY_SEPARATOR = " · ";
/** Joins the hint row's own items: hint text, scroll counter, close label. */
const HINT_ITEM_SEPARATOR = " · ";
/** Panel rows above the resource list: top border, tab row, divider. */
const PANEL_HEADER_ROWS = 3;
/** Panel rows below the resource list: divider, hint row, bottom border. */
const PANEL_FOOTER_ROWS = 3;
/** Panel row index of the first resource row. */
const PANEL_ITEM_START_ROW = PANEL_HEADER_ROWS;
/** First column inside the panel frame, i.e. just after the left border. */
const PANEL_CONTENT_START_COLUMN = 1;
/** Mouse handling is only possible when Pi's fullscreen renderer owns the pointer. */
const FULLSCREEN_TUI_MODE = "fullscreen";
const CONTROL_CHARACTER_LIMIT = 32;
const BACKSPACE_INPUT = "\x7f";
const RESOURCE_TABS: readonly ResourceKind[] = ["file", "review", "web"];
const TAB_LABELS: Record<ResourceKind, string> = {
  file: "FILE",
  review: "PR/MR",
  web: "URL",
};
const THEME_COLOR = {
  dim: "dim",
  muted: "muted",
  text: "text",
} as const;
const THEME_BACKGROUND = {
  selected: "selectedBg",
} as const;
const ANSI_RESET = "\x1b[0m";

export type ResourcePickerTheme = Pick<Theme, "bg" | "bold" | "fg">;

interface CursorAwareEditor {
  getLines?(): string[];
  getCursor?(): { line: number; col: number };
}

interface AppAwareEditor {
  actionHandlers?: Map<unknown, () => void>;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
  focused?: boolean;
  wantsKeyRelease?: boolean;
  dispose?(): void;
}

export interface SessionResourceEditorOptions {
  theme: ResourcePickerTheme;
  keybindings: Pick<KeybindingsManager, "matches">;
  getResources: () => readonly SessionResource[];
  isEnabled: () => boolean;
  /** Reports whether the host TUI routes mouse input to components (Pi fullscreen mode). */
  isMouseEnabled: () => boolean;
  requestRender: () => void;
}

/** One tab cell of the picker header, shared by rendering and mouse hit testing. */
export interface ResourceTabSegment {
  kind: ResourceKind;
  /** Plain tab text before styling; its width drives the segment layout. */
  text: string;
  /** Zero-based column where the segment starts inside the framed panel. */
  start: number;
  width: number;
}

/** One per-type count chip of the collapsed resource button, shared by rendering and hit testing. */
export interface ResourceButtonSegment {
  kind: ResourceKind;
  /** Plain chip text, for example `FILE 3`. */
  text: string;
  /** Zero-based column where the chip starts. */
  start: number;
  width: number;
}

/** Clickable close label drawn at the end of the picker's hint row. */
export interface ResourceCloseSegment {
  /** Zero-based panel column where the label starts. */
  start: number;
  width: number;
}

/** Hint row layout while the picker panel is open, shared by rendering and hit testing. */
interface HintRowLayout {
  /** Plain hint text; the row draws it after one leading space. */
  hint: string;
  /** Right-aligned scroll counter, present only while matches stay off-window. */
  counter?: string;
  /** Clickable close label; absent without mouse input or horizontal room. */
  close?: ResourceCloseSegment & { label: string };
}

/** Header cell under the pointer. */
export type HeaderTarget =
  | { kind: "button" }
  | { kind: "buttonCount"; segment: ResourceButtonSegment }
  | { kind: "close" }
  | { kind: "tab"; segment: ResourceTabSegment }
  | { kind: "item"; index: number }
  | { kind: "empty" };

/** Header layout while the full picker panel is open above the editor. */
interface PanelHeaderLayout {
  kind: "panel";
  /** Lines the picker occupies above the wrapped editor. */
  height: number;
  width: number;
  segments: readonly ResourceTabSegment[];
  /** Hint row content, including the clickable close label. */
  hintRow: HintRowLayout;
  /** Resource rows rendered at once. */
  itemCount: number;
  /** Index of the first rendered resource row. */
  windowStart: number;
}

/** Header layout while only the collapsed resource button is visible. */
interface ButtonHeaderLayout {
  kind: "button";
  height: number;
  segments: readonly ResourceButtonSegment[];
}

/** Rows this editor renders above the wrapped editor, if any. */
type HeaderLayout = PanelHeaderLayout | ButtonHeaderLayout;

export interface RenderResourcePickerOptions {
  resources: readonly SessionResource[];
  activeKind: ResourceKind;
  query: string;
  selectedIndex: number;
  width: number;
  theme: ResourcePickerTheme;
  /** Pre-computed tab layout so hit testing and rendering cannot drift apart. */
  segments?: readonly ResourceTabSegment[];
  /** Pre-computed hint row layout, including its clickable close label. */
  hintRow?: HintRowLayout;
  /** Index of the first rendered resource row; the picker scrolls a fixed-size window. */
  windowStart?: number;
  /** Header cell that currently renders its hover highlight. */
  hoverTarget?: HeaderTarget;
  /** Switches the hint row to the mouse-capable wording (Pi fullscreen mode). */
  mouseEnabled?: boolean;
}

/** Options for rendering the picker tab row from a pre-computed segment layout. */
interface RenderTabsOptions {
  segments: readonly ResourceTabSegment[];
  activeKind: ResourceKind;
  innerWidth: number;
  theme: ResourcePickerTheme;
  /** Inactive tab under the pointer; rendered with the accent color as a hover cue. */
  hoveredKind?: ResourceKind;
}

interface RenderItemOptions {
  kind: ResourceKind;
  label: string;
  /** Visible width of the plain label; defaults to the ANSI-aware measurement. */
  labelWidth?: number;
  /** OSC 8 target applied after styling so the clickable text stays intact. */
  linkUri?: string;
  description?: string;
  selected: boolean;
  /** Renders the hover background without changing row selection. */
  hovered?: boolean;
  innerWidth: number;
  theme: ResourcePickerTheme;
}

/** Pads one ANSI-aware row without exceeding its assigned width. */
function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Applies the active resource type's fixed accent color. */
function kindAccent(kind: ResourceKind, text: string): string {
  return `${KIND_COLORS[kind]}${text}${ANSI_RESET}`;
}

/** Adds accent-colored vertical borders around one fitted panel row. */
function framedLine(content: string, innerWidth: number, accentKind: ResourceKind): string {
  const fitted = padToWidth(truncateToWidth(content, innerWidth, ""), innerWidth);
  return `${kindAccent(accentKind, "│")}${fitted}${kindAccent(accentKind, "│")}`;
}

/** Renders the picker title inside a rounded accent border. */
function renderTopBorder(width: number, accentKind: ResourceKind): string {
  const innerWidth = Math.max(0, width - PANEL_BORDER_WIDTH);
  const title = `─ ${i18n.t("pickerTitle")} `;
  const titleWidth = Math.min(visibleWidth(title), innerWidth);
  const fittedTitle = truncateToWidth(title, titleWidth, "");
  const border = `╭${fittedTitle}${"─".repeat(Math.max(0, innerWidth - visibleWidth(fittedTitle)))}╮`;
  return kindAccent(accentKind, border);
}

/** Renders a horizontal accent divider at the current panel width. */
function renderDivider(width: number, accentKind: ResourceKind): string {
  return kindAccent(accentKind, `├${"─".repeat(Math.max(0, width - PANEL_BORDER_WIDTH))}┤`);
}

/** Renders the rounded accent border at the current panel width. */
function renderBottomBorder(width: number, accentKind: ResourceKind): string {
  return kindAccent(accentKind, `╰${"─".repeat(Math.max(0, width - PANEL_BORDER_WIDTH))}╯`);
}

/** Detects Pi's fullscreen renderer, the only mode that routes mouse input to components. */
export function isFullscreenTui(tui: { mode?: string } | undefined): boolean {
  return tui?.mode === FULLSCREEN_TUI_MODE;
}

/** Counts resources per type for tab and button labels. */
export function resourceCounts(
  resources: readonly SessionResource[],
): Map<ResourceKind, number> {
  const counts = new Map<ResourceKind, number>();
  for (const resource of resources) {
    counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
  }
  return counts;
}

/** Lays out tab segments once so rendering and mouse hit testing cannot drift apart. */
export function resourceTabSegments(
  resources: readonly SessionResource[],
): ResourceTabSegment[] {
  const counts = resourceCounts(resources);
  const segments: ResourceTabSegment[] = [];
  let start = PANEL_CONTENT_START_COLUMN;
  for (const kind of RESOURCE_TABS) {
    const text = ` ${TAB_LABELS[kind]} ${counts.get(kind) ?? 0} `;
    const width = visibleWidth(text);
    segments.push({ kind, text, start, width });
    start += width + 1;
  }
  return segments;
}

/** Resolves the header cell at one header-local coordinate. */
function hitHeaderTarget(layout: HeaderLayout, column: number, row: number): HeaderTarget {
  if (layout.kind === "button") {
    if (row !== 0) return { kind: "empty" };
    const segment = layout.segments.find(
      (candidate) => column >= candidate.start && column < candidate.start + candidate.width,
    );
    return segment ? { kind: "buttonCount", segment } : { kind: "button" };
  }
  if (row === layout.height - (PANEL_FOOTER_ROWS - 1)) {
    const close = layout.hintRow.close;
    return close && column >= close.start && column < close.start + close.width
      ? { kind: "close" }
      : { kind: "empty" };
  }
  if (row === 1) {
    const segment = layout.segments.find(
      (candidate) => column >= candidate.start && column < candidate.start + candidate.width,
    );
    return segment ? { kind: "tab", segment } : { kind: "empty" };
  }
  const rowIndex = row - PANEL_ITEM_START_ROW;
  return rowIndex >= 0 && rowIndex < layout.itemCount
    ? { kind: "item", index: layout.windowStart + rowIndex }
    : { kind: "empty" };
}

/** Returns every match for one resource type and query; the picker scrolls a fixed-size window. */
function matchedItems(
  resources: readonly SessionResource[],
  kind: ResourceKind,
  query: string,
): ResourceSuggestion[] {
  return resourceMatches(
    resources.filter((resource) => resource.kind === kind),
    query,
  ).map(resourceItem);
}

/** Right-aligned `n/total` scroll counter, absent while every match fits on screen. */
function scrollCounter(selectedIndex: number, total: number): string | undefined {
  return total > RESOURCE_PICKER_VISIBLE_LIMIT ? `${selectedIndex + 1}/${total}` : undefined;
}

/**
 * Lays out the hint row once so rendering and mouse hit testing cannot drift apart.
 * The close label is only offered when the hint, the label, and the counter all fit.
 */
function hintRowLayout(options: {
  mouseEnabled: boolean;
  counter: string | undefined;
  innerWidth: number;
}): HintRowLayout {
  const { mouseEnabled, counter, innerWidth } = options;
  const layout: HintRowLayout = { hint: i18n.t(mouseEnabled ? "pickerHintMouse" : "pickerHint") };
  if (counter) layout.counter = counter;
  if (!mouseEnabled) return layout;

  const label = i18n.t("pickerClose");
  const start = PANEL_CONTENT_START_COLUMN + 1
    + visibleWidth(layout.hint) + visibleWidth(HINT_ITEM_SEPARATOR);
  const width = visibleWidth(label);
  const counterWidth = counter ? visibleWidth(counter) + 1 : 0;
  if (start + width > innerWidth - counterWidth) return layout;
  layout.close = { label, start, width };
  return layout;
}

/** Renders per-type counts; the active type is inverted, inactive types stay muted. */
function renderTabs(options: RenderTabsOptions): string {
  const { segments, activeKind, innerWidth, theme, hoveredKind } = options;
  const rendered = segments.map((segment) => {
    if (segment.kind === activeKind) {
      return theme.bg(THEME_BACKGROUND.selected, kindColored(segment.kind, segment.text));
    }
    if (segment.kind === hoveredKind) return kindColored(segment.kind, segment.text);
    return theme.fg(THEME_COLOR.muted, segment.text);
  });
  return truncateToWidth(rendered.join(" "), innerWidth, "");
}

/** Renders one width-safe resource row with optional dimmed action metadata. */
function renderItem(options: RenderItemOptions): string {
  const { kind, label, description, selected, innerWidth, theme } = options;
  const rawPrefix = selected ? "→ " : "  ";
  const prefixWidth = visibleWidth(rawPrefix);
  const showDescription = Boolean(description) && innerWidth >= DESCRIPTION_MINIMUM_WIDTH;
  const descriptionWidth = showDescription
    ? Math.min(DESCRIPTION_MAXIMUM_WIDTH, Math.floor(innerWidth * DESCRIPTION_WIDTH_RATIO))
    : 0;
  const gapWidth = showDescription ? ITEM_COLUMN_GAP : 0;
  const labelWidth = Math.max(1, innerWidth - prefixWidth - descriptionWidth - gapWidth);
  const plainLabelWidth = options.labelWidth ?? visibleWidth(label);
  const truncated = plainLabelWidth > labelWidth;
  const fittedLabel = truncateToWidth(label, labelWidth, "…");
  const fittedDescription = showDescription
    ? truncateToWidth(description ?? "", descriptionWidth, "…")
    : "";
  const gap = " ".repeat(Math.max(1, labelWidth - (truncated ? labelWidth : plainLabelWidth) + gapWidth));
  const prefix = selected ? kindAccent(kind, rawPrefix) : rawPrefix;
  const styledLabel = selected ? kindAccent(kind, theme.bold(fittedLabel)) : fittedLabel;
  const primary = `${prefix}${styledLabel}`;
  const secondary = showDescription
    ? theme.fg(THEME_COLOR.dim, `${gap}${fittedDescription}`)
    : "";
  const row = padToWidth(`${primary}${secondary}`, innerWidth);
  // The whole row is the OSC 8 target so the clickable area matches the visible row,
  // which is what Pi's fullscreen renderer opens on a plain click.
  return linkUri(options.hovered ? theme.bg(THEME_BACKGROUND.selected, row) : row, options.linkUri);
}

/** Options for the collapsed one-line resource browser button above the editor. */
export interface RenderResourceButtonOptions {
  resources: readonly SessionResource[];
  width: number;
  theme: ResourcePickerTheme;
  /** Highlights the button label; the pointer rests outside every count chip. */
  labelHovered: boolean;
  /** Count chip under the pointer; the chip becomes its own click target. */
  hoveredKind?: ResourceKind;
  /** Pre-computed chip layout so hit testing and rendering cannot drift apart. */
  segments?: readonly ResourceButtonSegment[];
}

/** Plain button label text, shared by its layout math and its rendering. */
function resourceButtonLabelText(): string {
  return ` ${i18n.t("viewResources")} `;
}

/** Lays out the count chips once so rendering and mouse hit testing cannot drift apart. */
export function resourceButtonSegments(
  resources: readonly SessionResource[],
): ResourceButtonSegment[] {
  const counts = resourceCounts(resources);
  const segments: ResourceButtonSegment[] = [];
  let start = visibleWidth(resourceButtonLabelText()) + 1;
  for (const kind of RESOURCE_TABS) {
    const text = `${TAB_LABELS[kind]} ${counts.get(kind) ?? 0}`;
    const width = visibleWidth(text);
    segments.push({ kind, text, start, width });
    start += width + visibleWidth(BUTTON_SUMMARY_SEPARATOR);
  }
  return segments;
}

/**
 * Renders the collapsed one-line resource button shown above the editor.
 * The label opens the picker on its current type, while each count chip opens the
 * picker directly on that type.
 * Returns an empty array when the terminal is too narrow to draw anything, so the
 * caller renders no header row instead of a zero-width line.
 */
export function renderResourceButton(options: RenderResourceButtonOptions): string[] {
  const { resources, width, theme, labelHovered, hoveredKind } = options;
  if (width <= 0) return [];
  const segments = options.segments ?? resourceButtonSegments(resources);
  // The label covers every resource type, so it uses the shared accent instead of a kind accent.
  const label = `${RESOURCE_ACCENT}${theme.bold(resourceButtonLabelText())}${ANSI_RESET}`;
  const labelRow = labelHovered ? theme.bg(THEME_BACKGROUND.selected, label) : label;
  const chips = segments
    .map((segment, index) => {
      const text = `${index === 0 ? " " : BUTTON_SUMMARY_SEPARATOR}${segment.text}`;
      return segment.kind === hoveredKind
        ? theme.bg(THEME_BACKGROUND.selected, theme.fg(THEME_COLOR.dim, text))
        : theme.fg(THEME_COLOR.dim, text);
    })
    .join("");
  return [padToWidth(truncateToWidth(`${labelRow}${chips}`, width, ""), width)];
}

/** Renders the bordered, tabbed picker directly above the wrapped editor. */
export function renderResourcePicker(options: RenderResourcePickerOptions): string[] {
  const { resources, activeKind, theme } = options;
  const panelWidth = Math.max(0, options.width);
  if (panelWidth < PANEL_MINIMUM_WIDTH) return [];

  const innerWidth = panelWidth - PANEL_BORDER_WIDTH;
  const segments = options.segments ?? resourceTabSegments(resources);
  const matches = matchedItems(resources, activeKind, options.query);
  const selectedIndex = Math.max(
    0,
    Math.min(options.selectedIndex, Math.max(0, matches.length - 1)),
  );
  const windowStart = resourceWindowStart(matches.length, selectedIndex);
  const items = matches.slice(windowStart, windowStart + RESOURCE_PICKER_VISIBLE_LIMIT);
  const counter = scrollCounter(selectedIndex, matches.length);
  const hintRow = options.hintRow
    ?? hintRowLayout({ mouseEnabled: options.mouseEnabled === true, counter, innerWidth });
  const hover = options.hoverTarget;
  const lines = [
    renderTopBorder(panelWidth, activeKind),
    framedLine(
      renderTabs({
        segments,
        activeKind,
        innerWidth,
        theme,
        hoveredKind: hover?.kind === "tab" ? hover.segment.kind : undefined,
      }),
      innerWidth,
      activeKind,
    ),
    renderDivider(panelWidth, activeKind),
  ];

  if (items.length === 0) {
    lines.push(
      framedLine(
        theme.fg(THEME_COLOR.muted, `  ${i18n.t("pickerNoMatches")}`),
        innerWidth,
        activeKind,
      ),
    );
  } else {
    for (const [row, item] of items.entries()) {
      const index = windowStart + row;
      lines.push(
        framedLine(
          renderItem({
            kind: activeKind,
            label: item.label,
            labelWidth: item.labelWidth,
            linkUri: item.linkUri,
            description: item.description,
            selected: index === selectedIndex,
            hovered: hover?.kind === "item" && hover.index === index,
            innerWidth,
            theme,
          }),
          innerWidth,
          activeKind,
        ),
      );
    }
  }

  lines.push(renderDivider(panelWidth, activeKind));
  lines.push(renderHintRow({
    layout: hintRow,
    innerWidth,
    theme,
    accentKind: activeKind,
    closeHovered: hover?.kind === "close",
  }));
  lines.push(renderBottomBorder(panelWidth, activeKind));
  return lines;
}

/** Renders one hint row with its optional right-aligned counter and clickable close label. */
function renderHintRow(options: {
  layout: HintRowLayout;
  innerWidth: number;
  theme: ResourcePickerTheme;
  accentKind: ResourceKind;
  closeHovered: boolean;
}): string {
  const { layout, innerWidth, theme, accentKind, closeHovered } = options;
  const { hint, counter, close } = layout;
  const label = close?.label ?? "";
  const separator = close ? HINT_ITEM_SEPARATOR : "";
  const counterTail = counter ? ` ${counter}` : "";
  const closeWidth = visibleWidth(separator + label);
  // The close label keeps its laid-out column, so the hint shrinks instead of shifting it.
  const hintWidth = Math.max(0, innerWidth - visibleWidth(counterTail) - closeWidth);
  const fittedHint = truncateToWidth(` ${hint}`, hintWidth, "");
  const gap = " ".repeat(Math.max(
    0,
    innerWidth - visibleWidth(fittedHint) - closeWidth - visibleWidth(counterTail),
  ));
  const styledClose = close
    ? (closeHovered
      ? theme.bg(THEME_BACKGROUND.selected, theme.fg(THEME_COLOR.muted, label))
      : theme.fg(THEME_COLOR.muted, label))
    : "";
  const row = `${theme.fg(THEME_COLOR.muted, fittedHint)}${
    theme.fg(THEME_COLOR.muted, separator)}${styledClose}${gap}${
    counter ? theme.fg(THEME_COLOR.dim, counterTail) : ""}`;
  return framedLine(row, innerWidth, accentKind);
}

/** Decodes Kitty printable keys while excluding escape and control input. */
function decodePickerPrintable(data: string): string | undefined {
  const kittyPrintable = decodeKittyPrintable(data);
  if (kittyPrintable !== undefined) return kittyPrintable;
  if (
    data.length === 0
    || data.startsWith("\x1b")
    || data.charCodeAt(0) < CONTROL_CHARACTER_LIMIT
  ) return undefined;
  return data;
}

/** Removes the final user-perceived character from the active query. */
function removeLastGrapheme(text: string): string {
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  const last = segments.at(-1);
  return last ? text.slice(0, last.index) : "";
}

/** Counts user-perceived characters for cursor-safe query replacement. */
function graphemeCount(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

/** Wraps Pi's current editor with an above-editor # resource picker. */
export class SessionResourceEditor implements EditorComponent {
  private pickerOpen = false;
  private query = "";
  private activeKind: ResourceKind = "file";
  private selectedIndex = 0;
  /** Header cell under the pointer, used for the hover highlight. */
  private hover: { column: number; row: number } | undefined;
  /** True while the picker's own `#` prefix sits in the prompt and must be replaced on insert. */
  private insertedPrefix = false;

  /** Captures the wrapped editor and live resource-picker dependencies. */
  constructor(
    private readonly base: EditorComponent,
    private readonly options: SessionResourceEditorOptions,
  ) {}

  /** Proxies submit handling to Pi's wrapped editor. */
  get onSubmit(): ((text: string) => void) | undefined {
    return this.base.onSubmit;
  }

  /** Wires Pi's submit handler into the wrapped editor. */
  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.base.onSubmit = handler;
  }

  /** Proxies text-change handling to Pi's wrapped editor. */
  get onChange(): ((text: string) => void) | undefined {
    return this.base.onChange;
  }

  /** Wires Pi's text-change handler into the wrapped editor. */
  set onChange(handler: ((text: string) => void) | undefined) {
    this.base.onChange = handler;
  }

  /** Exposes CustomEditor action handlers so Pi can preserve app shortcuts. */
  get actionHandlers(): Map<unknown, () => void> | undefined {
    return (this.base as EditorComponent & AppAwareEditor).actionHandlers;
  }

  /** Proxies the application Escape handler when the base supports it. */
  get onEscape(): (() => void) | undefined {
    return (this.base as EditorComponent & AppAwareEditor).onEscape;
  }

  /** Wires the application Escape handler into the wrapped editor. */
  set onEscape(handler: (() => void) | undefined) {
    (this.base as EditorComponent & AppAwareEditor).onEscape = handler;
  }

  /** Proxies the application Ctrl+D handler when the base supports it. */
  get onCtrlD(): (() => void) | undefined {
    return (this.base as EditorComponent & AppAwareEditor).onCtrlD;
  }

  /** Wires the application Ctrl+D handler into the wrapped editor. */
  set onCtrlD(handler: (() => void) | undefined) {
    (this.base as EditorComponent & AppAwareEditor).onCtrlD = handler;
  }

  /** Proxies Pi's image-paste handler when the base supports it. */
  get onPasteImage(): (() => void) | undefined {
    return (this.base as EditorComponent & AppAwareEditor).onPasteImage;
  }

  /** Wires Pi's image-paste handler into the wrapped editor. */
  set onPasteImage(handler: (() => void) | undefined) {
    (this.base as EditorComponent & AppAwareEditor).onPasteImage = handler;
  }

  /** Proxies extension shortcut routing to the wrapped editor. */
  get onExtensionShortcut(): ((data: string) => boolean) | undefined {
    return (this.base as EditorComponent & AppAwareEditor).onExtensionShortcut;
  }

  /** Wires extension shortcut routing into the wrapped editor. */
  set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) {
    (this.base as EditorComponent & AppAwareEditor).onExtensionShortcut = handler;
  }

  /** Reflects focus from the wrapper onto its cursor-rendering base editor. */
  get focused(): boolean {
    return Boolean((this.base as EditorComponent & AppAwareEditor).focused);
  }

  /** Propagates TUI focus to the wrapped editor for hardware-cursor support. */
  set focused(focused: boolean) {
    (this.base as EditorComponent & AppAwareEditor).focused = focused;
  }

  /** Preserves the wrapped editor's Kitty key-release preference. */
  get wantsKeyRelease(): boolean {
    return Boolean((this.base as EditorComponent & AppAwareEditor).wantsKeyRelease);
  }

  /** Exposes Pi's mutable editor-border color callback. */
  get borderColor(): ((text: string) => string) | undefined {
    return this.base.borderColor;
  }

  /** Applies Pi's current border color to the wrapped editor. */
  set borderColor(color: ((text: string) => string) | undefined) {
    this.base.borderColor = color;
  }

  /** Exposes picker state for deterministic component tests. */
  isPickerOpen(): boolean {
    return this.pickerOpen;
  }

  /** Exposes the active resource type for deterministic component tests. */
  getActiveKind(): ResourceKind {
    return this.activeKind;
  }

  /** Returns the wrapped editor's current prompt text. */
  getText(): string {
    return this.base.getText();
  }

  /** Returns prompt text with paste markers expanded when supported. */
  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  /** Replaces prompt text and closes any stale picker state. */
  setText(text: string): void {
    this.closePicker();
    this.base.setText(text);
  }

  /** Delegates prompt-history updates to the wrapped editor. */
  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  /** Delegates programmatic insertion at the current cursor. */
  insertTextAtCursor(text: string): void {
    this.base.insertTextAtCursor?.(text);
  }

  /** Preserves slash, path, and other autocomplete providers on the base editor. */
  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  /** Preserves Pi's configured horizontal editor padding. */
  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  /** Preserves the base editor's native autocomplete height setting. */
  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }

  /** Renders the resource header above the wrapped editor when one applies. */
  render(width: number): string[] {
    const layout = this.computeHeaderLayout(width);
    const editorLines = this.base.render(width);
    return layout ? [...this.renderHeaderLines(layout, width), ...editorLines] : editorLines;
  }

  /** Renders the button or panel rows for one already-computed header layout. */
  private renderHeaderLines(layout: HeaderLayout, width: number): string[] {
    const hoverTarget = this.hover
      ? hitHeaderTarget(layout, this.hover.column, this.hover.row)
      : undefined;
    if (layout.kind === "button") {
      return renderResourceButton({
        resources: this.options.getResources(),
        width,
        theme: this.options.theme,
        segments: layout.segments,
        labelHovered: hoverTarget?.kind === "button",
        hoveredKind: hoverTarget?.kind === "buttonCount" ? hoverTarget.segment.kind : undefined,
      });
    }
    return renderResourcePicker({
      resources: this.options.getResources(),
      activeKind: this.activeKind,
      query: this.query,
      selectedIndex: this.selectedIndex,
      width,
      theme: this.options.theme,
      segments: layout.segments,
      hintRow: layout.hintRow,
      windowStart: layout.windowStart,
      hoverTarget,
      mouseEnabled: this.options.isMouseEnabled(),
    });
  }

  /** Routes mouse input to the header rows, or forwards it to the wrapped editor. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Mouse coordinates are relative to this component, so they include the header
    // rows; the base editor only understands coordinates below them.
    const layout = this.computeHeaderLayout(event.width);
    if (layout && event.y >= 0 && event.y < layout.height) {
      return this.handleHeaderMouse(event, layout);
    }
    const offset = layout?.height ?? 0;
    return this.base.handleMouse?.({
      ...event,
      y: Math.max(0, event.y - offset),
      height: Math.max(0, event.height - offset),
    });
  }

  /** Routes picker navigation while delegating ordinary editing to the base. */
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.pickerOpen && (!this.options.isEnabled() || this.options.getResources().length === 0)) {
      this.closePicker();
    }

    if (!this.pickerOpen) {
      this.handleEditorInput(data);
      return;
    }

    if (this.options.keybindings.matches(data, "tui.select.cancel")) {
      this.closePicker();
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
      this.switchKind(-1);
      return;
    }
    if (matchesKey(data, Key.right) || this.options.keybindings.matches(data, "tui.input.tab")) {
      this.switchKind(1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      this.confirmSelection();
      return;
    }
    if (this.options.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      if (!this.insertedPrefix) {
        this.closePicker();
        this.base.handleInput(data);
        this.options.requestRender();
        return;
      }
      this.base.handleInput(data);
      if (this.query.length === 0) this.closePicker();
      else this.query = removeLastGrapheme(this.query);
      this.selectedIndex = 0;
      this.options.requestRender();
      return;
    }

    const printable = decodePickerPrintable(data);
    if (printable !== undefined) {
      // A picker opened from the button owns no prompt prefix, so typing returns to the editor.
      if (!this.insertedPrefix) {
        this.closePicker();
        this.base.handleInput(data);
        this.options.requestRender();
        return;
      }
      this.base.handleInput(data);
      if (/\s|#/.test(printable)) this.closePicker();
      else this.query += printable;
      this.selectedIndex = 0;
      this.options.requestRender();
      return;
    }

    this.closePicker();
    this.base.handleInput(data);
    this.options.requestRender();
  }

  /** Invalidates the wrapped editor after theme or layout changes. */
  invalidate(): void {
    this.base.invalidate();
  }

  /** Releases resources owned by a wrapped custom editor. */
  dispose(): void {
    (this.base as EditorComponent & AppAwareEditor).dispose?.();
  }

  /** Opens the picker for a boundary # or delegates the key unchanged. */
  private handleEditorInput(data: string): void {
    const printable = decodePickerPrintable(data);
    if (
      printable !== "#"
      || !this.options.isEnabled()
      || this.options.getResources().length === 0
      || !this.isAtTokenBoundary()
    ) {
      this.base.handleInput(data);
      return;
    }

    if (this.base.insertTextAtCursor) this.base.insertTextAtCursor("#");
    else this.base.handleInput(data);
    const resources = this.options.getResources();
    this.activeKind = RESOURCE_TABS.find((kind) => resources.some((resource) => resource.kind === kind)) ?? "file";
    this.query = "";
    this.selectedIndex = 0;
    this.insertedPrefix = true;
    this.pickerOpen = true;
    this.options.requestRender();
  }

  /** Chooses between the open picker panel, the collapsed button, and no header at all. */
  private computeHeaderLayout(width: number): HeaderLayout | undefined {
    if (!this.options.isEnabled()) return undefined;
    const resources = this.options.getResources();

    if (this.pickerOpen) {
      if (width < PANEL_MINIMUM_WIDTH) return undefined;
      const matches = matchedItems(resources, this.activeKind, this.query);
      const windowStart = resourceWindowStart(matches.length, this.selectedIndex);
      const itemCount = Math.min(matches.length, RESOURCE_PICKER_VISIBLE_LIMIT);
      const itemRows = Math.max(1, itemCount);
      return {
        kind: "panel",
        height: PANEL_HEADER_ROWS + itemRows + PANEL_FOOTER_ROWS,
        width,
        segments: resourceTabSegments(resources),
        hintRow: hintRowLayout({
          mouseEnabled: this.options.isMouseEnabled(),
          counter: scrollCounter(this.selectedIndex, matches.length),
          innerWidth: width - PANEL_BORDER_WIDTH,
        }),
        itemCount,
        windowStart,
      };
    }

    if (!this.options.isMouseEnabled() || resources.length === 0 || width <= 0) return undefined;
    return { kind: "button", height: 1, segments: resourceButtonSegments(resources) };
  }

  /** Handles hover, press, and click inside the header rows. */
  private handleHeaderMouse(
    event: TuiMouseEvent,
    layout: HeaderLayout,
  ): TuiMouseEventResult | undefined {
    if (event.type === "wheel") return undefined;
    const target = hitHeaderTarget(layout, event.x, event.y);

    if (event.type === "move") {
      const next = target.kind === "empty" ? undefined : { column: event.x, row: event.y };
      const changed = this.hover?.column !== next?.column || this.hover?.row !== next?.row;
      this.hover = next;
      return changed ? { handled: true, render: true } : undefined;
    }
    // Resource rows keep Pi's own OSC 8 activation and text selection, so pointer
    // gestures on them stay unhandled and only the controls above the list are routed here.
    if (target.kind === "empty" || target.kind === "item" || event.button !== "left") {
      return undefined;
    }

    if (event.type === "press" || event.type === "drag") return { handled: true, focus: true };
    if (event.type !== "click") return undefined;

    if (target.kind === "button") this.openPicker();
    else if (target.kind === "buttonCount") this.openPicker(target.segment.kind);
    else if (target.kind === "close") this.closePicker();
    else this.switchKindTo(target.segment.kind);
    return { handled: true, focus: true, render: true };
  }

  /** Checks the actual cursor when available and otherwise assumes text-end input. */
  private isAtTokenBoundary(): boolean {
    const cursorAware = this.base as EditorComponent & CursorAwareEditor;
    const lines = cursorAware.getLines?.();
    const cursor = cursorAware.getCursor?.();
    if (lines && cursor) {
      const line = lines[cursor.line] ?? "";
      const beforeCursor = line.slice(0, cursor.col);
      return beforeCursor.length === 0 || /[\t ]$/.test(beforeCursor);
    }

    const text = this.base.getText();
    return text.length === 0 || /[\t ]$/.test(text);
  }

  /** Returns every match for the active resource type and query. */
  private currentItems() {
    return matchedItems(this.options.getResources(), this.activeKind, this.query);
  }

  /** Opens the picker without inserting a `#` prefix, optionally on one requested type. */
  private openPicker(requestedKind?: ResourceKind): void {
    const resources = this.options.getResources();
    if (!this.options.isEnabled() || resources.length === 0) return;
    const available = RESOURCE_TABS.filter((kind) =>
      resources.some((resource) => resource.kind === kind));
    // A clicked chip wins even when that type is empty, matching the tab keys' behavior.
    this.activeKind = requestedKind
      ?? (available.includes(this.activeKind) ? this.activeKind : available[0] ?? "file");
    this.query = "";
    this.selectedIndex = 0;
    this.insertedPrefix = false;
    // The pointer now sits over the opened panel; keep it from highlighting a stale row.
    this.hover = undefined;
    this.pickerOpen = true;
    this.options.requestRender();
  }

  /** Switches to one resource type and resets row selection. */
  private switchKindTo(kind: ResourceKind): void {
    if (!RESOURCE_TABS.includes(kind) || kind === this.activeKind) return;
    this.activeKind = kind;
    this.selectedIndex = 0;
    this.options.requestRender();
  }

  /** Cycles resource types and resets row selection. */
  private switchKind(delta: -1 | 1): void {
    const currentIndex = RESOURCE_TABS.indexOf(this.activeKind);
    this.activeKind = RESOURCE_TABS[
      (currentIndex + delta + RESOURCE_TABS.length) % RESOURCE_TABS.length
    ] ?? "file";
    this.selectedIndex = 0;
    this.options.requestRender();
  }

  /** Moves row selection with wraparound inside the active type. */
  private moveSelection(delta: -1 | 1): void {
    const items = this.currentItems();
    if (items.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + items.length) % items.length;
    this.options.requestRender();
  }

  /** Replaces the typed # query with the selected safe resource reference. */
  private confirmSelection(): void {
    const items = this.currentItems();
    if (items.length === 0) return;
    const item = items[Math.min(this.selectedIndex, items.length - 1)];
    if (!item) return;

    const suffix = this.needsTrailingSpace() ? " " : "";
    const pending = this.insertedPrefix ? `#${this.query}` : "";
    for (let index = 0; index < graphemeCount(pending); index += 1) {
      this.base.handleInput(BACKSPACE_INPUT);
    }
    if (this.base.insertTextAtCursor) this.base.insertTextAtCursor(`${item.value}${suffix}`);
    else {
      for (const character of `${item.value}${suffix}`) this.base.handleInput(character);
    }
    this.closePicker();
    this.options.requestRender();
  }

  /** Avoids adding a separator before existing whitespace or punctuation. */
  private needsTrailingSpace(): boolean {
    const cursorAware = this.base as EditorComponent & CursorAwareEditor;
    const lines = cursorAware.getLines?.();
    const cursor = cursorAware.getCursor?.();
    if (!lines || !cursor) return true;
    const afterCursor = (lines[cursor.line] ?? "").slice(cursor.col);
    return afterCursor.length === 0 || !/^[\s,.;:!?)]/.test(afterCursor);
  }

  /** Clears transient picker state without changing prompt text. */
  private closePicker(): void {
    this.pickerOpen = false;
    this.query = "";
    this.selectedIndex = 0;
    this.insertedPrefix = false;
    this.hover = undefined;
  }
}
