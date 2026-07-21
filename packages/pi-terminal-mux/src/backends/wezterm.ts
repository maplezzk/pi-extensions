/**
 * backends/wezterm.ts — WezTerm 终端后端
 *
 * WezTerm 特定的 surface 操作：split-pane / send-text / get-text / kill-pane。
 */

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { tailLines } from "../shell.ts";
import type { BackendOps } from "./types.ts";

const execFileAsync = promisify(execFile);

export const ops: BackendOps = {
  create(name: string): string {
    // WezTerm 的 createSurface 退化为 createSurfaceSplit "right"
    const fromSurface = process.env.WEZTERM_PANE;
    return ops.createSplit(name, "right", fromSurface);
  },

  // BackendOps 接口定义含 4 参（含可选 fromSurface），此为实现契约。
  createSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
    const args = ["cli", "split-pane"];
    if (direction === "left") args.push("--left");
    else if (direction === "right") args.push("--right");
    else if (direction === "up") args.push("--top");
    else args.push("--bottom");
    args.push("--cwd", process.cwd());
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const rawId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
    if (!rawId || !/^\d+$/.test(rawId)) {
      throw new Error(`Unexpected wezterm split-pane output: ${rawId || "(empty)"}`);
    }
    const paneId = rawId;
    try {
      execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
        encoding: "utf8",
      });
    } catch {
      // Optional — tab title is cosmetic.
    }
    return paneId;
  },

  send(surface: string, command: string): void {
    execFileSync(
      "wezterm",
      ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"],
      { encoding: "utf8" },
    );
  },

  sendEscape(surface: string): void {
    execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", "\u001b"], {
      encoding: "utf8",
    });
  },

  read(surface: string, lines = 50): string {
    const raw = execFileSync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(raw, lines);
  },

  async readAsync(surface: string, lines = 50): Promise<string> {
    const { stdout } = await execFileAsync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(stdout, lines);
  },

  close(surface: string): void {
    execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
      encoding: "utf8",
    });
  },

  rename(surface: string, name: string): void {
    execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", surface, name], {
      encoding: "utf8",
    });
  },
};
