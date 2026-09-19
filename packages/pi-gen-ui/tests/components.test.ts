import assert from "node:assert/strict";
import test from "node:test";
import { SpecView } from "../src/view.ts";
import { makeSpec, renderElementText } from "./helpers.ts";

test("Box draws a border and honors padding and gap", () => {
  const { lines } = renderElementText({
    type: "Box",
    props: { flexDirection: "column", borderStyle: "round", padding: 1, gap: 1 },
    width: 20,
    children: {
      a: { type: "Text", props: { text: "one" } },
      b: { type: "Text", props: { text: "two" } },
    },
  });

  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines[lines.length - 1], /^╰─+╯$/);
  // border(2) + padding(2) + two children(2) + one gap line
  assert.equal(lines.length, 7);
  const inner = lines.map((line) => line.slice(1, -1));
  assert.ok(inner.some((line) => line.trim() === "one"));
  assert.ok(inner.some((line) => line.trim() === "two"));
});

test("Box row layout puts children side by side and keeps the row inside the width", () => {
  const { lines } = renderElementText({
    type: "Box",
    props: { flexDirection: "row", gap: 1 },
    width: 24,
    children: {
      a: { type: "Text", props: { text: "left" } },
      b: { type: "Text", props: { text: "right" } },
    },
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^left\s+right\s*$/);
  assert.ok(lines[0].length <= 24);
});

test("row cells keep their own width when a sibling pads to full width", () => {
  // Regression: a highlighted Select row and a Badge both pad to the space
  // they were given. Measuring that padding as natural width starved the
  // sibling down to one column, and re-clamping turned its last space into an
  // ellipsis. Both cells must survive at their content width.
  const { lines, warnings } = renderElementText({
    type: "Box",
    props: { flexDirection: "row", gap: 2 },
    width: 40,
    children: {
      select: {
        type: "Select",
        props: {
          label: "Env",
          options: [
            { label: "stable", value: "stable" },
            { label: "beta", value: "beta" },
          ],
          value: { $bindState: "/env" },
        },
      },
      badge: { type: "Badge", props: { label: "LIVE", variant: "success" } },
    },
  });

  const first = lines[0].trimEnd();
  assert.match(first, /^Env\s+LIVE$/);
  assert.ok(!first.includes("…"), `unexpected truncation: ${first}`);
  assert.deepEqual(warnings, []);
});

test("Box with display none renders nothing", () => {
  const { lines } = renderElementText({ type: "Box", props: { display: "none" } });
  assert.deepEqual(lines, []);
});

test("Text truncates when asked and wraps by default", () => {
  const truncated = renderElementText({
    type: "Text",
    props: { text: "abcdefghij", wrap: "truncate" },
    width: 6,
  });
  assert.deepEqual(truncated.lines, ["abcde…"]);

  const wrapped = renderElementText({ type: "Text", props: { text: "aaa bbb ccc" }, width: 7 });
  assert.equal(wrapped.lines.length, 2);
  assert.equal(wrapped.lines.join(" "), "aaa bbb ccc");
});

test("Heading levels apply different emphasis", () => {
  const h1 = renderElementText({ type: "Heading", props: { text: "t", level: "h1" } });
  const h4 = renderElementText({ type: "Heading", props: { text: "t", level: "h4" } });
  assert.equal(h1.lines[0], "t");
  assert.equal(h4.lines[0], "t");
});

test("Divider fills the requested width and centers a title", () => {
  const { lines } = renderElementText({
    type: "Divider",
    props: { title: "hi", width: 12 },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "──── hi ────");
});

test("Badge and StatusLine expose their variant text", () => {
  assert.deepEqual(renderElementText({ type: "Badge", props: { label: "LIVE" } }).lines, [" LIVE "]);
  assert.equal(
    renderElementText({ type: "StatusLine", props: { text: "ok", status: "success" } }).lines[0],
    "✔ ok",
  );
});

test("Table aligns columns and keeps rows inside the width", () => {
  const { lines } = renderElementText({
    type: "Table",
    props: {
      columns: [
        { header: "Name", key: "name" },
        { header: "Qty", key: "qty", align: "right" },
      ],
      rows: [
        { name: "apple", qty: "2" },
        { name: "pear", qty: "15" },
      ],
    },
    width: 30,
  });

  assert.ok(lines.every((line) => line.length <= 30));
  assert.match(lines[0], /Name\s+Qty/);
  assert.match(lines[2], /apple\s+2\s*$/);
  assert.match(lines[3], /pear\s+15\s*$/);
});

test("Table column width hints are respected when they fit", () => {
  const { lines } = renderElementText({
    type: "Table",
    props: {
      columns: [{ header: "Name", key: "name", width: 8 }],
      rows: [{ name: "a-very-long-name" }],
    },
    width: 40,
  });
  assert.equal(lines[0].trimEnd(), "Name");
  assert.equal(lines[2].trimEnd().length, 8);
});

test("ProgressBar reports the filled ratio and percentage", () => {
  const { lines } = renderElementText({
    type: "ProgressBar",
    props: { progress: 0.5, width: 10, label: "Build" },
  });
  assert.match(lines[0], /^Build █+░+ 50%$/);
});

test("Sparkline renders one glyph per data point", () => {
  const { lines } = renderElementText({
    type: "Sparkline",
    props: { data: [0, 4, 8], label: "CPU" },
  });
  // 0/4/8 map onto the 8 block glyphs at their min..max position.
  assert.match(lines[0], /^CPU ▁▅█$/);
});

test("BarChart labels each bar and shows percentages", () => {
  const { lines } = renderElementText({
    type: "BarChart",
    props: {
      data: [
        { label: "a", value: 75 },
        { label: "b", value: 25 },
      ],
      showPercentage: true,
      width: 8,
    },
    width: 30,
  });
  assert.match(lines[0], /^a +█+ \(75%\)$/);
  assert.match(lines[1], /^b +█+ \(25%\)$/);
});

test("List renders ordered and unordered markers", () => {
  assert.deepEqual(renderElementText({ type: "List", props: { items: ["a", "b"] } }).lines, ["• a", "• b"]);
  assert.deepEqual(
    renderElementText({ type: "List", props: { items: ["a", "b"], ordered: true } }).lines,
    ["1. a", "2. b"],
  );
});

test("KeyValue joins array values and uses the separator", () => {
  const { lines } = renderElementText({
    type: "KeyValue",
    props: { label: "Tags", value: ["a", "b"], separator: "=" },
  });
  assert.equal(lines[0], "Tags= a, b");
});

test("Callout prefixes each line with a colored bar", () => {
  const { lines } = renderElementText({
    type: "Callout",
    props: { type: "warning", title: "Careful", content: "check this" },
  });
  assert.equal(lines[0], "│ Careful");
  assert.equal(lines[1], "│ check this");
});

test("Metric and Timeline render their structured fields", () => {
  const metric = renderElementText({
    type: "Metric",
    props: { label: "Revenue", value: "$10", detail: "24h", trend: "up" },
  });
  assert.deepEqual(metric.lines, ["Revenue", "$10 ↑", "24h"]);

  const timeline = renderElementText({
    type: "Timeline",
    props: {
      items: [
        { title: "Start", date: "Jan", status: "completed" },
        { title: "End", status: "upcoming" },
      ],
    },
    width: 40,
  });
  assert.match(timeline.lines[0], /^✔ Start\s+Jan$/);
  assert.ok(timeline.lines.some((line) => line.includes("○ End")));
});

test("ListItem puts the title and trailing text on one row", () => {
  const { lines } = renderElementText({
    type: "ListItem",
    props: { title: "index.ts", trailing: "2 KB", subtitle: "modified" },
    width: 24,
  });
  assert.match(lines[0], /^index\.ts\s+2 KB$/);
  assert.equal(lines[1], "  modified");
});

test("Card pads its content and renders the title", () => {
  const { lines } = renderElementText({
    type: "Card",
    props: { title: "Details", padding: 1 },
    width: 20,
    children: { body: { type: "Text", props: { text: "hello" } } },
  });
  assert.equal(lines[0], " ".repeat(20));
  assert.match(lines[1], /^ Details/);
  assert.match(lines[2], /^ hello/);
  assert.ok(lines.every((line) => line.length === 20));
});

test("unsupported border styles fall back and are reported", () => {
  const { warnings } = renderElementText({
    type: "Box",
    props: { borderStyle: "singleDouble" },
    width: 10,
  });
  assert.match(warnings.join("\n"), /borderStyle "singleDouble" cannot be drawn/);
});

test("Markdown renders headings, lists, quotes and links", () => {
  const { lines } = renderElementText({
    type: "Markdown",
    props: { text: "# Title\n\n- one\n- two\n\n> quoted\n\n---\n" },
    width: 20,
  });
  const text = lines.join("\n");
  assert.match(text, /Title/);
  assert.match(text, /• one/);
  assert.match(text, /│ quoted/);
  assert.ok(lines.some((line) => line.startsWith("─")));
});

test("named colors and hex colors become ANSI, unknown names are ignored", () => {
  /** Render one colored Text element and return its raw first line. */
  const render = (color: string): string =>
    new SpecView({ spec: makeSpec("root", { root: { type: "Text", props: { text: "x", color } } }) }).render(20)[0];

  // Colors close with 39 (foreground off), not a full reset: `\x1b[0m` would
  // clear the background Pi paints behind the tool result.
  assert.match(render("red"), /^\u001b\[31mx\u001b\[39m$/);
  assert.match(render("#ff0000"), /^\u001b\[38;2;255;0;0mx\u001b\[39m$/);
  assert.equal(render("chartreuse"), "x");
});
