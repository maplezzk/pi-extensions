import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, utimesSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBackendLogger, withFileLock, BfsSplitStateManager, hasCommand } from "../src/backends/shared.ts";

/** 每个测试用例的临时目录列表，afterEach 统一清理 */
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mux-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createBackendLogger", () => {
  // 验证日志格式：[ISO] [backend] msg
  test("writes timestamped message with backend tag to log file", () => {
    const logDir = makeTempDir();
    const logPath = join(logDir, "pi-mux-tmux.log");
    const log = createBackendLogger("tmux", logPath);

    log("split created");

    const content = readFileSync(logPath, "utf8");
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[tmux\] split created\n$/);
  });

  // 验证多次调用是追加而非覆盖
  test("appends multiple messages", () => {
    const logDir = makeTempDir();
    const logPath = join(logDir, "pi-mux-muxy.log");
    const log = createBackendLogger("muxy", logPath);

    log("first");
    log("second");

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /\[muxy\] first$/);
    assert.match(lines[1], /\[muxy\] second$/);
  });

  // 验证写失败时静默不抛
  test("does not throw when log path is not writable", () => {
    const logDir = makeTempDir();
    const logPath = join(logDir, "no-such-dir", "deep", "log.log");
    const log = createBackendLogger("herdr", logPath);

    log("this goes nowhere");
  });
});

describe("withFileLock", () => {
  // 验证锁内回调正常执行并返回结果
  test("executes callback and returns its result", () => {
    const lockDir = makeTempDir();
    const lockPath = join(lockDir, "test.lock");

    const result = withFileLock(lockPath, {}, () => "done");

    assert.equal(result, "done");
  });

  // 验证回调执行后锁文件被清理
  test("removes lock file after callback completes", () => {
    const lockDir = makeTempDir();
    const lockPath = join(lockDir, "test.lock");

    withFileLock(lockPath, {}, () => {});

    assert.equal(existsSync(lockPath), false);
  });

  // 验证回调抛错时锁仍然被释放
  test("removes lock file even when callback throws", () => {
    const lockDir = makeTempDir();
    const lockPath = join(lockDir, "test.lock");

    assert.throws(() => {
      withFileLock(lockPath, {}, () => {
        throw new Error("boom");
      });
    }, /boom/);

    assert.equal(existsSync(lockPath), false);
  });

  // 验证 stale 锁被自动清理：手动创建一个 mtime 很旧的锁目录
  test("acquires lock after stale lock expires", () => {
    const lockDir = makeTempDir();
    const lockPath = join(lockDir, "stale.lock");

    // 手动创建 stale 锁（mkdir 方式，与实现一致）
    mkdirSync(lockPath);
    // 将 mtime 回拨 60 秒（超过默认 staleMs=30000）
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    const result = withFileLock(lockPath, {}, () => "recovered");

    assert.equal(result, "recovered");
    assert.equal(existsSync(lockPath), false);
  });

  // 验证活跃锁未被 stale 清理：回调内嵌套尝试获取同名锁应超时
  test("does not acquire lock held by another active owner", () => {
    const lockDir = makeTempDir();
    const lockPath = join(lockDir, "active.lock");

    const result = withFileLock(lockPath, { timeoutMs: 200, retryMs: 10, staleMs: 30_000 }, () => {
      // 锁被当前回调持有，内部再获取应超时抛错
      assert.throws(() => {
        withFileLock(lockPath, { timeoutMs: 100, retryMs: 10, staleMs: 30_000 }, () => "inner");
      }, /lock/i);
      return "outer";
    });

    assert.equal(result, "outer");
  });
});

describe("BfsSplitStateManager", () => {
  // 初始状态：next() 返回 null（无 pane 可 split）
  test("returns null source from empty state", () => {
    const dir = makeTempDir();
    const manager = new BfsSplitStateManager(join(dir, "state.json"));

    assert.equal(manager.next(), null);
  });

  // 首次 add 后，next() 返回该 pane，方向为 down（首轮 right 已由调用方执行）
  test("after first add, next returns that pane with direction flip", () => {
    const dir = makeTempDir();
    const manager = new BfsSplitStateManager(join(dir, "state.json"));

    manager.add("pane-1");

    const next = manager.next();
    assert.deepEqual(next, { source: "pane-1", direction: "down" });
  });

  // 广度优先遍历：第一轮 right，第二轮 down，第三轮 right...
  test("breadth-first direction alternates per round", () => {
    const dir = makeTempDir();
    const manager = new BfsSplitStateManager(join(dir, "state.json"));

    // 模拟首次 split-right 后 add
    manager.add("p1"); // round 1 done, base=1, dir flips to down

    // round 2: split down from p1
    const r2 = manager.next();
    assert.deepEqual(r2, { source: "p1", direction: "down" });
    manager.advance(); // consume p1 for this round
    manager.add("p2"); // round 2 done, base=2 (p1,p2), dir flips to right

    // round 3: split right from p1, then p2
    const r3a = manager.next();
    assert.deepEqual(r3a, { source: "p1", direction: "right" });
    manager.advance();
    const r3b = manager.next();
    assert.deepEqual(r3b, { source: "p2", direction: "right" });
  });

  // remove 正确清理：移除 pane 后 pos 修正
  test("remove adjusts position when removing before cursor", () => {
    const dir = makeTempDir();
    const manager = new BfsSplitStateManager(join(dir, "state.json"));

    manager.add("p1");
    manager.advance(); // pos=1
    manager.add("p2"); // panes=[p1,p2], pos=1 (round complete triggers on next)

    manager.remove("p1");

    // p1 removed, p2 should still be accessible
    const panes = manager.panes();
    assert.deepEqual(panes, ["p2"]);
  });

  // 全部移除后 marker 文件被删除，next() 返回 null
  test("removes marker file when all panes removed", () => {
    const dir = makeTempDir();
    const markerPath = join(dir, "state.json");
    const manager = new BfsSplitStateManager(markerPath);

    manager.add("p1");
    assert.equal(existsSync(markerPath), true);

    manager.remove("p1");

    assert.equal(existsSync(markerPath), false);
    assert.equal(manager.next(), null);
  });

  // 状态持久化：新实例从 marker 文件恢复
  test("persists state across instances", () => {
    const dir = makeTempDir();
    const markerPath = join(dir, "state.json");

    const m1 = new BfsSplitStateManager(markerPath);
    m1.add("p1");
    m1.advance();
    m1.add("p2");

    // 新实例应恢复状态
    const m2 = new BfsSplitStateManager(markerPath);
    assert.deepEqual(m2.panes(), ["p1", "p2"]);
  });

  // 文件损坏时回退到初始状态
  test("recovers from corrupted marker file", () => {
    const dir = makeTempDir();
    const markerPath = join(dir, "state.json");
    writeFileSync(markerPath, "not json {{{");

    const manager = new BfsSplitStateManager(markerPath);

    assert.equal(manager.next(), null);
    assert.deepEqual(manager.panes(), []);
  });

  // remove 不存在的 pane 不改变状态
  test("remove of unknown pane is a no-op", () => {
    const dir = makeTempDir();
    const manager = new BfsSplitStateManager(join(dir, "state.json"));

    manager.add("p1");
    manager.remove("nonexistent");

    assert.deepEqual(manager.panes(), ["p1"]);
  });
});

describe("hasCommand", () => {
  // 真实存在的命令（node 必然在 PATH）
  test("returns true for an existing command", () => {
    assert.equal(hasCommand("node"), true);
  });

  // 不存在的命令
  test("returns false for a missing command", () => {
    assert.equal(hasCommand("definitely-not-a-real-cmd-xyz-123"), false);
  });

  // 缓存：重复调用同一命令返回一致结果
  test("returns consistent result on repeated calls", () => {
    const first = hasCommand("node");
    const second = hasCommand("node");
    assert.equal(first, second);
  });
});
