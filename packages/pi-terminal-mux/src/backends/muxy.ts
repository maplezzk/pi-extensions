/**
 * backends/muxy.ts — Muxy 终端后端
 *
 * 包含 Muxy 特定的 surface 创建（广度优先分屏）、命令发送、屏幕读写、
 * 关闭与重命名。BFS 分屏状态通过 /tmp/muxy-subagent-pane-* marker 文件持久化。
 */

import { execFileSync, execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { muxLog, AGENT_MUXY_PANE_ID } from "../detection.ts";
import type { BackendOps } from "./types.ts";

const execFileAsync = promisify(execFile);

// ── 内部辅助 ──

/** Muxy 分屏锁重试次数上限 */
const MUXY_LOCK_RETRY_COUNT = 60;
/** Muxy 分屏锁重试间隔（秒） */
const MUXY_LOCK_RETRY_INTERVAL_S = 0.05;

/**
 * 重命名 Muxy pane（best-effort，失败静默忽略）。
 */
function renameMuxySurface(surface: string, name: string): void {
  try {
    execFileSync("muxy", ["rename-pane", "--pane", surface, name], { encoding: "utf8" });
  } catch {}
}

// ── BFS 分屏状态管理 ──

/** Muxy BFS 分屏持久化状态 */
interface MuxySplitState {
  panes: string[];
  pos: number;
  base: number;
  dir: "right" | "down";
}

/**
 * 返回 Muxy BFS 分屏状态 marker 文件路径。
 * marker 文件记录当前所有 subagent pane ID 及分屏游标。
 */
function muxyMarkerPath(): string {
  return `/tmp/muxy-subagent-pane-${AGENT_MUXY_PANE_ID || "default"}`;
}

/**
 * 从 marker 文件读取 BFS 分屏状态，文件不存在时返回空状态。
 */
function readMuxyState(markerFile: string): MuxySplitState {
  try {
    return JSON.parse(readFileSync(markerFile, "utf8"));
  } catch {
    return { panes: [], pos: 0, base: 0, dir: "right" };
  }
}

/**
 * 将 BFS 分屏状态写回 marker 文件。
 */
function writeMuxyState(markerFile: string, state: MuxySplitState): void {
  writeFileSync(markerFile, JSON.stringify(state));
}

/**
 * 通过创建 lock 文件尝试获取 Muxy 分屏全局锁。
 * 最多重试 MUXY_LOCK_RETRY_COUNT 次，每次间隔 MUXY_LOCK_RETRY_INTERVAL_S 秒。
 * 返回 true 表示获取成功，false 表示超时。
 */
function acquireMuxyLock(lockFile: string): boolean {
  for (let i = 0; i < MUXY_LOCK_RETRY_COUNT; i++) {
    if (!existsSync(lockFile)) {
      try {
        writeFileSync(lockFile, `${process.pid}`, { flag: "wx" });
        return true;
      } catch {
        // 竞争失败，继续等待
      }
    }
    spawnSync("sleep", [String(MUXY_LOCK_RETRY_INTERVAL_S)]);
  }
  return false;
}

// ── BackendOps ──

export const ops: BackendOps = {
  create(name: string): string {
    const markerFile = muxyMarkerPath();
    const lockFile = `${markerFile}.lock`;

    const acquired = acquireMuxyLock(lockFile);
    if (!acquired) return "";

    try {
      const state = readMuxyState(markerFile);

      // 首次：split-right from parent
      if (state.panes.length === 0) {
        if (!AGENT_MUXY_PANE_ID) {
          throw new Error(
            "MUXY_PANE_ID not set; cannot determine parent pane for first subagent split. " +
            "Start pi inside Muxy so MUXY_PANE_ID is injected at launch.",
          );
        }
        const args = ["split-right", "--from", AGENT_MUXY_PANE_ID];
        muxLog(
          `[muxy split] mode=first dir=right from=AGENT_MUXY_PANE_ID=${AGENT_MUXY_PANE_ID} new=<pending> name=${JSON.stringify(name)}\n`,
        );
        const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();
        if (output) {
          state.panes = [output];
          state.pos = 0;
          state.base = 1;
          state.dir = "down";
          writeMuxyState(markerFile, state);
          renameMuxySurface(output, name);
          muxLog(
            `[muxy split] mode=first dir=right from=AGENT_MUXY_PANE_ID=${AGENT_MUXY_PANE_ID} new=${output} name=${JSON.stringify(name)}\n`,
          );
        }
        return output;
      }

      // 本轮结束？翻转方向
      if (state.pos >= state.base) {
        state.pos = 0;
        state.base = state.panes.length;
        state.dir = state.dir === "right" ? "down" : "right";
      }

      const targetPane = state.panes[state.pos];
      const muxyDir = state.dir === "right" ? "split-right" : "split-down";
      const args = [muxyDir];
      if (targetPane) args.push("--from", targetPane);

      muxLog(
        `[muxy split] mode=next pos=${state.pos} base=${state.base} dir=${state.dir} from=state.panes[${state.pos}]=${targetPane} new=<pending> name=${JSON.stringify(name)}\n`,
      );
      const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();

      if (output) {
        state.panes.push(output);
        state.pos++;
        writeMuxyState(markerFile, state);
        renameMuxySurface(output, name);
        muxLog(
          `[muxy split] mode=next pos=${state.pos - 1} base=${state.base} dir=${state.dir} from=state.panes[${state.pos - 1}]=${targetPane} new=${output} name=${JSON.stringify(name)}\n`,
        );
      }

      return output;
    } finally {
      try { rmSync(lockFile); } catch {}
    }
  },

  createSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
    const dir = direction === "down" || direction === "up" ? "down" : "right";
    const sourcePane = fromSurface ?? AGENT_MUXY_PANE_ID;
    const sourceOrigin = fromSurface
      ? `fromSurface=${fromSurface}`
      : `AGENT_MUXY_PANE_ID=${AGENT_MUXY_PANE_ID ?? "<unset>"}`;
    if (!sourcePane) {
      throw new Error(
        "MUXY_PANE_ID not set and no fromSurface provided; cannot determine source pane for split. " +
        "Start pi inside Muxy so MUXY_PANE_ID is injected at launch.",
      );
    }
    const args = [`split-${dir}`, "--from", sourcePane];
    muxLog(
      `[muxy split] mode=createSurfaceSplit dir=${dir} from=${sourcePane} (${sourceOrigin}) new=<pending> name=${JSON.stringify(name)}\n`,
    );
    const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();
    if (output) {
      renameMuxySurface(output, name);
      muxLog(
        `[muxy split] mode=createSurfaceSplit dir=${dir} from=${sourcePane} (${sourceOrigin}) new=${output} name=${JSON.stringify(name)}\n`,
      );
    }
    return output;
  },

  send(surface: string, command: string): void {
    execFileSync("muxy", ["send", "--pane", surface, command], { encoding: "utf8" });
    execFileSync("muxy", ["send-keys", "--pane", surface, "Enter"], { encoding: "utf8" });
  },

  sendEscape(surface: string): void {
    // Use send (raw bytes) instead of send-keys Escape — send-keys may not
    // correctly translate the "Escape" key name to an actual ESC at the PTY level.
    execFileSync("muxy", ["send", "--pane", surface, "\u001b"], { encoding: "utf8" });
  },

  read(surface: string, lines = 50): string {
    return execFileSync("muxy", ["read-screen", "--pane", surface, "--lines", String(lines)], {
      encoding: "utf8",
    });
  },

  async readAsync(surface: string, lines = 50): Promise<string> {
    const { stdout } = await execFileAsync(
      "muxy",
      ["read-screen", "--pane", surface, "--lines", String(lines)],
      { encoding: "utf8" },
    );
    return stdout;
  },

  close(surface: string): void {
    execFileSync("muxy", ["close-pane", "--pane", surface], { encoding: "utf8" });
    // 从 state.panes 移除已关闭的 subagent，避免僵尸 ID 累积
    const markerFile = muxyMarkerPath();
    try {
      const parsed = JSON.parse(readFileSync(markerFile, "utf8"));
      if (parsed && Array.isArray(parsed.panes)) {
        const idx = parsed.panes.indexOf(surface);
        if (idx >= 0) {
          const beforePanes = [...parsed.panes];
          const beforePos = parsed.pos;
          parsed.panes.splice(idx, 1);
          if (typeof parsed.pos === "number" && idx < parsed.pos) {
            parsed.pos = Math.max(0, parsed.pos - 1);
          }
          if (parsed.panes.length === 0) {
            rmSync(markerFile);
            muxLog(
              `[muxy close] pane=${surface} panes=${JSON.stringify(beforePanes)} -> [] pos=${beforePos} -> <marker-removed>\n`,
            );
          } else {
            writeFileSync(markerFile, JSON.stringify(parsed));
            muxLog(
              `[muxy close] pane=${surface} panes=${JSON.stringify(beforePanes)} -> ${JSON.stringify(parsed.panes)} pos=${beforePos} -> ${parsed.pos}\n`,
            );
          }
        } else {
          muxLog(
            `[muxy close] pane=${surface} (not in marker state.panes, marker unchanged)\n`,
          );
        }
      }
    } catch (e) {
      muxLog(
        `[muxy close] pane=${surface} (no marker found or parse error, nothing to clean)\n`,
      );
    }
  },

  rename(surface: string, name: string): void {
    renameMuxySurface(surface, name);
  },
};

/**
 * 获取 Muxy BFS 分屏状态中当前要 split 的目标 pane（用于 surface.ts 设置 lastSplitSource）。
 * 首次调用返回 AGENT_MUXY_PANE_ID，后续返回 state.panes[pos] 或 null。
 */
export function getMuxySplitSource(): string | null {
  const markerFile = muxyMarkerPath();
  const state = readMuxyState(markerFile);
  if (state.panes.length === 0) return AGENT_MUXY_PANE_ID ?? null;
  return state.panes[state.pos] ?? null;
}
