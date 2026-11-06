import assert from "node:assert/strict";
import test from "node:test";
import type { StateModel } from "@json-render/core";
import { applyPush, applyRemove, applySet, runAction, type ActionRuntime } from "../src/actions.ts";

/** The fake runtime type, so tests can read the resulting state. */
type FakeRuntime = ActionRuntime & { state: StateModel; calls: string[] };

/** In-memory runtime that records the mutations the actions perform. */
function fakeRuntime(): FakeRuntime {
  const runtime = {
    state: { items: [{ id: "a" }], form: { name: "" } } as StateModel,
    calls: [] as string[],
    /** Record and apply a setState write. */
    set(path: string, value: unknown) {
      runtime.calls.push(`set ${path}`);
      applySet(runtime.state, path, value);
    },
    /** Record and apply a pushState write, including its optional clear path. */
    push(path: string, value: unknown, clearPath?: string) {
      runtime.calls.push(`push ${path}`);
      const issue = applyPush(runtime.state, path, value);
      if (clearPath) applySet(runtime.state, clearPath, []);
      return issue;
    },
    /** Record and apply a removeState write. */
    remove(path: string, index: number) {
      runtime.calls.push(`remove ${path}`);
      applyRemove(runtime.state, path, index);
    },
  };
  return runtime;
}

/** Run one binding and return the recorded warnings. */
async function run(binding: unknown, runtime: FakeRuntime): Promise<string[]> {
  const warnings: string[] = [];
  await runAction({
    binding: binding as never,
    elementKey: "root",
    context: { stateModel: runtime.state },
    runtime,
    handlers: {},
    warn: (message) => warnings.push(message),
  });
  return warnings;
}

test("setState writes the resolved value", async () => {
  const runtime = fakeRuntime();
  const warnings = await run(
    { action: "setState", params: { statePath: "/form/name", value: "ada" } },
    runtime,
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(runtime.state.form, { name: "ada" });
});

test("pushState appends and generates an id for $id placeholders", async () => {
  const runtime = fakeRuntime();
  await run(
    { action: "pushState", params: { statePath: "/items", value: { id: "$id", name: "b" } } },
    runtime,
  );
  const items = runtime.state.items as { id?: string; name?: string }[];
  assert.equal(items.length, 2);
  assert.equal(items[1].name, "b");
  assert.notEqual(items[1].id, "$id");
  assert.ok(typeof items[1].id === "string" && items[1].id.length > 0);
});

test("pushState can clear another path after appending", async () => {
  const runtime = fakeRuntime();
  await run(
    {
      action: "pushState",
      params: { statePath: "/items", value: { name: "b" }, clearStatePath: "/form/name" },
    },
    runtime,
  );
  assert.equal((runtime.state.items as unknown[]).length, 2);
  assert.deepEqual(runtime.state.form, { name: [] });
});

test("removeState drops the addressed array item", async () => {
  const runtime = fakeRuntime();
  await run({ action: "removeState", params: { statePath: "/items", index: 0 } }, runtime);
  assert.deepEqual(runtime.state.items, []);
});

test("binding arrays run in order", async () => {
  const runtime = fakeRuntime();
  await run(
    [
      { action: "setState", params: { statePath: "/a", value: 1 } },
      { action: "setState", params: { statePath: "/b", value: 2 } },
    ],
    runtime,
  );
  assert.equal(runtime.state.a, 1);
  assert.equal(runtime.state.b, 2);
});

test("unknown actions and unusable params are reported, not ignored", async () => {
  const runtime = fakeRuntime();
  assert.match((await run({ action: "teleport" }, runtime)).join("\n"), /unknown action "teleport"/);
  assert.match(
    (await run({ action: "setState", params: {} }, runtime)).join("\n"),
    /setState without a "statePath"/,
  );
  assert.match(
    (await run({ action: "removeState", params: { statePath: "/items" } }, runtime)).join("\n"),
    /numeric "index"/,
  );
  assert.match((await run({ action: "" }, runtime)).join("\n"), /without an action name/);
});

test("unsupported handler chains are reported", async () => {
  const runtime = fakeRuntime();
  const warnings = await run(
    {
      action: "setState",
      params: { statePath: "/a", value: 1 },
      confirm: { title: "t", message: "m" },
    },
    runtime,
  );
  assert.match(warnings.join("\n"), /confirm.*ignored/);
});

test("a custom handler receives resolved params", async () => {
  const runtime = fakeRuntime();
  const seen: unknown[] = [];
  await runAction({
    binding: { action: "custom", params: { value: "x" } },
    elementKey: "root",
    context: { stateModel: runtime.state },
    runtime,
    handlers: { custom: (params) => void seen.push(params) },
    warn: () => undefined,
  });
  assert.deepEqual(seen, [{ value: "x" }]);
});

test("a throwing handler becomes a warning instead of breaking the caller", async () => {
  const runtime = fakeRuntime();
  const warnings: string[] = [];
  await runAction({
    binding: { action: "boom" },
    elementKey: "root",
    context: { stateModel: runtime.state },
    runtime,
    handlers: {
      boom: () => {
        throw new Error("nope");
      },
    },
    warn: (message) => warnings.push(message),
  });
  assert.match(warnings.join("\n"), /Action "boom" on element "root" failed: nope/);
});

test("applyRemove leaves non-array paths untouched", () => {
  const state: StateModel = { name: "ada" };
  applyRemove(state, "/name", 0);
  assert.equal(state.name, "ada");
});

test("pushState reports a non-array target instead of overwriting it", () => {
  const state: StateModel = { name: "ada" };
  assert.match(String(applyPush(state, "/name", "b")), /not an array/);
  assert.equal(state.name, "ada");
});

test("pushState initializes a missing array path", () => {
  const state: StateModel = {};
  assert.equal(applyPush(state, "/items", { id: "a" }), undefined);
  assert.deepEqual(state.items, [{ id: "a" }]);
});
