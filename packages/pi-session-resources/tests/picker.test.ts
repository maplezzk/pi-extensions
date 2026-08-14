import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionResource } from "../src/collector.ts";
import {
  renderResourcePicker,
  type ResourcePickerTheme,
  SessionResourceEditor,
} from "../src/picker.ts";

const SELECTED_BACKGROUND_START = "\x1b[7m";
const SELECTED_BACKGROUND_END = "\x1b[27m";
const ACCENT_START = "\x1b[38;2;77;163;255m";
const TEXT_START = "\x1b[37m";
const DIM_START = "\x1b[90m";
const FOREGROUND_END = "\x1b[39m";
const ANSI_RESET = "\x1b[0m";
const BOLD_START = "\x1b[1m";
const BOLD_END = "\x1b[22m";

const theme: ResourcePickerTheme = {
  /** Applies deterministic test foreground colors for picker hierarchy assertions. */
  fg: (color, text) => {
    const start = {
      dim: DIM_START,
      muted: DIM_START,
      text: TEXT_START,
    }[color] ?? "";
    return start ? `${start}${text}${FOREGROUND_END}` : text;
  },
  /** Applies the selected background used by the active resource tab. */
  bg: (_color, text) => `${SELECTED_BACKGROUND_START}${text}${SELECTED_BACKGROUND_END}`,
  /** Applies deterministic bold styling to the selected resource label. */
  bold: (text) => `${BOLD_START}${text}${BOLD_END}`,
};

const keybindings = {
  /** Matches only the default keys used by picker tests. */
  matches(data: string, action: string): boolean {
    const bindings: Record<string, string[]> = {
      "tui.select.cancel": ["\x1b", "\x03"],
      "tui.input.tab": ["\t"],
      "tui.select.up": ["\x1b[A"],
      "tui.select.down": ["\x1b[B"],
      "tui.select.confirm": ["\r"],
      "tui.editor.deleteCharBackward": ["\x7f"],
    };
    return bindings[action]?.includes(data) ?? false;
  },
} as Pick<KeybindingsManager, "matches">;

/** Minimal cursor-aware editor used to exercise the wrapper without a TUI process. */
class FakeEditor implements EditorComponent {
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  readonly handledInputs: string[] = [];
  private text = "";
  private cursor = 0;

  /** Returns the current fake prompt. */
  getText(): string {
    return this.text;
  }

  /** Replaces fake prompt text and moves the cursor to its end. */
  setText(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }

  /** Exposes a single logical line for cursor-aware picker behavior. */
  getLines(): string[] {
    return [this.text];
  }

  /** Exposes the current fake cursor position. */
  getCursor(): { line: number; col: number } {
    return { line: 0, col: this.cursor };
  }

  /** Inserts text at the fake cursor and reports the change. */
  insertTextAtCursor(text: string): void {
    this.text = `${this.text.slice(0, this.cursor)}${text}${this.text.slice(this.cursor)}`;
    this.cursor += text.length;
    this.onChange?.(this.text);
  }

  /** Handles the printable, backspace, and Enter inputs needed by tests. */
  handleInput(data: string): void {
    this.handledInputs.push(data);
    if (data === "\x7f") {
      if (this.cursor > 0) {
        this.text = `${this.text.slice(0, this.cursor - 1)}${this.text.slice(this.cursor)}`;
        this.cursor -= 1;
        this.onChange?.(this.text);
      }
      return;
    }
    if (data === "\r") {
      this.onSubmit?.(this.text);
      return;
    }
    if (data.startsWith("\x1b") || data.charCodeAt(0) < 32) return;
    this.insertTextAtCursor(data);
  }

  /** Renders a stable marker after picker rows. */
  render(): string[] {
    return [`EDITOR ${this.text}`];
  }

  /** Has no cached state to invalidate. */
  invalidate(): void {}
}

/** Creates one stable resource fixture for picker tests. */
function resourceFixture(overrides: Partial<SessionResource>): SessionResource {
  return {
    key: "file:/workspace/project/src/index.ts",
    kind: "file",
    target: resolve("/workspace/project/src/index.ts"),
    label: "src/index.ts",
    actions: ["read"],
    tools: ["read"],
    firstSeenAt: 1,
    lastSeenAt: 1,
    seenCount: 1,
    ...overrides,
  };
}

/** Returns one resource per picker tab. */
function resourceSet(): SessionResource[] {
  return [
    resourceFixture({}),
    resourceFixture({
      key: "review:https://github.com/owner/repo/pull/93",
      kind: "review",
      target: "https://github.com/owner/repo/pull/93",
      label: "owner/repo#93",
      actions: ["created"],
    }),
    resourceFixture({
      key: "web:https://example.com/docs",
      kind: "web",
      target: "https://example.com/docs",
      label: "example.com/docs",
      actions: ["opened"],
    }),
  ];
}

test("picker renders a bordered tab bar with one blue accent", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const lines = renderResourcePicker({
    resources: resourceSet(),
    activeKind: "file",
    query: "",
    selectedIndex: 0,
    width: 72,
    theme,
  });

  assert.ok((lines[0] ?? "").includes(`${ACCENT_START}╭─ Session resources `));
  assert.ok(
    (lines[1] ?? "").includes(
      `${SELECTED_BACKGROUND_START}${ACCENT_START} FILE 1 ${ANSI_RESET}${SELECTED_BACKGROUND_END}`,
    ),
  );
  assert.ok((lines[1] ?? "").includes(`${DIM_START} PR/MR 1 ${FOREGROUND_END}`));
  assert.ok((lines[1] ?? "").includes(`${DIM_START} URL 1 ${FOREGROUND_END}`));
  assert.ok(lines.some((line) => line.includes("src/index.ts")));
  assert.ok(lines.every((line) => !line.includes("FILE ▤")));
  assert.ok(
    lines.some((line) => line.includes(`${ACCENT_START}→ ${ANSI_RESET}`)),
  );
  assert.ok(
    lines.some((line) => line.includes(`${ACCENT_START}${BOLD_START}`)),
  );
  assert.ok(lines.some((line) => line.includes(DIM_START)));
  assert.ok(lines.every((line) => visibleWidth(line) === 72));
  assert.ok((lines.at(-1) ?? "").includes(`${ACCENT_START}╰`));
});

test("picker keeps styling inside the OSC 8 link so selected URLs render once", () => {
  const lines = renderResourcePicker({
    resources: resourceSet(),
    activeKind: "web",
    query: "",
    selectedIndex: 0,
    width: 72,
    theme,
  });

  const row = lines.find((line) => line.includes("example.com/docs")) ?? "";
  const linkStart = row.indexOf("\x1b]8;;https://example.com/docs\x1b\\");
  const linkEnd = row.indexOf("\x1b]8;;\x1b\\", linkStart);
  assert.ok(linkStart >= 0);
  assert.ok(linkEnd > linkStart);
  const linkBody = row.slice(linkStart, linkEnd);
  assert.ok(linkBody.includes(BOLD_START));
  assert.ok(linkBody.includes(ACCENT_START));
  const visibleText = row.replace(/\x1b\][^\x1b]*\x1b\\/g, "");
  assert.equal(visibleText.split("example.com/docs").length - 1, 1);
  assert.ok(lines.every((line) => visibleWidth(line) === 72));
});

test("picker keeps the same blue accent across resource types", () => {
  for (const kind of ["review", "web"] as const) {
    const lines = renderResourcePicker({
      resources: resourceSet(),
      activeKind: kind,
      query: "",
      selectedIndex: 0,
      width: 72,
      theme,
    });

    assert.ok((lines[0] ?? "").startsWith(ACCENT_START));
    assert.ok((lines.at(-1) ?? "").includes(`${ACCENT_START}╰`));
    assert.ok(lines.some((line) => line.includes(`${ACCENT_START}→ ${ANSI_RESET}`)));
  }
});

test("picker follows narrow and wide terminal widths without a fixed cap", () => {
  for (const width of [48, 128]) {
    const lines = renderResourcePicker({
      resources: resourceSet(),
      activeKind: "file",
      query: "",
      selectedIndex: 0,
      width,
      theme,
    });

    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
  }
});

test("# opens above the editor, type keys switch tabs, and Enter inserts the resource", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const base = new FakeEditor();
  let renders = 0;
  const editor = new SessionResourceEditor(base, {
    theme,
    keybindings,
    getResources: resourceSet,
    isEnabled: () => true,
    requestRender: () => {
      renders += 1;
    },
  });

  editor.handleInput("#");
  assert.equal(editor.isPickerOpen(), true);
  assert.equal(editor.getActiveKind(), "file");
  assert.match(editor.render(72).at(-1) ?? "", /^EDITOR #$/);

  editor.handleInput("\x1b[C");
  assert.equal(editor.getActiveKind(), "review");
  editor.handleInput("\x1b[D");
  assert.equal(editor.getActiveKind(), "file");
  editor.handleInput("\t");
  assert.equal(editor.getActiveKind(), "review");
  assert.ok(!base.handledInputs.includes("\x1b[C"));
  assert.ok(!base.handledInputs.includes("\x1b[D"));
  editor.handleInput("\r");

  assert.equal(editor.isPickerOpen(), false);
  assert.equal(editor.getText(), "#https://github.com/owner/repo/pull/93 ");
  editor.handleInput("\x1b[D");
  assert.equal(base.handledInputs.at(-1), "\x1b[D");
  assert.ok(renders >= 5);
});

test("picker respects token boundaries and Shift+Tab switches backward", () => {
  const base = new FakeEditor();
  const editor = new SessionResourceEditor(base, {
    theme,
    keybindings,
    getResources: resourceSet,
    isEnabled: () => true,
    requestRender: () => {},
  });

  editor.setText("word");
  editor.handleInput("#");
  assert.equal(editor.isPickerOpen(), false);
  assert.equal(editor.getText(), "word#");

  editor.setText("word ");
  editor.handleInput("#");
  editor.handleInput("\x1b[Z");
  assert.equal(editor.getActiveKind(), "web");
  editor.handleInput("\x1b");
  assert.equal(editor.isPickerOpen(), false);
  assert.equal(editor.getText(), "word #");
});
