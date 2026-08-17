import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  collectSessionResources,
  collectToolResources,
  ResourceIndex,
} from "../src/collector.ts";

const cwd = resolve("/workspace/project");

/** Finds one resource observation by its normalized kind. */
function findKind(resources: ReturnType<typeof collectToolResources>, kind: "file" | "review" | "web") {
  return resources.find((resource) => resource.kind === kind);
}

test("built-in file tools record normalized actions", () => {
  const readResources = collectToolResources({
    toolName: "read",
    input: { path: "src/index.ts" },
    cwd,
    timestamp: 10,
  });
  const editResources = collectToolResources({
    toolName: "edit",
    input: { path: "src/index.ts", edits: [] },
    cwd,
    timestamp: 20,
  });

  assert.deepEqual(findKind(readResources, "file"), {
    kind: "file",
    target: resolve(cwd, "src/index.ts"),
    label: "src/index.ts",
    action: "read",
    toolName: "read",
    timestamp: 10,
  });
  assert.equal(findKind(editResources, "file")?.action, "changed");
});

test("browser navigation records a web URL without exposing its query in the label", () => {
  const resources = collectToolResources({
    toolName: "mcp",
    input: {
      tool: "chrome-devtools_navigate_page",
      arguments: { url: "https://example.com/docs/start?token=secret" },
    },
    cwd,
    timestamp: 30,
  });
  const web = findKind(resources, "web");

  assert.equal(web?.action, "opened");
  assert.equal(web?.target, "https://example.com/docs/start?token=secret");
  assert.equal(web?.label, "example.com/docs/start");
});

test("structured URLs preserve spaces by percent-encoding the full value", () => {
  const resources = collectToolResources({
    toolName: "browser_navigate",
    input: { url: " https://example.com/docs/get started_(v2).?q=hello world " },
    cwd,
    timestamp: 32,
  });
  const web = findKind(resources, "web");

  assert.equal(web?.target, "https://example.com/docs/get%20started_(v2).?q=hello%20world");
  assert.equal(web?.label, "example.com/docs/get started_(v2).");
  assert.equal(resources.length, 1);
});

test("structured file paths with spaces stay intact", () => {
  const resources = collectToolResources({
    toolName: "read",
    input: { path: "docs/design notes/context map (final)" },
    cwd,
    timestamp: 33,
  });
  const file = findKind(resources, "file");

  assert.equal(file?.target, resolve(cwd, "docs/design notes/context map (final)"));
  assert.equal(file?.label, "docs/design notes/context map (final)");
  assert.equal(resources.length, 1);
});

test("plain-text URLs stop before adjacent whitespace and prose", () => {
  const resources = collectToolResources({
    toolName: "bash",
    input: { command: "open browser" },
    content: [
      {
        type: "text",
        text: "Opened <https://example.com/docs/get%20started?q=hello%20world>, then continued",
      },
    ],
    cwd,
    timestamp: 34,
  });

  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.target, "https://example.com/docs/get%20started?q=hello%20world");
});

test("loose URLs strip trailing CJK punctuation", () => {
  const resources = collectToolResources({
    toolName: "bash",
    input: { command: "open browser" },
    content: [
      {
        type: "text",
        text: "MR: https://example.com/erp/wms/-/merge_requests/4966；state: opened",
      },
    ],
    cwd,
    timestamp: 36,
  });

  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.target, "https://example.com/erp/wms/-/merge_requests/4966");
});

test("file content does not turn embedded URLs or paths into unrelated resources", () => {
  const resources = collectToolResources({
    toolName: "read",
    input: { path: "README.md" },
    content: [
      {
        type: "text",
        text: "See https://example.com/docs and /workspace/project/src/other.ts",
      },
    ],
    cwd,
    timestamp: 35,
  });

  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.kind, "file");
  assert.equal(resources[0]?.label, "README.md");
});

test("bash output does not collect every existing absolute path", () => {
  const resources = collectToolResources({
    toolName: "bash",
    input: { command: "printf done" },
    content: [{ type: "text", text: `Loaded ${import.meta.filename}` }],
    cwd,
    timestamp: 36,
  });

  assert.equal(resources.length, 0);
});

test("structured custom-tool URL fields are collected without scanning arbitrary text", () => {
  const resources = collectToolResources({
    toolName: "issue_lookup",
    input: { issue: 42, prompt: "Please visit this in a browser and create a pull request" },
    content: [{ type: "text", text: "Ignore https://noise.example.com" }],
    details: { web_url: "https://tracker.example.com/issues/42" },
    cwd,
    timestamp: 38,
  });

  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.target, "https://tracker.example.com/issues/42");
  assert.equal(resources[0]?.action, "referenced");
});

test("MR creation output is classified as a created review", () => {
  const resources = collectToolResources({
    toolName: "bash",
    input: { command: "gh pr create --fill" },
    content: [{ type: "text", text: "https://github.com/maplezzk/pi-extensions/pull/42" }],
    cwd,
    timestamp: 40,
  });
  const review = findKind(resources, "review");

  assert.equal(review?.action, "created");
  assert.equal(review?.label, "maplezzk/pi-extensions#42");
});

test("custom MR creation tool names are recognized across namespace separators", () => {
  const resources = collectToolResources({
    toolName: "mcp_gitlab_create_merge_request",
    input: { title: "Add session resources" },
    content: [{ type: "text", text: "https://example.com/group/project/-/merge_requests/77" }],
    cwd,
    timestamp: 45,
  });
  const review = findKind(resources, "review");

  assert.equal(review?.action, "created");
  assert.equal(review?.label, "group/project!77");
});

test("custom structured path fields are collected but arbitrary relative output is ignored", () => {
  const resources = collectToolResources({
    toolName: "artifact_preview",
    input: { outputPath: "artifacts/report.html" },
    content: [{ type: "text", text: "also mentioned notes/todo.md" }],
    cwd,
    timestamp: 50,
  });
  const files = resources.filter((resource) => resource.kind === "file");

  assert.equal(files.length, 1);
  assert.equal(files[0]?.target, resolve(cwd, "artifacts/report.html"));
  assert.equal(files[0]?.action, "read");
});

test("foreign Windows drive paths are not rewritten as local relative paths", () => {
  const resources = collectToolResources({
    toolName: "read",
    input: { path: "C:\\workspace\\project\\src\\index.ts" },
    cwd,
    timestamp: 55,
  });

  if (process.platform === "win32") {
    assert.equal(resources[0]?.kind, "file");
  } else {
    assert.equal(resources.length, 0);
  }
});

test("resource index merges actions and source tools by identity", () => {
  const index = new ResourceIndex();
  index.observe(
    collectToolResources({
      toolName: "read",
      input: { path: "src/index.ts" },
      cwd,
      timestamp: 60,
    }),
  );
  index.observe(
    collectToolResources({
      toolName: "write",
      input: { path: "src/index.ts", content: "updated" },
      cwd,
      timestamp: 70,
    }),
  );

  const [resource] = index.list();
  assert.deepEqual(resource?.actions, ["changed", "read"]);
  assert.deepEqual(resource?.tools, ["read", "write"]);
  assert.equal(resource?.seenCount, 2);
  assert.equal(resource?.lastSeenAt, 70);
});

test("session rebuild uses only successful tool results from the active branch", () => {
  const entries = [
    {
      type: "message",
      id: "assistant",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "ok", name: "read", arguments: { path: "README.md" } },
          { type: "toolCall", id: "failed", name: "write", arguments: { path: "failed.txt" } },
        ],
        timestamp: 80,
      },
    },
    {
      type: "message",
      id: "ok-result",
      parentId: "assistant",
      timestamp: new Date(1).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "ok",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 90,
      },
    },
    {
      type: "message",
      id: "failed-result",
      parentId: "ok-result",
      timestamp: new Date(2).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "failed",
        toolName: "write",
        content: [{ type: "text", text: "failed" }],
        isError: true,
        timestamp: 100,
      },
    },
  ] as unknown as SessionEntry[];

  const resources = collectSessionResources(entries, cwd);
  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.target, resolve(cwd, "README.md"));
  assert.deepEqual(resources[0]?.actions, ["read"]);
});
