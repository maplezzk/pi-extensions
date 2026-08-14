import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  EditorComponent,
  EditorTheme,
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
import { resourceSuggestions } from "./autocomplete.ts";

export const RESOURCE_PICKER_VISIBLE_LIMIT = 6;
const RESOURCE_PICKER_MAX_WIDTH = 96;
const PANEL_BORDER_WIDTH = 2;
const PANEL_MINIMUM_WIDTH = 4;
const DESCRIPTION_MINIMUM_WIDTH = 48;
const DESCRIPTION_MAXIMUM_WIDTH = 22;
const DESCRIPTION_WIDTH_RATIO = 0.28;
const ITEM_COLUMN_GAP = 2;
const CONTROL_CHARACTER_LIMIT = 32;
const BACKSPACE_INPUT = "\x7f";
const RESOURCE_TABS: readonly ResourceKind[] = ["file", "review", "web"];
const TAB_LABELS: Record<ResourceKind, string> = {
  file: "FILE",
  review: "PR/MR",
  web: "WEB",
};

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
  theme: EditorTheme;
  keybindings: Pick<KeybindingsManager, "matches">;
  getResources: () => readonly SessionResource[];
  isEnabled: () => boolean;
  styleActiveTab: (text: string) => string;
  requestRender: () => void;
}

export interface RenderResourcePickerOptions {
  resources: readonly SessionResource[];
  activeKind: ResourceKind;
  query: string;
  selectedIndex: number;
  width: number;
  theme: EditorTheme;
  styleActiveTab: (text: string) => string;
}

interface RenderTabsOptions {
  resources: readonly SessionResource[];
  activeKind: ResourceKind;
  innerWidth: number;
  theme: EditorTheme;
  styleActiveTab: (text: string) => string;
}

interface RenderItemOptions {
  label: string;
  description?: string;
  selected: boolean;
  innerWidth: number;
  theme: EditorTheme;
}

/** Pads one ANSI-aware row without exceeding its assigned width. */
function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Adds themed vertical borders around one fitted panel row. */
function framedLine(content: string, innerWidth: number, theme: EditorTheme): string {
  const fitted = padToWidth(truncateToWidth(content, innerWidth, ""), innerWidth);
  return `${theme.borderColor("│")}${fitted}${theme.borderColor("│")}`;
}

/** Renders the picker title inside its themed top border. */
function renderTopBorder(width: number, theme: EditorTheme): string {
  const innerWidth = Math.max(0, width - PANEL_BORDER_WIDTH);
  const title = ` ${i18n.t("pickerTitle")} `;
  const titleWidth = Math.min(visibleWidth(title), innerWidth);
  const fittedTitle = truncateToWidth(title, titleWidth, "");
  return theme.borderColor(`┌${fittedTitle}${"─".repeat(Math.max(0, innerWidth - visibleWidth(fittedTitle)))}┐`);
}

/** Renders a horizontal divider at the current panel width. */
function renderDivider(width: number, theme: EditorTheme): string {
  return theme.borderColor(`├${"─".repeat(Math.max(0, width - PANEL_BORDER_WIDTH))}┤`);
}

/** Renders the closing border at the current panel width. */
function renderBottomBorder(width: number, theme: EditorTheme): string {
  return theme.borderColor(`└${"─".repeat(Math.max(0, width - PANEL_BORDER_WIDTH))}┘`);
}

/** Renders resource type counts and highlights the active type. */
function renderTabs(options: RenderTabsOptions): string {
  const { resources, activeKind, innerWidth, theme, styleActiveTab } = options;
  const counts = new Map<ResourceKind, number>();
  for (const resource of resources) {
    counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
  }

  const segments = RESOURCE_TABS.map((kind) => {
    const text = ` ${TAB_LABELS[kind]} ${counts.get(kind) ?? 0} `;
    return kind === activeKind
      ? styleActiveTab(text)
      : theme.selectList.description(text);
  });
  return truncateToWidth(` ${segments.join(" ")}`, innerWidth, "");
}

/** Renders one width-safe resource row with optional action metadata. */
function renderItem(options: RenderItemOptions): string {
  const { label, description, selected, innerWidth, theme } = options;
  const prefix = selected ? "→ " : "  ";
  const prefixWidth = visibleWidth(prefix);
  const showDescription = Boolean(description) && innerWidth >= DESCRIPTION_MINIMUM_WIDTH;
  const descriptionWidth = showDescription
    ? Math.min(DESCRIPTION_MAXIMUM_WIDTH, Math.floor(innerWidth * DESCRIPTION_WIDTH_RATIO))
    : 0;
  const gapWidth = showDescription ? ITEM_COLUMN_GAP : 0;
  const labelWidth = Math.max(1, innerWidth - prefixWidth - descriptionWidth - gapWidth);
  const fittedLabel = truncateToWidth(label, labelWidth, "…");
  const fittedDescription = showDescription
    ? truncateToWidth(description ?? "", descriptionWidth, "…")
    : "";
  const gap = " ".repeat(Math.max(1, labelWidth - visibleWidth(fittedLabel) + gapWidth));
  const row = showDescription
    ? `${prefix}${fittedLabel}${gap}${fittedDescription}`
    : `${prefix}${fittedLabel}`;

  if (selected) return theme.selectList.selectedText(padToWidth(row, innerWidth));
  if (!showDescription) return padToWidth(row, innerWidth);
  const primary = `${prefix}${fittedLabel}`;
  const secondary = theme.selectList.description(`${gap}${fittedDescription}`);
  return padToWidth(`${primary}${secondary}`, innerWidth);
}

/** Renders the bordered, tabbed picker directly above the wrapped editor. */
export function renderResourcePicker(options: RenderResourcePickerOptions): string[] {
  const { resources, activeKind, query, theme } = options;
  const panelWidth = Math.min(Math.max(0, options.width), RESOURCE_PICKER_MAX_WIDTH);
  if (panelWidth < PANEL_MINIMUM_WIDTH) return [];

  const innerWidth = panelWidth - PANEL_BORDER_WIDTH;
  const items = resourceSuggestions(
    resources.filter((resource) => resource.kind === activeKind),
    query,
  ).slice(0, RESOURCE_PICKER_VISIBLE_LIMIT);
  const selectedIndex = Math.max(0, Math.min(options.selectedIndex, Math.max(0, items.length - 1)));
  const lines = [
    renderTopBorder(panelWidth, theme),
    framedLine(
      renderTabs({
        resources,
        activeKind,
        innerWidth,
        theme,
        styleActiveTab: options.styleActiveTab,
      }),
      innerWidth,
      theme,
    ),
    renderDivider(panelWidth, theme),
  ];

  if (items.length === 0) {
    lines.push(framedLine(theme.selectList.noMatch(`  ${i18n.t("pickerNoMatches")}`), innerWidth, theme));
  } else {
    for (const [index, item] of items.entries()) {
      lines.push(
        framedLine(
          renderItem({
            label: item.label,
            description: item.description,
            selected: index === selectedIndex,
            innerWidth,
            theme,
          }),
          innerWidth,
          theme,
        ),
      );
    }
  }

  lines.push(renderDivider(panelWidth, theme));
  lines.push(
    framedLine(
      theme.selectList.scrollInfo(` ${i18n.t("pickerHint")}`),
      innerWidth,
      theme,
    ),
  );
  lines.push(renderBottomBorder(panelWidth, theme));
  return lines;
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

  /** Prepends the transient resource picker above the base editor. */
  render(width: number): string[] {
    const editorLines = this.base.render(width);
    if (!this.pickerOpen || !this.options.isEnabled()) return editorLines;
    return [
      ...renderResourcePicker({
        resources: this.options.getResources(),
        activeKind: this.activeKind,
        query: this.query,
        selectedIndex: this.selectedIndex,
        width,
        theme: this.options.theme,
        styleActiveTab: this.options.styleActiveTab,
      }),
      ...editorLines,
    ];
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
      this.base.handleInput(data);
      if (this.query.length === 0) this.closePicker();
      else this.query = removeLastGrapheme(this.query);
      this.selectedIndex = 0;
      this.options.requestRender();
      return;
    }

    const printable = decodePickerPrintable(data);
    if (printable !== undefined) {
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
    this.pickerOpen = true;
    this.options.requestRender();
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

  /** Returns visible matches for the active resource type and query. */
  private currentItems() {
    return resourceSuggestions(
      this.options.getResources().filter((resource) => resource.kind === this.activeKind),
      this.query,
    ).slice(0, RESOURCE_PICKER_VISIBLE_LIMIT);
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
    for (let index = 0; index < graphemeCount(`#${this.query}`); index += 1) {
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
  }
}
