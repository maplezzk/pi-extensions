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
    const loaded = loadConfig(agentDir);
    assert.deepEqual(loaded.config.skillRoots, [join(agentDir, "skills")]);
    assert.equal(loaded.source, "default");
    assert.equal(loaded.explicit, false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("uses file configuration and ignores old environment configuration", () => {
  const agentDir = makeAgentDir();
  try {
    mkdirSync(join(agentDir, "extensions", "pi-nested-skills"), { recursive: true });
    writeFileSync(
      configPath(agentDir),
      JSON.stringify({ skillRoots: ["configured-skills"] }),
    );
    const loaded = loadConfig(agentDir);
    assert.deepEqual(loaded.config.skillRoots, [join(agentDir, "configured-skills")]);
    assert.equal(loaded.source, "file");
    assert.equal(loaded.explicit, true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("accepts the legacy single-directory configuration and reports malformed files", () => {
  const agentDir = makeAgentDir();
  try {
    mkdirSync(join(agentDir, "extensions", "pi-nested-skills"), { recursive: true });
    writeFileSync(configPath(agentDir), JSON.stringify({ skillsDir: "legacy" }));
    assert.deepEqual(loadConfig(agentDir).config.skillRoots, [join(agentDir, "legacy")]);

    writeFileSync(configPath(agentDir), "not-json");
    const malformed = loadConfig(agentDir);
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
