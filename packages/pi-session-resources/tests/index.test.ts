import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import sessionResourcesExtension from "../src/index.ts";

type EventHandler = (...args: unknown[]) => unknown;
type SessionResourcesCommand = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};
type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

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

/** Creates a no-op base provider for autocomplete layering assertions. */
function createBaseProvider(): AutocompleteProvider {
  return {
    /** Returns no base suggestions so only session resources are visible. */
    async getSuggestions(): Promise<null> {
      return null;
    },
    /** Leaves delegated editor state unchanged. */
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  };
}

test("registers # completion, rewrites Tab to candidate navigation, and removes the persistent widget", async () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const { pi, events, commands, shortcuts } = createPiMock();
  let autocompleteFactory: AutocompleteProviderFactory | undefined;
  let terminalInputHandler: TerminalInputHandler | undefined;
  let inputListenerRemoved = false;
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
      /** Captures the resource provider layered over Pi's built-in provider. */
      addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
        autocompleteFactory = factory;
      },
      /** Captures Tab routing and exposes listener cleanup. */
      onTerminalInput(handler: TerminalInputHandler): () => void {
        terminalInputHandler = handler;
        return () => {
          inputListenerRemoved = true;
        };
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
  assert.ok(autocompleteFactory);
  assert.ok(terminalInputHandler);

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

  const provider = autocompleteFactory(createBaseProvider());
  const text = "inspect #session";
  const suggestions = await provider.getSuggestions(
    [text],
    0,
    text.length,
    { signal: new AbortController().signal },
  );
  assert.equal(suggestions?.items.length, 1);
  assert.equal(suggestions?.items[0]?.value, '#"docs/session notes.md"');
  assert.deepEqual(terminalInputHandler("\t"), { data: "\x1b[B" });

  const command = commands.get("config:session-resources") as SessionResourcesCommand;
  await command.handler("disable", context as unknown as ExtensionCommandContext);
  const disabledSuggestions = await provider.getSuggestions(
    ["#session"],
    0,
    "#session".length,
    { signal: new AbortController().signal },
  );
  assert.equal(disabledSuggestions, null);
  assert.match(notifications.at(-1) ?? "", /disabled/);

  const shutdown = events.get("session_shutdown");
  assert.ok(shutdown);
  shutdown({}, context);
  assert.equal(inputListenerRemoved, true);
});
