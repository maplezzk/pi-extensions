import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { ResourceBrowser } from "../src/browser.ts";
import type { SessionResource } from "../src/collector.ts";
import type { ResourceTab } from "../src/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Creates one stable resource fixture for browser interaction tests. */
function resourceFixture(kind: SessionResource["kind"], label: string): SessionResource {
  const target = kind === "file" ? resolve("/workspace/project", label) : `https://example.com/${label}`;
  return {
    key: `${kind}:${target}`,
    kind,
    target,
    label,
    actions: [kind === "file" ? "read" : "opened"],
    tools: [kind === "file" ? "read" : "browser_navigate"],
    firstSeenAt: 1,
    lastSeenAt: 1,
    seenCount: 1,
  };
}

test("resource browser switches tabs, follows Ctrl+O, and returns with Down", () => {
  process.env.PI_EXTENSIONS_LOCALE = "en-US";
  let expanded = false;
  let activeTab: ResourceTab = "file";
  let renderRequests = 0;
  let closed = false;

  const keybindings = {
    /** Matches only the semantic actions exercised by this focused browser. */
    matches(data: string, action: string): boolean {
      if (action === "app.tools.expand") return data === "\x0f";
      if (action === "tui.select.cancel") return data === "\x1b";
      if (action === "tui.select.down") return data === "\x1b[B";
      return false;
    },
  } as Pick<KeybindingsManager, "matches">;

  /** Reads the simulated Pi expansion state. */
  function getExpanded(): boolean {
    return expanded;
  }

  /** Updates the simulated Pi expansion state. */
  function setExpanded(value: boolean): void {
    expanded = value;
  }

  /** Records the browser's selected tab. */
  function onTabChange(tab: ResourceTab): void {
    activeTab = tab;
  }

  /** Records that focus should return to the editor. */
  function onClose(): void {
    closed = true;
  }

  /** Counts repaint requests after interaction. */
  function requestRender(): void {
    renderRequests += 1;
  }

  const browser = new ResourceBrowser({
    resources: [
      resourceFixture("file", "src/index.ts"),
      resourceFixture("review", "owner/repo/pull/93"),
      resourceFixture("web", "docs/getting-started"),
    ],
    activeTab,
    theme,
    keybindings,
    getExpanded,
    setExpanded,
    onTabChange,
    onClose,
    requestRender,
  });

  assert.match(browser.render(80).join("\n"), /src\/index\.ts/);
  browser.handleInput("\x1b[C");
  assert.equal(activeTab, "review");
  assert.match(browser.render(80).join("\n"), /owner\/repo\/pull\/93/);
  assert.doesNotMatch(browser.render(80).join("\n"), /src\/index\.ts/);

  browser.handleInput("\x0f");
  assert.equal(expanded, true);
  browser.handleInput("\x1b[B");
  assert.equal(closed, true);
  assert.equal(renderRequests, 2);
});
