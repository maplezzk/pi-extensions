import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  parseSkillFrontmatter,
  scanSkillRoots,
} from "../src/skills.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-nested-skills-test-"));
}

function writeSkill(path: string, name: string, description = "A test skill"): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

test("parses simple quoted and unquoted frontmatter fields", () => {
  assert.deepEqual(
    parseSkillFrontmatter(
      "---\nname: nested-skill\ndescription: \"A nested skill\"\n---\nbody",
    ),
    { name: "nested-skill", description: "A nested skill" },
  );
  assert.deepEqual(parseSkillFrontmatter("# no frontmatter"), {});
});

test("discovers direct and deeply nested skills with dot aliases", () => {
  const root = makeRoot();
  try {
    writeSkill(join(root, "development", "code-reviewer"), "code-reviewer");
    writeSkill(join(root, "development", "database", "sql"), "sql-generator");
    writeSkill(join(root, "design"), "design-root");
    writeSkill(join(root, ".hidden", "ignored"), "ignored");

    const result = scanSkillRoots([root]);
    assert.deepEqual(result.skills.map((skill) => [skill.packName, skill.skillDir, skill.skillName]), [
      ["design", "", "design-root"],
      ["development", "code-reviewer", "code-reviewer"],
      ["development", "database.sql", "sql-generator"],
    ]);
    assert.equal(result.skillPaths.length, 3);
    assert.equal(result.warnings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a root that is itself a skill directory and reports missing roots", () => {
  const skillRoot = makeRoot();
  const missingRoot = join(skillRoot, "missing");
  try {
    writeSkill(skillRoot, "standalone");
    const result = scanSkillRoots([skillRoot, missingRoot]);
    assert.equal(result.skills[0]?.packName, skillRoot.split(/[\\/]/).at(-1));
    assert.equal(result.skills[0]?.skillDir, "");
    assert.equal(result.warnings[0]?.path, missingRoot);
  } finally {
    rmSync(skillRoot, { recursive: true, force: true });
  }
});

test("keeps the skill path for Pi native loading even when description is missing", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "pack", "broken"), { recursive: true });
    writeFileSync(join(root, "pack", "broken", "SKILL.md"), "---\nname: broken\n---\n");
    const result = scanSkillRoots([root]);
    assert.equal(result.skillPaths.length, 1);
    assert.equal(result.skills.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
