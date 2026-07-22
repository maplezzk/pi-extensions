/**
 * backends/shared.ts — 后端共享基础设施
 *
 * 统一日志、文件锁、BFS 分屏状态机，消除各后端的重复实现。
 */

import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";

/**
 * 创建后端专属 logger。
 *
 * 日志写入 logPath（调用方传入），格式：`[ISO timestamp] [backend] msg\n`。
 * 写失败静默忽略，不影响主流程。
 */
export function createBackendLogger(backend: string, logPath: string): (msg: string) => void {
  return (msg: string): void => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] [${backend}] ${msg}\n`);
    } catch {
      // 写日志失败不影响主流程
    }
  };
}

// ── 文件锁 ──

export interface FileLockOptions {
  /** 获取锁的最大等待时间（毫秒），默认 10000 */
  timeoutMs?: number;
  /** 重试间隔（毫秒），默认 50 */
  retryMs?: number;
  /** 锁文件超过此时间视为 stale 并强制清理（毫秒），默认 30000 */
  staleMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_STALE_MS = 30_000;

/** 同步休眠（不阻塞事件循环外的线程，但阻塞当前线程） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 基于 mkdir 原子性的文件锁。
 *
 * - 用 `mkdirSync(lockPath)` 获取锁（目录创建是原子操作）
 * - 锁目录内写入 owner 文件记录 PID
 * - 支持 stale 检测：锁目录 mtime 超过 staleMs 时强制清理
 * - 回调执行完毕（无论成功或抛错）后在 finally 中释放锁
 */
export function withFileLock<T>(lockPath: string, opts: FileLockOptions, fn: () => T): T {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      // stale 检测
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // statSync 失败（锁刚好被释放），重试
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      sleepSync(retryMs);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

// ── BFS 分屏状态机 ──

/** BFS 分屏持久化状态 */
interface BfsSplitState {
  panes: string[];
  pos: number;
  base: number;
  dir: "right" | "down";
}

/** next() 返回值：下一个要 split 的源 pane 及方向 */
export interface BfsNext {
  source: string;
  direction: "right" | "down";
}

/**
 * 广度优先分屏状态机，跨进程通过 marker 文件持久化。
 *
 * 分屏策略（与 muxy/herdr/otty 原有逻辑一致）：
 *   第 1 轮：调用方在外部执行首次 split-right，然后 add(pane)
 *   第 2 轮：从 p1 向下分
 *   第 3 轮：从 p1、p2 分别向右分
 *   第 4 轮：从 p1、p2、p3、p4 分别向下分
 *   ……每轮结束翻转方向
 *
 * 用法：
 *   const mgr = new BfsSplitStateManager(markerPath);
 *   const next = mgr.next();       // 窥视下一个 split 源
 *   // ... 执行 split ...
 *   mgr.advance();                 // 消费当前 pos
 *   mgr.add(newPaneId);            // 登记新 pane
 */
export class BfsSplitStateManager {
  private readonly markerPath: string;
  private state: BfsSplitState;

  constructor(markerPath: string) {
    this.markerPath = markerPath;
    this.state = this.readState();
  }

  /** 从 marker 文件读取状态，文件不存在或损坏时返回初始状态 */
  private readState(): BfsSplitState {
    try {
      return JSON.parse(readFileSync(this.markerPath, "utf8")) as BfsSplitState;
    } catch {
      return { panes: [], pos: 0, base: 0, dir: "right" };
    }
  }

  /** 将当前状态写回 marker 文件 */
  private writeState(): void {
    writeFileSync(this.markerPath, JSON.stringify(this.state));
  }

  /** 窥视下一个 split 源和方向，不消费。无 pane 时返回 null */
  next(): BfsNext | null {
    if (this.state.panes.length === 0) return null;

    let { pos, base, dir } = this.state;
    // 本轮结束？翻转方向（窥视，不写入）
    if (pos >= base) {
      pos = 0;
      base = this.state.panes.length;
      dir = dir === "right" ? "down" : "right";
    }

    const source = this.state.panes[pos];
    if (!source) return null;
    return { source, direction: dir };
  }

  /** 消费当前 pos（调用方完成一次 split 后调用） */
  advance(): void {
    this.state.pos++;
    this.writeState();
  }

  /** 登记新创建的 pane，必要时触发轮次翻转 */
  add(pane: string): void {
    this.state.panes.push(pane);

    // 本轮结束？翻转方向
    if (this.state.pos >= this.state.base) {
      this.state.pos = 0;
      this.state.base = this.state.panes.length;
      this.state.dir = this.state.dir === "right" ? "down" : "right";
    }

    this.writeState();
  }

  /** 移除已关闭的 pane，修正 pos；全空时删除 marker 文件 */
  remove(pane: string): void {
    const idx = this.state.panes.indexOf(pane);
    if (idx < 0) return;

    this.state.panes.splice(idx, 1);
    if (idx < this.state.pos) {
      this.state.pos = Math.max(0, this.state.pos - 1);
    }

    if (this.state.panes.length === 0) {
      try { rmSync(this.markerPath); } catch { /* 文件不存在也没关系 */ }
      this.state = { panes: [], pos: 0, base: 0, dir: "right" };
    } else {
      this.writeState();
    }
  }

  /** 返回当前所有 pane ID（副本） */
  panes(): string[] {
    return [...this.state.panes];
  }
}

// ── 命令可用性检测 ──

const commandAvailability = new Map<string, boolean>();

/**
 * 检测某命令是否在 PATH 中可用（带缓存）。
 *
 * 跨平台：Windows 用 where.exe，其他平台用 `command -v`。
 * 各后端共用此实现，避免每个后端重复写 hasCommand。
 */
export function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}
