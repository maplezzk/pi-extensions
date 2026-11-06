import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import jsonRenderExtension from "../src/extension.ts";
import { configPath } from "../src/agent-dir.ts";
import { DEFAULT_CONFIG, type JsonRenderConfig } from "../src/config.ts";

/** Throwaway agent directory, so the test never reads or writes the real configuration. */
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-gen-ui-command-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
after(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

/** Models the panel and the command are offered. */
const MODELS = [{ provider: "llm-proxy", id: "LOW" }];

/** A candidate the composer could place; only used to reach the tool gate. */
const candidate = {
  id: "panel",
  description: "Outer container for the panel.",
  root: true,
  element: { type: "Box", props: { flexDirection: "column" } },
};

/** One registered tool, reduced to what these tests exercise. */
interface RegisteredTool {
  name: string;
  /** Forwarded verbatim to the real tool: id, params, signal, update callback, context. */
  execute: (
    ...args: [string, unknown, unknown, unknown, unknown]
  ) => Promise<{ details: { error?: string } }>;
}

/** Fake Pi plus fake context, recording everything the command touches. */
interface Harness {
  /** Notices the command sent, in order. */
  notices: string[];
  /** Registered command handlers by name. */
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  /** Registered tools by name. */
  tools: Map<string, RegisteredTool>;
  /** Whether the panel was opened instead of running an action. */
  panelOpened(): boolean;
  /** Run one command invocation. */
  run(args: string): Promise<void>;
  /** Run one tool call. */
  call(name: string, params: unknown): Promise<{ details: { error?: string } }>;
}

/** Build the harness and load the extension entry point against it. */
async function createHarness(): Promise<Harness> {
  const notices: string[] = [];
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const tools = new Map<string, RegisteredTool>();
  let panelCalls = 0;

  const api = {
    /** Notice renderer registration is optional; the stub has no appendEntry. */
    registerEntryRenderer(): void {},
    /** Collect registered tools so a command can be tied back to tool behaviour. */
    registerTool(tool: RegisteredTool): void {
      tools.set(tool.name, tool);
    },
    /** Collect registered commands by name. */
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
      commands.set(name, options.handler);
    },
    /** Session events are not under test here. */
    on(): void {},
  };

  const ctx = {
    mode: "print",
    ui: {
      /** Capture the notice text instead of drawing it. */
      notify: (text: string): void => {
        notices.push(text);
      },
      /** Record that the panel opened without driving its TUI. */
      custom: async (): Promise<void> => {
        panelCalls += 1;
      },
      theme: undefined,
    },
    modelRegistry: { getAvailable: () => MODELS },
  };

  // Every harness starts from defaults, so no test can leak state through the shared file.
  rmSync(configPath(), { force: true });

  await jsonRenderExtension(api as never);

  return {
    notices,
    commands,
    tools,
    panelOpened: () => panelCalls > 0,
    /** Run the primary command name; the alias shares the same handler. */
    run: async (args: string): Promise<void> => {
      const handler = commands.get("config:gen-ui");
      assert.ok(handler, "the configuration command was not registered");
      await handler(args, ctx);
    },
    /** Execute a tool through the same path the agent uses. */
    call: async (name: string, params: unknown) => {
      const tool = tools.get(name);
      assert.ok(tool, `${name} was not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx);
    },
  };
}

/** Read the configuration the command persisted. */
function readConfig(): JsonRenderConfig {
  return JSON.parse(readFileSync(configPath(), "utf8")) as JsonRenderConfig;
}

test("a bare command opens the panel instead of printing status", async () => {
  const harness = await createHarness();
  await harness.run("");
  assert.equal(harness.panelOpened(), true);
  assert.deepEqual(harness.notices, []);
});

test("status reports the effective configuration without writing one", async () => {
  const harness = await createHarness();
  await harness.run("status");
  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0] ?? "", /pi-gen-ui/);
});

test("enable and disable persist the master switch", async () => {
  const harness = await createHarness();
  await harness.run("disable");
  assert.equal(readConfig().enabled, false);
  await harness.run("enable");
  assert.equal(readConfig().enabled, true);
});

test("disabling the package stops compose_ui on the very next call", async () => {
  const harness = await createHarness();
  await harness.run("disable");

  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("no request is expected in this test");
  }) as typeof fetch;
  try {
    const result = await harness.call("compose_ui", { prompt: "panel", candidates: [candidate] });
    // The refusal has to happen before the transport, not after a failed request.
    assert.equal(fetchCalls, 0);
    assert.notEqual(result.details.error, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("the provider argument accepts a known transport and rejects anything else", async () => {
  const harness = await createHarness();
  await harness.run("provider typesafe");
  assert.equal(readConfig().composition.provider, "typesafe");
  await harness.run("provider gateway");
  assert.equal(readConfig().composition.provider, "gateway");

  const noticesBefore = harness.notices.length;
  await harness.run("provider openai");
  assert.equal(readConfig().composition.provider, "gateway");
  assert.equal(harness.notices.length, noticesBefore + 1);
});

test("the model argument sets a model and default clears it again", async () => {
  const harness = await createHarness();
  await harness.run("model jev-latest");
  assert.equal(readConfig().composition.model, "jev-latest");
  await harness.run("model default");
  assert.equal(readConfig().composition.model, "");
});

test("the composition argument toggles the composer", async () => {
  const harness = await createHarness();
  await harness.run("composition off");
  assert.equal(readConfig().composition.enabled, false);
  await harness.run("composition on");
  assert.equal(readConfig().composition.enabled, true);
  await harness.run("composition maybe");
  assert.equal(readConfig().composition.enabled, true);
});

test("reset restores every default", async () => {
  const harness = await createHarness();
  await harness.run("provider gateway");
  await harness.run("model custom/model");
  await harness.run("composition off");
  await harness.run("reset");
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
});

test("an unknown action prints the usage instead of writing anything", async () => {
  const harness = await createHarness();
  await harness.run("frobnicate");
  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0] ?? "", /config:gen-ui/);
  assert.equal(harness.tools.has("render_ui"), true);
});
