import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import sessionResourcesExtension from "../src/index.ts";

type EventHandler = (...args: unknown[]) => unknown;
type SessionResourcesCommand = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};
type EditorFactory = Exclude<
  Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0],
  undefined
>;

/** Creates a minimal Pi API mock that captures registered events and commands. */
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
    /** Captures any unexpected extension shortcut registration. */
    registerShortcut(name: string, shortcut: unknown): void {
      shortcuts.set(name, shortcut);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, commands, shortcuts };
}

test("registers a composable custom editor picker without persistent widgets or shortcuts", async () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const { pi, events, commands, shortcuts } = createPiMock();
  let editorFactory: EditorFactory | undefined;
  let previousEditorRead = false;
  const notifications: string[] = [];
  const context = {
    mode: "tui",
    cwd: resolve("/workspace/project"),
    sessionManager: {
      /** Starts from an empty active branch. */
      getBranch(): [] {
        return [];
      },
    },
    ui: {
      /** Exposes the current editor factory for extension composition. */
      getEditorComponent(): undefined {
        previousEditorRead = true;
        return undefined;
      },
      /** Captures the editor wrapper installed by the extension. */
      setEditorComponent(factory: EditorFactory): void {
        editorFactory = factory;
      },
      /** Records command feedback. */
      notify(message: string): void {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;

  sessionResourcesExtension(pi);

  assert.ok(commands.has("config:session-resources"));
  assert.ok(commands.has("session-resources"));
  assert.equal(shortcuts.size, 0);
  const sessionStart = events.get("session_start");
  assert.ok(sessionStart);
  sessionStart({}, context);
  assert.equal(previousEditorRead, true);
  assert.ok(editorFactory);

  const toolResult = events.get("tool_result");
  assert.ok(toolResult);
  toolResult(
    {
      toolName: "read",
      input: { path: "docs/session notes.md" },
      content: [],
      isError: false,
    },
    context,
  );

  const command = commands.get("config:session-resources") as SessionResourcesCommand;
  await command.handler("disable", context as unknown as ExtensionCommandContext);
  assert.match(notifications.at(-1) ?? "", /disabled/);
  await command.handler("enable", context as unknown as ExtensionCommandContext);
  assert.match(notifications.at(-1) ?? "", /enabled/);

  const shutdown = events.get("session_shutdown");
  assert.ok(shutdown);
  shutdown({}, context);
});
