import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildSkillIndex,
  resolveSkillAlias,
  transformSkillInput,
} from "../src/index.ts";
import { scanSkillRoots } from "../src/skills.ts";

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

test("registers resources, input transformation, command and completion hooks", async () => {
  const { root } = createIndex();
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

    process.env.PI_NESTED_SKILLS_ROOTS = root;
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
    delete process.env.PI_NESTED_SKILLS_ROOTS;
    rmSync(root, { recursive: true, force: true });
  }
});
