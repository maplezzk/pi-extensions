import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionResource } from "../src/collector.ts";
import {
  COMPACT_RESOURCE_LIMIT,
  renderResourceWidget,
} from "../src/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Creates a stable resource fixture with caller-provided identity fields. */
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

test("widget emits clickable file and web links", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const lines = renderResourceWidget({
    resources: [
      resourceFixture({}),
      resourceFixture({
        key: "web:https://example.com/docs",
        kind: "web",
        target: "https://example.com/docs?token=secret",
        label: "example.com/docs",
        actions: ["opened"],
        tools: ["browser_navigate"],
        lastSeenAt: 2,
      }),
    ],
    width: 80,
    expanded: false,
    theme,
  });

  assert.match(lines.join("\n"), /\x1b]8;;file:\/\//);
  assert.match(lines.join("\n"), /\x1b]8;;https:\/\/example\.com\/docs\?token=secret/);
  assert.doesNotMatch(lines.join("\n"), /example\.com\/docs\?token=secret  \[/);
});

test("widget rows remain within terminal width", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const width = 32;
  const lines = renderResourceWidget({
    resources: [
      resourceFixture({
        label: "packages/a-very-long-package-name/src/a-very-long-file-name.ts",
        actions: ["changed", "read", "opened"],
      }),
    ],
    width,
    expanded: false,
    theme,
  });

  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
});

test("collapsed widget limits rows and reports hidden resources", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const resources = Array.from({ length: COMPACT_RESOURCE_LIMIT + 2 }, (_value, index) =>
    resourceFixture({
      key: `file:${index}`,
      target: resolve(`/workspace/project/file-${index}.ts`),
      label: `file-${index}.ts`,
      lastSeenAt: index,
    }),
  ).reverse();

  const lines = renderResourceWidget({ resources, width: 80, expanded: false, theme });
  assert.equal(lines.length, COMPACT_RESOURCE_LIMIT + 2);
  assert.match(lines.at(-1) ?? "", /2 more/);
});
