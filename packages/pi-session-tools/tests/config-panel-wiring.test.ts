/**
 * 面板连线测试：真正打开入口注册的配置面板，用键盘事件走完整交互。
 *
 * 面板字段逻辑在 config-panel.test.ts 覆盖；这里只盯住两件事：
 * 1. 不带参数的配置命令会打开面板；
 * 2. 面板里把强制压缩改成「关闭强制」时，运行期真的退出了强制模式（不只是写文件）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { forceOptions } from "../src/config-panel.ts";

type RegisteredCommand = {
  handler: (args: string, context: unknown) => Promise<void>;
};
type EventHandler = (event: unknown, context: unknown) => unknown | Promise<unknown>;

/** 面板组件只需要按键入口；其余 Component 成员在测试里用不到。 */
type KeyboardComponent = {
  handleInput(data: string): void;
};

/** Enter 键的原始序列；SettingsList 用它激活当前行并确认二级列表。 */
const ENTER = "\r";

/** 上方向键的原始序列；二级列表预先选中当前比例，用它移到「关闭强制」。 */
const ARROW_UP = "\u001b[A";

/** 收集面板组件的最小自定义 UI：把 ui.custom 的工厂真的执行一遍。 */
function createCapturingUi(): {
  custom: (factory: unknown) => Promise<undefined>;
  component: () => KeyboardComponent | undefined;
  opened: () => boolean;
} {
  let opened = false;
  let component: KeyboardComponent | undefined;
  return {
    /** 执行面板工厂并保存返回的组件，模拟 Pi 打开面板。 */
    async custom(factory: unknown): Promise<undefined> {
      opened = true;
      const create = factory as (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: undefined) => void,
      ) => KeyboardComponent;
      const theme = {
        /** 面板只用到前景色，测试里原样返回文本。 */
        fg: (_color: string, text: string) => text,
        /** 面板只用到加粗，测试里原样返回文本。 */
        bold: (text: string) => text,
      };
      component = create({ requestRender: () => undefined }, theme, undefined, () => undefined);
      return undefined;
    },
    /** 最近一次打开的面板组件。 */
    component: () => component,
    /** 面板是否被打开过。 */
    opened: () => opened,
  };
}

test("不带参数的配置命令打开面板，面板关闭强制会退出强制模式并写盘", async (t) => {
  initTheme("dark");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-session-tools-panel-"));
  const configDir = join(agentDir, "extensions", "pi-session-tools");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ forceSquashContextThreshold: 0.5 }),
    "utf8",
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const moduleUrl = new URL("../src/session-tail-compaction.ts", import.meta.url);
  moduleUrl.searchParams.set("panel-wiring-test", "enabled");
  const { default: sessionTailCompaction } = await import(moduleUrl.href);

  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, EventHandler>();
  let activeTools = ["read", "bash", "session_log", "session_squash"];
  const pi = {
    registerTool: () => undefined,
    /** 保存配置命令，测试用不带参数的调用打开面板。 */
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    /** 保存生命周期处理器，测试用它触发一次强制模式。 */
    on: (eventName: string, handler: EventHandler) => handlers.set(eventName, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames: string[]) => {
      activeTools = [...toolNames];
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  sessionTailCompaction(pi);

  const ui = createCapturingUi();
  const context = {
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "session-panel",
      getLeafId: () => "leaf-1",
      buildContextEntries: () => [],
      branch: () => undefined,
    },
    model: { contextWindow: 2000 },
    hasUI: true,
    getContextUsage: () => ({ tokens: 1234, contextWindow: 4000, percent: 30.85 }),
    abort: () => undefined,
    ui: {
      custom: ui.custom,
      notify: () => undefined,
    },
  };

  // 进入强制模式：0.5 比例下 1234 / 4000 已越线。
  const turnEnd = handlers.get("turn_end");
  assert.ok(turnEnd);
  await turnEnd({}, context);
  assert.deepEqual(activeTools, ["session_log", "session_squash"]);

  const configCommand = commands.get("config:session-tools");
  assert.ok(configCommand);
  await configCommand.handler("", context);
  assert.equal(ui.opened(), true, "不带参数的配置命令必须打开面板");

  const panel = ui.component();
  assert.ok(panel);
  // 第一行是强制比例，Enter 打开二级列表；列表预先选中当前的 50%，
  // 按 Up 逐项回到第一项「关闭强制」，再用 Enter 确认。
  panel.handleInput(ENTER);
  const upsToForceOff = forceOptions(0.5).length - 1;
  for (let step = 0; step < upsToForceOff; step += 1) panel.handleInput(ARROW_UP);
  panel.handleInput(ENTER);

  assert.deepEqual(activeTools, ["read", "bash", "session_log", "session_squash"]);
  const persisted = JSON.parse(
    readFileSync(join(configDir, "config.json"), "utf8"),
  ) as { forceSquashContextThreshold?: number | null };
  assert.equal(persisted.forceSquashContextThreshold, null);
});
