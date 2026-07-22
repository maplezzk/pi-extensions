/**
 * backends/muxy.ts — Muxy 终端后端
 *
 * 包含 Muxy 特定的 surface 创建（广度优先分屏）、命令发送、屏幕读写、
 * 关闭与重命名。BFS 分屏状态与文件锁使用 shared.ts 的统一实现。
 */

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_MUXY_PANE_ID } from "../detection.ts";
import { createBackendLogger, withFileLock, BfsSplitStateManager } from "./shared.ts";
import type { BackendOps } from "./types.ts";

const execFileAsync = promisify(execFile);

// ── 日志 ──

const log = createBackendLogger("muxy", "/tmp/pi-mux-muxy.log");

// ── 内部辅助 ──

/**
 * 重命名 Muxy pane（best-effort，失败静默忽略）。
 */
function renameMuxySurface(surface: string, name: string): void {
  try {
    execFileSync("muxy", ["rename-pane", "--pane", surface, name], { encoding: "utf8" });
  } catch {}
}

/**
 * 返回 Muxy BFS 分屏状态 marker 文件路径。
 * marker 文件记录当前所有 subagent pane ID 及分屏游标。
 */
function muxyMarkerPath(): string {
  return `/tmp/muxy-subagent-pane-${AGENT_MUXY_PANE_ID || "default"}`;
}

// ── BackendOps ──

export const ops: BackendOps = {
  create(name: string): string {
    const markerFile = muxyMarkerPath();
    const lockPath = `${markerFile}.lock`;

    return withFileLock(lockPath, {}, () => {
      const state = new BfsSplitStateManager(markerFile);

      // 首次：split-right from parent
      if (state.panes().length === 0) {
        if (!AGENT_MUXY_PANE_ID) {
          throw new Error(
            "MUXY_PANE_ID not set; cannot determine parent pane for first subagent split. " +
            "Start pi inside Muxy so MUXY_PANE_ID is injected at launch.",
          );
        }
        const args = ["split-right", "--from", AGENT_MUXY_PANE_ID];
        log(
          `[split] mode=first dir=right from=AGENT_MUXY_PANE_ID=${AGENT_MUXY_PANE_ID} new=<pending> name=${JSON.stringify(name)}`,
        );
        const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();
        if (output) {
          state.add(output);
          renameMuxySurface(output, name);
          log(
            `[split] mode=first dir=right from=AGENT_MUXY_PANE_ID=${AGENT_MUXY_PANE_ID} new=${output} name=${JSON.stringify(name)}`,
          );
        }
        return output;
      }

      // 后续：BFS 分屏
      const next = state.next();
      if (!next) return "";

      const { source, direction } = next;
      const muxyDir = direction === "right" ? "split-right" : "split-down";
      const args = [muxyDir];
      if (source) args.push("--from", source);

      log(
        `[split] mode=next dir=${direction} from=${source} new=<pending> name=${JSON.stringify(name)}`,
      );
      const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();

      if (output) {
        state.advance();
        state.add(output);
        renameMuxySurface(output, name);
        log(
          `[split] mode=next dir=${direction} from=${source} new=${output} name=${JSON.stringify(name)}`,
        );
      }

      return output;
    });
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
    log(
      `[split] mode=createSurfaceSplit dir=${dir} from=${sourcePane} (${sourceOrigin}) new=<pending> name=${JSON.stringify(name)}`,
    );
    const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();
    if (output) {
      renameMuxySurface(output, name);
      log(
        `[split] mode=createSurfaceSplit dir=${dir} from=${sourcePane} (${sourceOrigin}) new=${output} name=${JSON.stringify(name)}`,
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
    // 从 BFS 状态移除已关闭的 subagent，避免僵尸 ID 累积
    const state = new BfsSplitStateManager(muxyMarkerPath());
    const beforePanes = state.panes();
    state.remove(surface);
    const afterPanes = state.panes();
    if (beforePanes.length !== afterPanes.length) {
      log(
        `[close] pane=${surface} panes=${JSON.stringify(beforePanes)} -> ${JSON.stringify(afterPanes)}`,
      );
    } else {
      log(`[close] pane=${surface} (not in marker state.panes, marker unchanged)`);
    }
  },

  rename(surface: string, name: string): void {
    renameMuxySurface(surface, name);
  },
};

/**
 * 获取 Muxy BFS 分屏状态中当前要 split 的目标 pane（用于 surface.ts 设置 lastSplitSource）。
 * 首次调用返回 AGENT_MUXY_PANE_ID，后续返回 next().source 或 null。
 */
export function getMuxySplitSource(): string | null {
  const state = new BfsSplitStateManager(muxyMarkerPath());
  if (state.panes().length === 0) return AGENT_MUXY_PANE_ID ?? null;
  return state.next()?.source ?? null;
}
