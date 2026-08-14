import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  bg: (_color: string, text: string) => text,
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

test("widget percent-encodes spaces in OSC 8 file and web targets", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const fileTarget = resolve("/workspace/project/docs/design notes/context map.md");
  const fileUri = pathToFileURL(fileTarget).href;
  const webUri = "https://example.com/docs/get%20started?q=hello%20world";
  const resources = [
    resourceFixture({
      target: fileTarget,
      label: "docs/design notes/context map.md",
    }),
    resourceFixture({
      key: `web:${webUri}`,
      kind: "web",
      target: webUri,
      label: "example.com/docs/get started",
      actions: ["opened"],
      tools: ["browser_navigate"],
      lastSeenAt: 2,
    }),
  ];
  const fileLines = renderResourceWidget({
    resources,
    width: 80,
    expanded: false,
    activeTab: "file",
    theme,
  });
  const webLines = renderResourceWidget({
    resources,
    width: 80,
    expanded: false,
    activeTab: "web",
    theme,
  });
  const output = [...fileLines, ...webLines].join("\n");

  assert.match(fileLines[1] ?? "", /FILE 1.*PR\/MR 0.*WEB 1/);
  assert.doesNotMatch(fileLines.join("\n"), /example\.com/);
  assert.doesNotMatch(webLines.join("\n"), /docs\/design notes/);
  assert.ok(fileUri.includes("design%20notes/context%20map.md"));
  assert.ok(output.includes(`\x1b]8;;${fileUri}\x1b\\`));
  assert.ok(output.includes(`\x1b]8;;${webUri}\x1b\\`));
  const targets = output
    .split("\x1b]8;;")
    .slice(1)
    .map((segment) => segment.split("\x1b\\")[0])
    .filter(Boolean);
  assert.deepEqual(targets, [fileUri, webUri]);
  assert.ok(targets.every((target) => !/\s/.test(target)));
  assert.doesNotMatch(output, /\x1b]8;;[^\x1b]*docs\/design notes/);
});

test("label truncation never cuts the OSC 8 control sequence or target", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  const target = resolve("/workspace/project/docs/design notes/a very long context map.md");
  const uri = pathToFileURL(target).href;
  const lines = renderResourceWidget({
    resources: [
      resourceFixture({
        target,
        label: "docs/design notes/a very long context map.md",
      }),
    ],
    width: 28,
    expanded: false,
    activeTab: "file",
    theme,
  });
  const resourceLine = lines[3] ?? "";

  assert.ok(resourceLine.includes(`\x1b]8;;${uri}\x1b\\`));
  assert.ok(resourceLine.includes("\x1b]8;;\x1b\\"));
  assert.ok(visibleWidth(resourceLine) <= 28);
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
    activeTab: "file",
    theme,
  });

  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);

  const emptyTabLines = renderResourceWidget({
    resources: [resourceFixture({})],
    width: 12,
    expanded: false,
    activeTab: "review",
    theme,
  });
  for (const line of emptyTabLines) assert.ok(visibleWidth(line) <= 12, `${visibleWidth(line)} > 12`);
});

test("Chinese action labels use complete words", () => {
  process.env.PI_EXTENSIONS_LOCALE = "zh-CN";
  const lines = renderResourceWidget({
    resources: [resourceFixture({ actions: ["inspected", "referenced"] })],
    width: 80,
    expanded: false,
    activeTab: "file",
    theme,
  });

  assert.match(lines.join("\n"), /\[检查,引用\]/);
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

  const lines = renderResourceWidget({
    resources,
    width: 80,
    expanded: false,
    activeTab: "file",
    theme,
  });
  assert.equal(lines.length, COMPACT_RESOURCE_LIMIT + 6);
  assert.match(lines.find((line) => line.includes("2 more")) ?? "", /2 more not shown/);
  assert.match(lines.at(-1) ?? "", /Ctrl\+↑ to browse/);
});
