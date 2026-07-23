import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTool } from "../src/workflow-tool.ts";

test("createWorkflowTool describes phases as required and dynamic", () => {
  const tool = createWorkflowTool();

  assert.match(tool.promptSnippet ?? "", /export const meta = \{ name: 'short_snake_case', description:/);
  assert.match(tool.promptSnippet ?? "", /phases: \[\{/);
  assert.doesNotMatch(tool.promptSnippet ?? "", /phases is optional|phases \(optional\)/i);
  // 必须明确说 phases 是 REQUIRED
  assert.ok(
    (tool.promptGuidelines ?? []).some((line) => /meta\.phases is REQUIRED/i.test(line)),
    "promptGuidelines must explicitly state meta.phases is REQUIRED",
  );
  assert.ok(
    (tool.promptGuidelines ?? []).some((line) => line.includes("Phase names may be conditional or built in a loop")),
  );
});

test("createWorkflowTool warns against wrong phase shapes (title vs name vs strings)", () => {
  const tool = createWorkflowTool();
  const guidelines = tool.promptGuidelines ?? [];

  // 明确告知 title 字段（不能用 name）
  assert.ok(
    guidelines.some((line) => /title/.test(line) && /not\s+`name`/i.test(line)),
    "promptGuidelines must warn against phases using `name` instead of `title`",
  );

  // 明确告知字符串数组是错误的
  assert.ok(
    guidelines.some((line) => /\['A',\s*'B'\]/.test(line) || /strings?\)/i.test(line)),
    "promptGuidelines must warn against phases being a string array",
  );

  // 引用准确的错误信息，方便 AI 排错
  assert.ok(
    guidelines.some((line) => line.includes("each meta phase must have a title string")),
    "promptGuidelines must include the exact parser error so AI can match it",
  );

  // 引用缺 phases 的错误信息
  assert.ok(
    guidelines.some((line) => line.includes("meta.phases must be a non-empty array")),
    "promptGuidelines must include the missing-phases parser error",
  );
});

test("createWorkflowTool documents meta literal-only constraint", () => {
  const tool = createWorkflowTool();
  const guidelines = tool.promptGuidelines ?? [];

  // 禁止 spread
  assert.ok(guidelines.some((line) => line.includes("...base") || line.includes("spread")));
  // 禁止 computed key
  assert.ok(guidelines.some((line) => line.includes("computed keys")));
  // 禁止 function call
  assert.ok(guidelines.some((line) => line.includes("function calls") || line.includes("makeName()")));
  // 禁止 template interpolation（用 backtick 模板或 interpolation 关键字）
  assert.ok(
    guidelines.some(
      (line) => line.includes("template interpolation") || line.includes("template strings with substitutions"),
    ),
  );
});

test("createWorkflowTool documents meta.whenToUse optional field", () => {
  const tool = createWorkflowTool();
  const guidelines = tool.promptGuidelines ?? [];

  assert.ok(
    guidelines.some((line) => line.includes("meta.whenToUse")),
    "promptGuidelines must mention the meta.whenToUse optional string field",
  );
});

test("createWorkflowTool emphasizes agent() schema requirement everywhere", () => {
  const tool = createWorkflowTool();

  // description
  assert.match(tool.description ?? "", /REQUIRES opts\.schema/);

  // promptSnippet
  assert.match(tool.promptSnippet ?? "", /opts\.schema|schema.*JSON Schema|JSON Schema.*schema/i);

  // script parameter description
  const scriptParam = (tool.parameters as any)?.properties?.script;
  assert.ok(scriptParam?.description, "script parameter must have a description");
  assert.match(scriptParam.description, /schema/i);

  // promptGuidelines: 至少一条明确说 schema REQUIRED
  assert.ok(
    (tool.promptGuidelines ?? []).some((line) => /REQUIRES\s+opts\.schema/.test(line)),
    "promptGuidelines must have an explicit opts.schema REQUIRED rule",
  );
});
