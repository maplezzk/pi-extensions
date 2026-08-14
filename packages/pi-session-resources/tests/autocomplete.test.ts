import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  applyResourceCompletion,
  createResourceAutocompleteProvider,
  extractResourceQuery,
  resourceSuggestions,
  routeResourceAutocompleteInput,
  type ResourceAutocompleteState,
} from "../src/autocomplete.ts";
import type { SessionResource } from "../src/collector.ts";

/** Creates one stable resource fixture for completion tests. */
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

/** Creates a base provider that records delegation without producing suggestions. */
function createBaseProvider(onDelegated: () => void): AutocompleteProvider {
  return {
    triggerCharacters: ["@"],
    /** Records requests not owned by the # resource provider. */
    async getSuggestions(): Promise<null> {
      onDelegated();
      return null;
    },
    /** Returns an unchanged editor state for delegated completion assertions. */
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  };
}

test("extractResourceQuery recognizes only a # token at a text boundary", () => {
  assert.equal(extractResourceQuery("#"), "");
  assert.equal(extractResourceQuery("inspect #src/ind"), "src/ind");
  assert.equal(extractResourceQuery("inspect\t#pull"), "pull");
  assert.equal(extractResourceQuery("https://example.com/#section"), undefined);
  assert.equal(extractResourceQuery("word#resource"), undefined);
});

test("resource suggestions are fuzzy-filtered, clickable, and preserve safe references", () => {
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
  assert.match(fileItem.description ?? "", /FILE · write · read · ×3/);
  assert.ok(fileItem.label.includes(`\x1b]8;;${pathToFileURL(fileTarget).href}\x1b\\`));

  const reviewItems = resourceSuggestions(resources, "pull");
  assert.ok(reviewItems.some((item) => item.value === "#https://github.com/owner/repo/pull/93"));
});

test("resource completion replaces the # query and keeps surrounding text", () => {
  const item: AutocompleteItem = {
    value: '#"docs/design notes.md"',
    label: "docs/design notes.md",
  };
  const beforeCursor = "Use #des";
  const result = applyResourceCompletion({
    lines: [`${beforeCursor} now`],
    cursorLine: 0,
    cursorCol: beforeCursor.length,
    item,
    prefix: "#des",
  });

  assert.deepEqual(result.lines, ['Use #"docs/design notes.md" now']);
  assert.equal(result.cursorCol, 'Use #"docs/design notes.md"'.length);
});

test("provider owns matching # queries and delegates unrelated input", async () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  let delegated = 0;
  const state: ResourceAutocompleteState = { active: false };
  const provider = createResourceAutocompleteProvider({
    current: createBaseProvider(() => {
      delegated += 1;
    }),
    getResources: () => [resourceFixture({})],
    onActiveChange: (active) => {
      state.active = active;
    },
  });
  const request = { signal: new AbortController().signal };

  const suggestions = await provider.getSuggestions(["inspect #ind"], 0, "inspect #ind".length, request);
  assert.equal(suggestions?.prefix, "#ind");
  assert.equal(suggestions?.items.length, 1);
  assert.equal(state.active, true);
  assert.deepEqual(routeResourceAutocompleteInput("\t", state), { data: "\x1b[B" });
  assert.deepEqual(routeResourceAutocompleteInput("\x1b[Z", state), { data: "\x1b[A" });

  const selected = suggestions?.items[0];
  assert.ok(selected);
  provider.applyCompletion(["#ind"], 0, 4, selected, "#ind");
  assert.equal(state.active, false);
  assert.equal(routeResourceAutocompleteInput("\t", state), undefined);

  await provider.getSuggestions(["plain text"], 0, "plain text".length, request);
  assert.equal(delegated, 1);
});

test("cancel keys release Tab routing without consuming Pi's input", () => {
  const state: ResourceAutocompleteState = { active: true };
  assert.equal(routeResourceAutocompleteInput("\x1b", state), undefined);
  assert.equal(state.active, false);

  state.active = true;
  assert.equal(routeResourceAutocompleteInput("\x03", state), undefined);
  assert.equal(state.active, false);
});
