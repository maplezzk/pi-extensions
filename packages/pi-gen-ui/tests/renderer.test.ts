import assert from "node:assert/strict";
import test from "node:test";
import { makeSpec, renderText } from "./helpers.ts";

test("repeat expands one container into one block per state item", () => {
  const spec = makeSpec(
    "list",
    {
      list: {
        type: "Box",
        props: { flexDirection: "column" },
        children: ["row"],
      },
      row: {
        type: "Box",
        props: { flexDirection: "row", gap: 1 },
        repeat: { statePath: "/items", key: "id" },
        children: ["name", "qty"],
      },
      name: { type: "Text", props: { text: { $item: "name" } } },
      qty: { type: "Text", props: { text: { $item: "qty" } } },
    },
    { items: [{ id: "a", name: "apple", qty: 2 }, { id: "b", name: "pear", qty: 5 }] },
  );

  const { text, warnings } = renderText(spec, 40);
  assert.match(text, /apple 2/);
  assert.match(text, /pear 5/);
  assert.deepEqual(warnings, []);
});

test("visible conditions hide elements without leaving blank rows", () => {
  const spec = makeSpec(
    "box",
    {
      box: { type: "Box", props: { flexDirection: "column" }, children: ["shown", "hidden"] },
      shown: { type: "Text", props: { text: "shown" } },
      hidden: {
        type: "Text",
        props: { text: "hidden" },
        visible: { $state: "/open", eq: true },
      },
    },
    { open: false },
  );

  const { lines, text } = renderText(spec, 30);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].trimEnd(), "shown");
});

test("a missing child reports a warning instead of rendering a gap", () => {
  const spec = makeSpec("box", {
    box: { type: "Box", props: { flexDirection: "column" }, children: ["missing"] },
  });

  const { warnings } = renderText(spec, 30);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Element "missing" is referenced but not defined/);
});

test("an unknown component name is reported and skipped", () => {
  const spec = makeSpec("root", { root: { type: "NotAComponent", props: {} } });
  const { lines, warnings } = renderText(spec, 30);
  assert.deepEqual(lines, []);
  assert.match(warnings[0], /unknown component "NotAComponent"/);
});

test("props the renderer ignores are reported, not silently dropped", () => {
  const spec = makeSpec("root", {
    root: { type: "Box", props: { marginX: 2, flexWrap: "wrap", padding: 1 }, children: [] },
  });

  const { warnings } = renderText(spec, 30);
  const joined = warnings.join("\n");
  assert.match(joined, /prop "marginX" is ignored/);
  assert.match(joined, /prop "flexWrap" is ignored/);
  assert.doesNotMatch(joined, /prop "padding" is ignored/);
});

test("a repeat over a non-array reports the state path", () => {
  const spec = makeSpec(
    "root",
    {
      root: { type: "Box", props: {}, repeat: { statePath: "/items" }, children: ["item"] },
      item: { type: "Text", props: { text: "x" } },
    },
    { items: "nope" },
  );

  const { warnings } = renderText(spec, 30);
  assert.match(warnings.join("\n"), /repeats over "\/items", which is not an array/);
});

test("a missing children array is treated as a leaf with a warning", () => {
  const spec = {
    root: "root",
    elements: { root: { type: "Text", props: { text: "leaf" } } },
  } as never;

  const { text, warnings } = renderText(spec, 30);
  assert.equal(text, "leaf");
  assert.match(warnings.join("\n"), /has no "children" array/);
});

test("specs with a missing root render nothing and explain why", () => {
  const { lines, warnings } = renderText({ root: "", elements: {} } as never, 30);
  assert.deepEqual(lines, []);
  assert.match(warnings.join("\n"), /no "root" key/);
});
