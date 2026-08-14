import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import sessionResourcesExtension from "../src/index.ts";

type EventHandler = (...args: unknown[]) => unknown;
type WidgetFactory = (_tui: unknown, theme: Theme) => { render(width: number): string[] };
type SessionResourcesCommand = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Creates a minimal Pi API mock that captures registered events, commands, and shortcuts. */
function createPiMock(): {
  pi: ExtensionAPI;
  events: Map<string, EventHandler>;
  commands: Map<string, unknown>;
  shortcuts: Map<string, unknown>;
} {
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, unknown>();
  const shortcuts = new Map<string, unknown>();
  const pi = {
    /** Captures one extension event handler by event name. */
    on(name: string, handler: unknown): void {
      events.set(name, handler as EventHandler);
    },
    /** Captures one slash command definition by command name. */
    registerCommand(name: string, command: unknown): void {
      commands.set(name, command);
    },
    /** Captures extension-owned shortcuts to guard against overriding Pi's Ctrl+O. */
    registerShortcut(name: string, shortcut: unknown): void {
      shortcuts.set(name, shortcut);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, commands, shortcuts };
}

test("uses above-editor placement, standard command naming, and Pi expansion state", async () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const { pi, events, commands, shortcuts } = createPiMock();
  const widgetCalls: unknown[][] = [];
  let toolsExpanded = false;
  const context = {
    mode: "tui",
    cwd: resolve("/workspace/project"),
    ui: {
      /** Captures all setWidget arguments so placement can be asserted. */
      setWidget(...args: unknown[]): void {
        widgetCalls.push(args);
      },
      /** Exposes Pi's canonical Ctrl+O expansion state to the widget. */
      getToolsExpanded(): boolean {
        return toolsExpanded;
      },
      /** Mirrors command-driven expansion through Pi's canonical state. */
      setToolsExpanded(expanded: boolean): void {
        toolsExpanded = expanded;
      },
      /** Ignores command notifications that are irrelevant to state assertions. */
      notify(): void {},
    },
  } as unknown as ExtensionContext;

  sessionResourcesExtension(pi);

  assert.ok(commands.has("config:session-resources"));
  assert.ok(commands.has("session-resources"));
  assert.equal(shortcuts.size, 0);
  const toolResult = events.get("tool_result");
  assert.ok(toolResult);
  for (let index = 0; index < 6; index += 1) {
    toolResult(
      {
        toolName: "read",
        input: { path: `docs/session note ${index}.md` },
        content: [],
        isError: false,
      },
      context,
    );
  }

  const activeWidgetCall = widgetCalls.at(-1);
  assert.equal(activeWidgetCall?.[0], "session-resources");
  assert.equal(typeof activeWidgetCall?.[1], "function");
  assert.equal(activeWidgetCall?.length, 2);

  const widget = (activeWidgetCall?.[1] as WidgetFactory)(undefined, theme);
  assert.match(widget.render(80).at(-1) ?? "", /2 more/);
  toolsExpanded = true;
  const expandedLines = widget.render(80);
  assert.equal(expandedLines.length, 7);
  assert.doesNotMatch(expandedLines.join("\n"), /more/);

  toolsExpanded = false;
  const command = commands.get("config:session-resources") as SessionResourcesCommand;
  await command.handler("expand", context as unknown as ExtensionCommandContext);
  assert.equal(toolsExpanded, true);
  await command.handler("collapse", context as unknown as ExtensionCommandContext);
  assert.equal(toolsExpanded, false);
});
