/**
 * backends/tmux.ts — Tmux 终端后端
 *
 * Tmux 特定的 surface 操作：split-window / send-keys / capture-pane / kill-pane。
 * Tmux 没有 pane 级命名，rename 退化为 window 命名。
 */

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBackendLogger } from "./shared.ts";
import type { BackendOps } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Tmux 后端日志（统一格式，写入 /tmp/pi-mux-tmux.log） */
const tmuxLog = createBackendLogger("tmux", "/tmp/pi-mux-tmux.log");

export const ops: BackendOps = {
  create(_name: string): string {
    // Tmux 的 createSurface 退化为 createSurfaceSplit "right"
    // 此方法由 surface.ts 的 createSurface 调度，不会直接传入空参的 create。
    // 直接调用 split-window 作为 fallback。
    const fromSurface = process.env.TMUX_PANE;
    return ops.createSplit(_name, "right", fromSurface);
  },

  createSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
    const args = ["split-window", "-d"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (fromSurface) {
      args.push("-t", fromSurface);
    }
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    tmuxLog(
      `[split] dir=${direction} from=${fromSurface ?? "<unset>"} new=${pane} name=${JSON.stringify(name)}`,
    );
    return pane;
  },

  send(surface: string, command: string): void {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
  },

  sendEscape(surface: string): void {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
  },

  read(surface: string, lines = 50): string {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
  },

  async readAsync(surface: string, lines = 50): Promise<string> {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  },

  close(surface: string): void {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    tmuxLog(`[close] surface=${surface}`);
  },

  rename(surface: string, name: string): void {
    // tmux 没有 pane 级命名，退化为所在 window 命名
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, name], { encoding: "utf8" });
  },
};
