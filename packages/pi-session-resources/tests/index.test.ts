import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import sessionResourcesExtension from "../src/index.ts";
import { loadConfig } from "../src/config.ts";

type EventHandler = (...args: unknown[]) => unknown;
type SessionResourcesCommand = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};
type EditorFactory = Exclude<
  Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0],
  undefined
>;

/** 面板组件只需要按键入口；其余 Component 成员在测试里用不到。 */
type KeyboardComponent = {
  handleInput(data: string): void;
};

/** Enter 键的原始序列；开关行用它原地切换。 */
const ENTER = "\r";

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
  // 面板渲染需要已初始化的主题（getSettingsListTheme 读取全局主题）。
  initTheme("dark");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-session-resources-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const { pi, events, commands, shortcuts } = createPiMock();
  let editorFactory: EditorFactory | undefined;
  let previousEditorRead = false;
  const notifications: { message: string; level?: string }[] = [];
  let panelOpened = false;
  let panelComponent: KeyboardComponent | undefined;
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
      /** Executes the panel factory so tests can drive the real SettingsList. */
      async custom<T>(factory: unknown): Promise<T> {
        panelOpened = true;
        const create = factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: undefined) => void,
        ) => KeyboardComponent;
        panelComponent = create(
          { requestRender: () => undefined },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          undefined,
          () => undefined,
        );
        return undefined as T;
      },
      /** Records command feedback, including the Pi notify level. */
      notify(message: string, type?: "info" | "warning" | "error"): void {
        notifications.push({ message, level: type });
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
  await command.handler("", context as unknown as ExtensionCommandContext);
  assert.equal(panelOpened, true, "bare command must open the configuration panel");

  // 面板唯一的开关行用 Enter 原地切换：开 → 关，立即写盘并同步运行期状态。
  assert.ok(panelComponent);
  panelComponent.handleInput(ENTER);
  assert.match(notifications.at(-1)?.message ?? "", /^\[resources\] .*disabled/);
  assert.equal(loadConfig().enabled, false);

  await command.handler("disable", context as unknown as ExtensionCommandContext);
  assert.match(notifications.at(-1)?.message ?? "", /^\[resources\] .*disabled/);
  assert.equal(notifications.at(-1)?.level, "info");
  assert.equal(loadConfig().enabled, false);
  await command.handler("enable", context as unknown as ExtensionCommandContext);
  assert.match(notifications.at(-1)?.message ?? "", /^\[resources\] .*enabled/);
  assert.equal(notifications.at(-1)?.level, "info");
  assert.equal(loadConfig().enabled, true);

  const shutdown = events.get("session_shutdown");
  assert.ok(shutdown);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
