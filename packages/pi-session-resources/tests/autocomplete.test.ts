import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  extractResourceQuery,
  resourceSuggestions,
} from "../src/autocomplete.ts";
import type { SessionResource } from "../src/collector.ts";

/** Creates one stable resource fixture for suggestion tests. */
function resourceFixture(overrides: Partial<SessionResource>): SessionResource {
  return {
    key: "file:/workspace/project/src/index.ts",
    kind: "file",
    target: resolve("/workspace/project/src/index.ts"),
    label: "src/index.ts",
    actions: ["read"],
    tools: ["read"],
    firstSeenAt: 1,
    lastSeenAt: 1,
    seenCount: 1,
    ...overrides,
  };
}

test("extractResourceQuery recognizes only a # token at a text boundary", () => {
  assert.equal(extractResourceQuery("#"), "");
  assert.equal(extractResourceQuery("inspect #src/ind"), "src/ind");
  assert.equal(extractResourceQuery("inspect\t#pull"), "pull");
  assert.equal(extractResourceQuery("https://example.com/#section"), undefined);
  assert.equal(extractResourceQuery("word#resource"), undefined);
});

test("resource suggestions put type first, remain clickable, and preserve safe references", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const fileTarget = resolve("/workspace/project/docs/design notes.md");
  const resources = [
    resourceFixture({
      target: fileTarget,
      label: "docs/design notes.md",
      actions: ["changed", "read"],
      seenCount: 3,
    }),
    resourceFixture({
      key: "review:https://github.com/owner/repo/pull/93",
      kind: "review",
      target: "https://github.com/owner/repo/pull/93",
      label: "owner/repo#93",
      actions: ["created"],
    }),
    resourceFixture({
      key: "web:https://example.com/docs/getting-started",
      kind: "web",
      target: "https://example.com/docs/getting-started",
      label: "example.com/docs/getting-started",
      actions: ["opened"],
    }),
  ];

  const fileItems = resourceSuggestions(resources, "design");
  const fileItem = fileItems.find((item) => item.value === '#"docs/design notes.md"');
  assert.ok(fileItem);
  assert.match(fileItem.label, /FILE ▤ docs\/design notes\.md/);
  assert.match(fileItem.description ?? "", /write · read · ×3/);
  assert.ok(fileItem.label.includes(`\x1b]8;;${pathToFileURL(fileTarget).href}\x1b\\`));

  const reviewItems = resourceSuggestions(resources, "pull");
  assert.ok(reviewItems.some((item) => item.value === "#https://github.com/owner/repo/pull/93"));
});
