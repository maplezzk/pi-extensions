import assert from "node:assert/strict";
import test from "node:test";
import { bg, fg, SGR, style } from "../src/ansi.ts";
import { SpecView } from "../src/view.ts";
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

/**
 * A full SGR reset also clears the background, and Pi paints its own background
 * behind a tool result. One `\x1b[0m` mid-line therefore dropped the panel
 * background for the rest of that line, so trailing padding rendered in the
 * terminal default color. Styled runs must close with selective resets instead.
 */
test("styled output never emits a full SGR reset", () => {
  const spec = makeSpec("card", {
    card: {
      type: "Card",
      props: { title: "Deploy", padding: 1 },
      children: ["heading", "table", "progress", "badge"],
    },
    heading: { type: "Heading", props: { text: "Deploy" } },
    table: {
      type: "Table",
      props: {
        borderStyle: "single",
        columns: [
          { header: "Service", key: "svc", width: 12 },
          { header: "Env", key: "env", width: 8 },
        ],
        rows: [{ svc: "api-server", env: "prod" }],
      },
    },
    progress: { type: "ProgressBar", props: { label: "Rollout", progress: 0.67, width: 20 } },
    badge: { type: "Badge", props: { label: "STABLE", variant: "success" } },
  });

  for (const width of [40, 80, 120]) {
    const view = new SpecView({ spec });
    for (const line of view.render(width)) {
      assert.ok(!line.includes("\x1b[0m"), `full reset in: ${JSON.stringify(line)}`);
    }
  }
});

test("attributes are closed with their matching off code, colors with 39/49", () => {
  assert.equal(style(SGR.bold, "x"), "\x1b[1mx\x1b[22m");
  assert.equal(style(SGR.italic, "x"), "\x1b[3mx\x1b[23m");
  assert.equal(style(SGR.underline, "x"), "\x1b[4mx\x1b[24m");
  assert.equal(style(SGR.dim, "x"), "\x1b[2mx\x1b[22m");
  assert.equal(style(SGR.inverse, "x"), "\x1b[7mx\x1b[27m");
  assert.equal(style(SGR.strikethrough, "x"), "\x1b[9mx\x1b[29m");
  assert.equal(fg("red", "x"), "\x1b[31mx\x1b[39m");
  assert.equal(bg("blue", "x"), "\x1b[44mx\x1b[49m");
});
