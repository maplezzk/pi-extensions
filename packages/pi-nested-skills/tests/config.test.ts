import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  configPath,
  defaultSkillRoots,
  loadConfig,
  resolveSkillRoot,
} from "../src/config.ts";

function makeAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-nested-skills-agent-"));
}

test("uses the Pi agent skills directory by default", () => {
  const agentDir = makeAgentDir();
  try {
    assert.deepEqual(defaultSkillRoots(agentDir), [join(agentDir, "skills")]);
    const loaded = loadConfig(agentDir, {});
    assert.deepEqual(loaded.config.skillRoots, [join(agentDir, "skills")]);
    assert.equal(loaded.source, "default");
    assert.equal(loaded.explicit, false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("resolves environment roots and lets file configuration override them", () => {
  const agentDir = makeAgentDir();
  try {
    const fromEnvironment = loadConfig(agentDir, {
      PI_NESTED_SKILLS_ROOTS: "~/shared,project-skills",
    });
    assert.deepEqual(fromEnvironment.config.skillRoots, [
      join(process.env.HOME ?? "/tmp", "shared"),
      join(agentDir, "project-skills"),
    ]);
    assert.equal(fromEnvironment.source, "environment");

    mkdirSync(join(agentDir, "extensions", "pi-nested-skills"), { recursive: true });
    writeFileSync(
      configPath(agentDir),
      JSON.stringify({ skillRoots: ["configured-skills"] }),
    );
    const fromFile = loadConfig(agentDir, { PI_NESTED_SKILLS_ROOTS: "ignored" });
    assert.deepEqual(fromFile.config.skillRoots, [join(agentDir, "configured-skills")]);
    assert.equal(fromFile.source, "file");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("accepts the legacy single-directory configuration and reports malformed files", () => {
  const agentDir = makeAgentDir();
  try {
    mkdirSync(join(agentDir, "extensions", "pi-nested-skills"), { recursive: true });
    writeFileSync(configPath(agentDir), JSON.stringify({ skillsDir: "legacy" }));
    assert.deepEqual(loadConfig(agentDir, {}).config.skillRoots, [join(agentDir, "legacy")]);

    writeFileSync(configPath(agentDir), "not-json");
    const malformed = loadConfig(agentDir, {});
    assert.equal(malformed.source, "default");
    assert.equal(malformed.warnings.length, 1);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("expands home and agent-relative paths", () => {
  assert.equal(resolveSkillRoot("~", "/agent", "/home/test"), "/home/test");
  assert.equal(resolveSkillRoot("~/skills", "/agent", "/home/test"), "/home/test/skills");
  assert.equal(resolveSkillRoot("skills", "/agent", "/home/test"), "/agent/skills");
});
