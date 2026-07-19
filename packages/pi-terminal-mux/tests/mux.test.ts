import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  shellEscape,
  isFishShell,
  exitStatusVar,
  isHeadlessSurface,
  createHeadlessSurface,
  isHeadlessMode,
  getMuxBackend,
  muxSetupHint,
  parseCmuxJson,
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
  predictZellijSplitDirection,
  canSplitZellijPane,
  selectZellijPlacement,
  selectZellijStackPlacement,
  getAgentPaneId,
  type ZellijPaneSnapshot,
} from "../src/index.ts";

/** 保存并清理会干扰探测的环境变量 */
const MUX_ENV_KEYS = [
  "MUXY_SOCKET_PATH",
  "CMUX_SOCKET_PATH",
  "TMUX",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "WEZTERM_UNIX_SOCKET",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "TERM_PROGRAM",
  "PI_TERMINAL_MUX",
  "PI_SUBAGENT_MUX",
  "PI_EXTENSIONS_LOCALE",
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of MUX_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MUX_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("shellEscape", () => {
  test("普通字符串加单引号", () => {
    assert.equal(shellEscape("abc"), "'abc'");
  });
  test("单引号转义", () => {
    assert.equal(shellEscape("a'b"), "'a'\\''b'");
  });
  test("空字符串", () => {
    assert.equal(shellEscape(""), "''");
  });
});

describe("shell 检测", () => {
  test("fish shell 用 $status", () => {
    const saved = process.env.SHELL;
    process.env.SHELL = "/opt/homebrew/bin/fish";
    assert.equal(isFishShell(), true);
    assert.equal(exitStatusVar(), "$status");
    process.env.SHELL = saved;
  });
  test("bash 用 $?", () => {
    const saved = process.env.SHELL;
    process.env.SHELL = "/bin/bash";
    assert.equal(isFishShell(), false);
    assert.equal(exitStatusVar(), "$?");
    process.env.SHELL = saved;
  });
});

describe("headless surface", () => {
  test("createHeadlessSurface 返回 headless: 前缀", () => {
    const surface = createHeadlessSurface("t");
    assert.ok(surface.startsWith("headless:"));
    assert.equal(isHeadlessSurface(surface), true);
  });
  test("干净环境下无可用后端", () => {
    assert.equal(getMuxBackend(), null);
    assert.equal(isHeadlessMode(), true);
  });
});

describe("后端偏好", () => {
  test("PI_TERMINAL_MUX 指定但运行环境不满足时返回 null", () => {
    process.env.PI_TERMINAL_MUX = "tmux";
    assert.equal(getMuxBackend(), null);
  });
  test("PI_SUBAGENT_MUX 作为兼容别名生效", () => {
    process.env.PI_SUBAGENT_MUX = "tmux";
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";
    // tmux 命令不一定存在，只验证偏好解析不抛错
    const backend = getMuxBackend();
    assert.ok(backend === null || backend === "tmux");
  });
});

describe("muxSetupHint i18n", () => {
  test("中文提示", () => {
    process.env.PI_EXTENSIONS_LOCALE = "zh-CN";
    process.env.PI_TERMINAL_MUX = "tmux";
    assert.match(muxSetupHint(), /请在 tmux 中启动 pi/);
  });
  test("英文提示", () => {
    process.env.PI_EXTENSIONS_LOCALE = "en-US";
    process.env.PI_TERMINAL_MUX = "tmux";
    assert.match(muxSetupHint(), /Start pi inside tmux/);
  });
  test("无偏好时返回通用提示", () => {
    process.env.PI_EXTENSIONS_LOCALE = "en-US";
    assert.match(muxSetupHint(), /WezTerm/);
  });
});

describe("cmux JSON 解析", () => {
  test("parseCmuxJson 容错", () => {
    assert.equal(parseCmuxJson("not json"), null);
    assert.deepEqual(parseCmuxJson('{"a":1}'), { a: 1 });
  });
  test("parseCmuxFocusedSnapshot", () => {
    assert.equal(parseCmuxFocusedSnapshot(null), null);
    assert.equal(parseCmuxFocusedSnapshot({}), null);
    assert.deepEqual(
      parseCmuxFocusedSnapshot({ focused: { surface_ref: "surface:1", pane_ref: "pane:2" } }),
      { surfaceRef: "surface:1", paneRef: "pane:2" },
    );
  });
  test("parseCmuxFocusedSnapshotFromJson", () => {
    assert.deepEqual(
      parseCmuxFocusedSnapshotFromJson('{"focused":{"surface_ref":"surface:9"}}'),
      { surfaceRef: "surface:9", paneRef: undefined },
    );
  });
  test("parseCmuxPaneRefForSurface 匹配 surface_ref", () => {
    assert.equal(
      parseCmuxPaneRefForSurface({ surface_ref: "surface:3", pane_ref: "pane:7" }, "surface:3"),
      "pane:7",
    );
    assert.equal(
      parseCmuxPaneRefForSurface({ surface_ref: "surface:3", pane_ref: "pane:7" }, "surface:4"),
      null,
    );
  });
  test("parseCmuxPaneRefForSurface 匹配 caller", () => {
    assert.equal(
      parseCmuxPaneRefForSurfaceFromJson(
        '{"caller":{"surface_ref":"surface:5","pane_ref":"pane:11"}}',
        "surface:5",
      ),
      "pane:11",
    );
  });
});

describe("zellij 放置规划", () => {
  const pane = (over: Partial<ZellijPaneSnapshot>): ZellijPaneSnapshot => ({
    id: 1,
    is_plugin: false,
    is_floating: false,
    is_selectable: true,
    exited: false,
    pane_rows: 24,
    pane_columns: 80,
    tab_id: 1,
    ...over,
  });

  test("宽 pane 预测向右分", () => {
    assert.equal(predictZellijSplitDirection(pane({ pane_columns: 100, pane_rows: 20 })), "right");
  });
  test("高 pane 预测向下分", () => {
    assert.equal(predictZellijSplitDirection(pane({ pane_columns: 20, pane_rows: 30 })), "down");
  });
  test("太小不可分", () => {
    assert.equal(predictZellijSplitDirection(pane({ pane_columns: 4, pane_rows: 4 })), null);
    assert.equal(canSplitZellijPane(pane({ pane_columns: 4, pane_rows: 4 })), false);
  });
  test("无其他 pane 时 stack 返回 null", () => {
    assert.equal(selectZellijStackPlacement([pane({ id: 1 })], 1), null);
  });
  test("有可分 pane 时选择 split", () => {
    const panes = [pane({ id: 1, pane_columns: 200, pane_rows: 50 })];
    const plan = selectZellijPlacement(panes, 1, 50, 10);
    assert.equal(plan?.mode, "split");
    if (plan?.mode === "split") {
      assert.equal(plan.splitDirection, "right");
      assert.equal(plan.anchorPaneId, 1);
    }
  });
  test("pane 太小不满足最小尺寸时退化为 stack", () => {
    // 两个 pane：zellij 自身最小尺寸可分，但分完小于 50x10，应选 stack 到面积最大的非 parent pane
    const panes = [
      pane({ id: 1, pane_columns: 40, pane_rows: 20 }),
      pane({ id: 2, pane_columns: 60, pane_rows: 15 }),
    ];
    const plan = selectZellijPlacement(panes, 1, 50, 10);
    assert.equal(plan?.mode, "stack");
    if (plan?.mode === "stack") {
      assert.equal(plan.anchorPaneId, 2);
    }
  });
  test("plugin/floating/exited pane 不参与", () => {
    const panes = [
      pane({ id: 1, pane_columns: 200, pane_rows: 50 }),
      pane({ id: 2, is_plugin: true, pane_columns: 200, pane_rows: 50 }),
    ];
    assert.equal(selectZellijStackPlacement(panes, 1), null);
  });
});

describe("getAgentPaneId", () => {
  test("无后端时返回 null", () => {
    assert.equal(getAgentPaneId(), null);
    assert.equal(getAgentPaneId(null), null);
  });
  test("tmux 后端读 TMUX_PANE", () => {
    const saved = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%42";
    assert.equal(getAgentPaneId("tmux"), "%42");
    if (saved === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = saved;
  });
});
