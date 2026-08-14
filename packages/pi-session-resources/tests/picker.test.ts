import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionResource } from "../src/collector.ts";
import {
  renderResourcePicker,
  SessionResourceEditor,
} from "../src/picker.ts";

const theme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
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

test("picker renders a bordered tab bar above typed-first resource rows", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const lines = renderResourcePicker({
    resources: resourceSet(),
    activeKind: "file",
    query: "",
    selectedIndex: 0,
    width: 72,
    theme,
  });

  assert.match(lines[0] ?? "", /^┌ Session resources /);
  assert.match(lines[1] ?? "", /FILE 1.*PR\/MR 1.*WEB 1/);
  assert.ok(lines.some((line) => line.includes("FILE ▤ src/index.ts")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 72));
});

test("# opens above the editor, Tab switches type, and Enter inserts the resource", () => {
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

  editor.handleInput("\t");
  assert.equal(editor.getActiveKind(), "review");
  editor.handleInput("\r");

  assert.equal(editor.isPickerOpen(), false);
  assert.equal(editor.getText(), "#https://github.com/owner/repo/pull/93 ");
  assert.ok(renders >= 3);
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
