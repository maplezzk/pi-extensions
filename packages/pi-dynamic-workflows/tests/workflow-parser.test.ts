import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowScript } from "../src/workflow.ts";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  whenToUse: 'When testing parser behavior',
  phases: [{ title: 'Scan', detail: 'Collect inputs', model: 'default' }]
}

phase('Scan')
return { ok: true }
`;

test("parseWorkflowScript accepts literal workflow metadata", () => {
  const parsed = parseWorkflowScript(validScript);
  assert.equal(parsed.meta.name, "demo_workflow");
  assert.equal(parsed.meta.description, "A useful workflow");
  assert.deepEqual(parsed.meta.phases, [{ title: "Scan", detail: "Collect inputs", model: "default" }]);
  assert.match(parsed.body, /phase\('Scan'\)/);
  assert.doesNotMatch(parsed.body, /export const meta/);
});

test("parseWorkflowScript accepts static template literals", () => {
  const parsed = parseWorkflowScript(
    "export const meta = { name: `demo`, description: `static`, phases: [{ title: 'A' }] }\nreturn true",
  );
  assert.equal(parsed.meta.name, "demo");
  assert.equal(parsed.meta.description, "static");
});

test("parseWorkflowScript requires meta export first", () => {
  assert.throws(
    () => parseWorkflowScript("const x = 1\nexport const meta = { name: 'demo', description: 'desc' }"),
    /must be the first statement/,
  );
});

test("parseWorkflowScript requires name and description", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', phases: [{ title: 'A' }] }"),
    /meta.description/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { description: 'desc', phases: [{ title: 'A' }] }"),
    /meta.name/,
  );
});

test("parseWorkflowScript requires meta.phases", () => {
  // 缺失
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }"),
    /meta\.phases must be a non-empty array/,
  );
  // 空数组
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [] }"),
    /meta\.phases must be a non-empty array/,
  );
  // 非数组
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: 'A' }"),
    /meta\.phases must be a non-empty array/,
  );
});

test("parseWorkflowScript rejects non-literal metadata", () => {
  assert.throws(
    () =>
      parseWorkflowScript("export const meta = { name: makeName(), description: 'desc', phases: [{ title: 'A' }] }"),
    /non-literal node type.*CallExpression/,
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "const name = 'demo'; export const meta = { name, description: 'desc', phases: [{ title: 'A' }] }",
      ),
    /must be the first statement/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: name, description: 'desc', phases: [{ title: 'A' }] }"),
    /non-literal node type.*Identifier/,
  );
});

test("parseWorkflowScript rejects object hazards", () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { ...base, name: 'demo', description: 'desc', phases: [{ title: 'A' }] }",
      ),
    /spread not allowed/,
  );
  assert.throws(
    () =>
      parseWorkflowScript("export const meta = { ['name']: 'demo', description: 'desc', phases: [{ title: 'A' }] }"),
    /computed keys not allowed/,
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { __proto__: {}, name: 'demo', description: 'desc', phases: [{ title: 'A' }] }",
      ),
    /reserved key name/,
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { get name() { return 'demo' }, description: 'desc', phases: [{ title: 'A' }] }",
      ),
    /methods\/accessors not allowed/,
  );
});

test("parseWorkflowScript rejects array hazards", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [,,] }"),
    /sparse arrays not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [...items] }"),
    /spread not allowed/,
  );
});

test("parseWorkflowScript rejects template interpolation", () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: `demo_$" + "{id}`, description: 'desc', phases: [{ title: 'A' }] }",
      ),
    /template interpolation not allowed/,
  );
});

test("parseWorkflowScript rejects nondeterministic APIs", () => {
  for (const expression of [
    "Date.now()",
    "Date['now']()",
    "Date[`now`]()",
    "Date['n' + 'ow']()",
    "Date?.now()",
    "Date.now?.()",
    "Math.random()",
    "Math['random']()",
    "Math[`random`]()",
    "Math['ran' + 'dom']()",
    "Math?.random()",
    "Math.random?.()",
    "new Date()",
    "new (Date)()",
    "`timestamp $" + "{Date.now()}`",
  ]) {
    assert.throws(
      () =>
        parseWorkflowScript(
          `export const meta = { name: 'demo', description: 'desc', phases: [{ title: 'A' }] }\nreturn ${expression}`,
        ),
      /must be deterministic/,
      expression,
    );
  }
});

test("parseWorkflowScript allows deterministic Date and Math APIs", () => {
  for (const expression of [
    "Date.parse('2020-01-01T00:00:00Z')",
    "Date.UTC(2020, 0, 1)",
    "Math.max(1, 2)",
    "Math.floor(1.5)",
    "({ Date: { now: true }, Math: { random: true } })",
    "({ now: () => 1 }).now()",
    "({ random: () => 1 }).random()",
  ]) {
    assert.doesNotThrow(
      () =>
        parseWorkflowScript(
          `export const meta = { name: 'demo', description: 'desc', phases: [{ title: 'A' }] }\nreturn ${expression}`,
        ),
      expression,
    );
  }
});

test("parseWorkflowScript allows nondeterministic API names in text", () => {
  const parsed = parseWorkflowScript(`export const meta = {
  name: 'mentions_demo',
  description: 'Catalog Date.now(), Math.random(), and new Date() usage',
  whenToUse: 'When prompts mention Date.now()',
  phases: [{ title: 'Find Date.now() mentions', detail: 'Check Math.random() and new Date() too' }]
}

// Comments may mention Date.now(), Math.random(), and new Date().
const terms = {
  'Date.now()': 'Date.now()',
  'Math.random()': 'Math.random()',
  'new Date()': 'new Date()'
}
phase('Find Date.now() mentions')
await agent('Catalog Date.now(), Math.random(), and new Date() usage')
await agent(\`Find Date.now(), Math.random(), and new Date() mentions\`)
return { ok: true, terms }
`);

  assert.equal(parsed.meta.description, "Catalog Date.now(), Math.random(), and new Date() usage");
  assert.match(parsed.body, /Catalog Date\.now\(\)/);
});
