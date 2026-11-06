import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  buildSkillIndex,
  resolveSkillAlias,
  transformSkillInput,
} from "../src/index.ts";
import { scanSkillRoots } from "../src/skills.ts";

// 配置面板构造 SettingsList 时要取主题色，测试进程里必须先初始化一次。
initTheme();

function createIndex() {
  const root = mkdtempSync(join(tmpdir(), "pi-nested-skills-index-"));
  mkdirSync(join(root, "development", "code-reviewer"), { recursive: true });
  writeFileSync(
    join(root, "development", "code-reviewer", "SKILL.md"),
    "---\nname: code-reviewer\ndescription: Review code\n---\nbody\n",
  );
  mkdirSync(join(root, "development", "database", "sql"), { recursive: true });
  writeFileSync(
    join(root, "development", "database", "sql", "SKILL.md"),
    "---\nname: sql-generator\ndescription: Generate SQL\n---\nbody\n",
  );
  return { root, index: buildSkillIndex(scanSkillRoots([root])) };
}

test("resolves package aliases and converts them to Pi native skill commands", () => {
  const { root, index } = createIndex();
  try {
    assert.equal(resolveSkillAlias("development:code-reviewer", index)?.skillName, "code-reviewer");
    assert.equal(resolveSkillAlias("skill:development.database.sql", index)?.skillName, "sql-generator");
    assert.equal(transformSkillInput("/development:code-reviewer check this", index), "/skill:code-reviewer check this");
    assert.equal(transformSkillInput("/skill:development.database.sql", index), "/skill:sql-generator");
    assert.equal(transformSkillInput("/unknown", index), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not guess an ambiguous frontmatter name", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-nested-skills-collision-"));
  try {
    for (const pack of ["one", "two"]) {
      mkdirSync(join(root, pack, "skill"), { recursive: true });
      writeFileSync(
        join(root, pack, "skill", "SKILL.md"),
        "---\nname: shared-name\ndescription: Shared skill\n---\nbody\n",
      );
    }
    const index = buildSkillIndex(scanSkillRoots([root]));
    assert.equal(resolveSkillAlias("skill:shared-name", index), undefined);
    assert.equal(transformSkillInput("/one:skill", index), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefixes user notices with the skills source tag without ANSI outside tui", async () => {
  const { root } = createIndex();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-nested-skills-notice-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const events = new Map<string, (...args: unknown[]) => unknown>();
    const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: unknown) {
        events.set(name, handler as (...args: unknown[]) => unknown);
      },
      registerCommand(name: string, command: unknown) {
        commands.set(name, command as { handler(args: string, ctx: unknown): Promise<void> });
      },
      sendUserMessage: async () => {},
    } as unknown as ExtensionAPI;

    mkdirSync(join(agentDir, "extensions", "pi-nested-skills"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "pi-nested-skills", "config.json"),
      JSON.stringify({ skillRoots: [root] }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const context = {
      hasUI: true,
      mode: "rpc",
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        addAutocompleteProvider() {},
      },
    } as unknown as ExtensionContext;

    const { default: extension } = await import("../src/index.ts");
    extension(pi);

    const command = commands.get("config:nested-skills");
    assert.ok(command);
    await command.handler("unsupported-argument", context);

    assert.equal(notices.length, 1);
    assert.match(notices[0], /^\[skills\] /);
    assert.doesNotMatch(notices[0], /\u001B\[/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers resources, input transformation, command and completion hooks", async () => {
  const { root } = createIndex();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-nested-skills-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const events = new Map<string, (...args: unknown[]) => unknown>();
    const commands = new Map<string, unknown>();
    let autocompleteFactory: ((current: unknown) => unknown) | undefined;
    const pi = {
      on(name: string, handler: unknown) {
        events.set(name, handler as (...args: unknown[]) => unknown);
      },
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      sendUserMessage: async () => {},
    } as unknown as ExtensionAPI;

    mkdirSync(join(agentDir, "extensions", "pi-nested-skills"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "pi-nested-skills", "config.json"),
      JSON.stringify({ skillRoots: [root] }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const context = {
      hasUI: true,
      ui: {
        notify() {},
        addAutocompleteProvider(factory: (current: unknown) => unknown) {
          autocompleteFactory = factory;
        },
      },
    } as unknown as ExtensionContext;

    const { default: extension } = await import("../src/index.ts");
    extension(pi);

    const discover = events.get("resources_discover");
    assert.ok(discover);
    const discovered = discover({}, context) as { skillPaths: string[] };
    assert.equal(discovered.skillPaths.length, 2);

    const input = events.get("input");
    assert.ok(input);
    assert.deepEqual(input({ text: "/development:code-reviewer", source: "interactive" }, context), {
      action: "transform",
      text: "/skill:code-reviewer",
      images: undefined,
    });

    const sessionStart = events.get("session_start");
    assert.ok(sessionStart);
    sessionStart({}, context);
    assert.ok(autocompleteFactory);
    assert.ok(commands.has("skills"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the config panel rebuilds the skill index without /reload", async () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "pi-nested-skills-first-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "pi-nested-skills-second-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-nested-skills-panel-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(firstRoot, "alpha"), { recursive: true });
    writeFileSync(
      join(firstRoot, "alpha", "SKILL.md"),
      "---\nname: alpha-skill\ndescription: Alpha\n---\nbody\n",
    );
    mkdirSync(join(secondRoot, "beta"), { recursive: true });
    writeFileSync(
      join(secondRoot, "beta", "SKILL.md"),
      "---\nname: beta-skill\ndescription: Beta\n---\nbody\n",
    );

    const events = new Map<string, (...args: unknown[]) => unknown>();
    const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> }>();
    const pi = {
      on(name: string, handler: unknown) {
        events.set(name, handler as (...args: unknown[]) => unknown);
      },
      registerCommand(name: string, command: unknown) {
        commands.set(name, command as { handler: (args: string, context: unknown) => Promise<void> });
      },
      sendUserMessage: async () => {},
    } as unknown as ExtensionAPI;

    mkdirSync(join(agentDir, "extensions", "pi-nested-skills"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "pi-nested-skills", "config.json"),
      JSON.stringify({ skillRoots: [firstRoot] }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const context = {
      hasUI: true,
      ui: {
        notify: () => undefined,
        addAutocompleteProvider: () => undefined,
        custom: async (
          factory: (tui: unknown, theme: unknown, keybindings: unknown, done: unknown) => { handleInput(data: string): void },
        ) => {
          // 面板只有一行（技能根目录）：回车打开预填输入框，Ctrl+K 清空整行后输入新路径，回车提交。
          const component = factory(
            { requestRender: () => undefined },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            undefined,
            () => undefined,
          );
          component.handleInput("\r");
          component.handleInput("\u000b");
          for (const char of secondRoot) component.handleInput(char);
          component.handleInput("\r");
        },
      },
    };

    const { default: extension } = await import("../src/index.ts");
    extension(pi);

    const discover = events.get("resources_discover");
    assert.ok(discover);
    const before = discover({}, context) as { skillPaths: string[] };
    assert.equal(before.skillPaths.length, 1);
    assert.match(before.skillPaths[0], /first-.*\/alpha\/SKILL\.md$/);

    const command = commands.get("config:nested-skills");
    assert.ok(command);
    await command.handler("", context);

    // 改动立即生效：同一份闭包里的索引应按新根目录重建，无需 /reload。
    const after = discover({}, context) as { skillPaths: string[] };
    assert.equal(after.skillPaths.length, 1);
    assert.match(after.skillPaths[0], /second-.*\/beta\/SKILL\.md$/);

    const saved = JSON.parse(
      readFileSync(join(agentDir, "extensions", "pi-nested-skills", "config.json"), "utf8"),
    ) as { skillRoots: string[] };
    assert.deepEqual(saved.skillRoots, [secondRoot]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});
