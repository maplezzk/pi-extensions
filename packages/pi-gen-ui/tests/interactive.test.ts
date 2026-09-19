import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi } from "../src/ansi.ts";
import { SpecView } from "../src/view.ts";
import { makeSpec } from "./helpers.ts";

/**
 * Raw terminal byte sequences.
 *
 * Pi delivers key presses as the terminal writes them, so tests must send the
 * escape sequences rather than the `Key.*` identifiers that `matchesKey` uses
 * as its second argument.
 */
const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  space: " ",
  backspace: "\x7f",
  tab: "\t",
  shiftTab: "\x1b[Z",
  escape: "\x1b",
} as const;

/** Build a view for an interactive fixture and render one frame. */
function interactiveView(spec: ReturnType<typeof makeSpec>, width = 40): SpecView {
  const view = new SpecView({ spec });
  view.render(width);
  return view;
}

/** Render a view to plain text lines with trailing padding removed. */
function text(view: SpecView, width = 40): string[] {
  return view.render(width).map((line) => stripAnsi(line).trimEnd());
}

const selectSpec = makeSpec(
  "root",
  {
    root: {
      type: "Select",
      props: {
        label: "Env",
        options: [
          { label: "dev", value: "dev" },
          { label: "staging", value: "staging" },
          { label: "prod", value: "prod" },
        ],
        value: { $bindState: "/env" },
      },
    },
  },
  { env: "dev" },
);

test("Select shows a cursor, moves it, and commits on enter", () => {
  const view = interactiveView(selectSpec);
  assert.equal(text(view)[1], "› dev");

  assert.equal(view.handleInput(KEYS.down), true);
  assert.equal(text(view)[2], "› staging");

  assert.equal(view.handleInput(KEYS.enter), true);
  assert.equal(view.getState().env, "staging");
  assert.equal(view.hasInteracted(), true);
});

test("Select ignores keys it does not use", () => {
  const view = interactiveView(selectSpec);
  assert.equal(view.handleInput("x"), false);
});

test("MultiSelect toggles with space and submits with enter", () => {
  const spec = makeSpec(
    "root",
    {
      root: {
        type: "MultiSelect",
        props: {
          label: "Languages",
          options: [
            { label: "TS", value: "ts" },
            { label: "Rust", value: "rs" },
          ],
          value: { $bindState: "/langs" },
        },
      },
    },
    { langs: [] as string[] },
  );
  const view = interactiveView(spec);

  assert.equal(view.handleInput(KEYS.space), true);
  assert.deepEqual(view.getState().langs, ["ts"]);
  assert.equal(view.handleInput(KEYS.down), true);
  assert.equal(view.handleInput(KEYS.space), true);
  assert.deepEqual(view.getState().langs, ["ts", "rs"]);
  // The cursor sits on the second option, so this toggles "rs" back off.
  assert.equal(view.handleInput(KEYS.space), true);
  assert.deepEqual(view.getState().langs, ["ts"]);
  assert.equal(view.handleInput(KEYS.enter), true);
});

test("MultiSelect refuses to go below the declared minimum", () => {
  const spec = makeSpec(
    "root",
    {
      root: {
        type: "MultiSelect",
        props: {
          options: [{ label: "TS", value: "ts" }],
          value: { $bindState: "/langs" },
          min: 1,
        },
      },
    },
    { langs: ["ts"] },
  );
  const view = interactiveView(spec);

  assert.equal(view.handleInput(KEYS.space), true);
  assert.deepEqual(view.getState().langs, ["ts"]);
  assert.match(view.getWarnings().join("\n"), /requires at least 1 selections/);
});

test("TextInput accumulates printable characters and submits on enter", () => {
  const spec = makeSpec(
    "root",
    {
      root: { type: "TextInput", props: { label: "Name", value: { $bindState: "/name" } } },
    },
    { name: "" },
  );
  const view = interactiveView(spec);

  assert.equal(view.handleInput("a"), true);
  assert.equal(view.handleInput("b"), true);
  assert.equal(view.getState().name, "ab");

  assert.equal(view.handleInput(KEYS.backspace), true);
  assert.equal(view.getState().name, "a");

  assert.equal(view.handleInput(KEYS.enter), true);
  assert.ok(view.hasInteracted());
});

test("TextInput masks the value when mask is set", () => {
  const spec = makeSpec(
    "root",
    {
      root: { type: "TextInput", props: { mask: "*", value: "secret" } },
    },
    {},
  );
  const view = interactiveView(spec);
  assert.equal(text(view)[0], "******");
});

test("ConfirmInput dispatches confirm and deny", () => {
  const warnings: string[] = [];
  const spec = makeSpec("root", {
    root: {
      type: "ConfirmInput",
      props: { message: "Delete?" },
      on: {
        confirm: { action: "setState", params: { statePath: "/ok", value: true } },
        deny: { action: "setState", params: { statePath: "/ok", value: false } },
      },
    },
  });
  const view = new SpecView({ spec, onWarn: (message) => warnings.push(message) });
  view.render(40);

  assert.equal(view.handleInput("y"), true);
  assert.equal(view.getState().ok, true);
  assert.equal(text(view).length, 1);
  assert.deepEqual(warnings, []);
});

test("Tabs change the bound value with arrow keys", () => {
  const spec = makeSpec(
    "root",
    {
      root: {
        type: "Tabs",
        props: {
          tabs: [
            { label: "One", value: "one" },
            { label: "Two", value: "two" },
          ],
          value: { $bindState: "/tab" },
        },
      },
    },
    { tab: "one" },
  );
  const view = interactiveView(spec);

  assert.equal(view.handleInput(KEYS.right), true);
  assert.equal(view.getState().tab, "two");
  assert.equal(view.handleInput(KEYS.right), true);
  assert.equal(view.getState().tab, "one");
  assert.equal(view.handleInput(KEYS.left), true);
  assert.equal(view.getState().tab, "two");
});

test("Tab and shift+tab move focus between interactive elements", () => {
  const spec = makeSpec(
    "root",
    {
      root: { type: "Box", props: { flexDirection: "column" }, children: ["first", "second"] },
      first: { type: "Select", props: { options: [{ label: "a", value: "a" }], value: { $bindState: "/a" } } },
      second: { type: "TextInput", props: { value: { $bindState: "/b" } } },
    },
    { a: "a", b: "" },
  );
  const view = interactiveView(spec);

  // Focus starts on the first interactive element, so a printable key is not consumed.
  assert.equal(view.handleInput("z"), false);
  assert.equal(view.handleInput(KEYS.shiftTab), true);
  assert.equal(view.handleInput("z"), true);
  assert.equal(view.getState().b, "z");
});

test("Escape asks the host to close the panel", () => {
  let closed = false;
  const view = new SpecView({
    spec: selectSpec,
    onClose: () => {
      closed = true;
    },
  });
  view.render(40);
  assert.equal(view.handleInput(KEYS.escape), true);
  assert.equal(closed, true);
});

test("state changes trigger a re-render request", () => {
  let renders = 0;
  const view = new SpecView({
    spec: selectSpec,
    requestRender: () => {
      renders += 1;
    },
  });
  view.render(40);
  // Move the cursor first: committing the already-selected value is a no-op
  // write, and the store correctly skips notifying on no-ops.
  view.handleInput(KEYS.down);
  view.handleInput(KEYS.enter);
  assert.ok(renders >= 1, `expected a render request, got ${renders}`);
});

test("an unbound interactive value falls back to ephemeral local state", () => {
  const spec = makeSpec("root", {
    root: {
      type: "Select",
      props: {
        options: [
          { label: "a", value: "a" },
          { label: "b", value: "b" },
        ],
      },
    },
  });
  const view = interactiveView(spec);
  view.handleInput(KEYS.down);
  view.handleInput(KEYS.enter);
  assert.deepEqual(view.getState(), {});
  assert.equal(text(view)[1], "› b");
});
