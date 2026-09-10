import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { createState } from "../src/state.ts";
import { loadProcedure, reconcileContext, PROCEDURE_CONTEXT, STATUS_CONTEXT } from "../src/context.ts";

for (const locale of ["zh-CN", "en-US"]) {
  test(`五阶段资源完整且可按语言加载：${locale}`, () => {
    const previous = process.env.PI_EXTENSIONS_LOCALE;
    process.env.PI_EXTENSIONS_LOCALE = locale;
    try {
      const bodies = new Set<string>();
      for (const phase of ["requirements", "design", "tasks", "implementation", "verification"] as const) {
        const state = { ...createState("demo", "Demo", "quick"), phase };
        const body = loadProcedure(state);
        assert.ok(body); assert.ok(body.length > 200); bodies.add(body);
        assert.match(body, locale === "zh-CN" ? /当前阶段方法/ : /Current stage procedure/);
      }
      assert.equal(bodies.size, 5);
    } finally {
      if (previous === undefined) delete process.env.PI_EXTENSIONS_LOCALE;
      else process.env.PI_EXTENSIONS_LOCALE = previous;
    }
  });
}

test("无正文的状态不读资源，缺失、损坏、空正文均不能降级", () => {
  const root = pathToFileURL(`${mkdtempSync(join(tmpdir(), "pi-spec-procedure-"))}/`);
  const state = createState("demo", "Demo", "strict");
  assert.equal(loadProcedure({ ...state, status: "awaiting_approval" }, root), null);
  assert.equal(loadProcedure({ ...state, phase: "complete" }, root), null);
  assert.throws(() => loadProcedure(state, root), /ENOENT/);
  writeFileSync(new URL("requirements.json", root), "{");
  assert.throws(() => loadProcedure(state, root), SyntaxError);
  writeFileSync(new URL("requirements.json", root), JSON.stringify({ body: { "zh-CN": "", "en-US": "" } }));
  assert.throws(() => loadProcedure(state, root));
});

test("只清理自有 custom 消息，保留用户、工具和其他扩展的原对象与顺序", () => {
  const messages: ContextEvent["messages"] = [
    { role: "user", content: "old procedure", timestamp: 1 },
    { role: "custom", customType: "another-extension", content: "old procedure", display: false, timestamp: 2 },
    { role: "toolResult", toolName: "read", toolCallId: "1", content: [{ type: "text", text: "old procedure" }], isError: false, timestamp: 3 },
  ];
  const first = reconcileContext(messages, "status one", "body one");
  const procedure = first.find((m) => m.role === "custom" && m.customType === PROCEDURE_CONTEXT);
  const second = reconcileContext(first, "status two", "body one");
  assert.ok(second.includes(procedure!));
  assert.deepEqual(second.slice(0, 3), messages);
  assert.equal(second.filter((m) => m.role === "custom" && m.customType === STATUS_CONTEXT).length, 1);
  assert.equal(second.filter((m) => m.role === "custom" && m.customType === PROCEDURE_CONTEXT).length, 1);
  assert.deepEqual(reconcileContext(second, null, null), messages);
  assert.equal(first.length, 5);
});
