/**
 * backends/wezterm.ts — WezTerm 终端后端
 *
 * WezTerm 特定的 surface 操作：split-pane / send-text / get-text / kill-pane。
 */

import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { tailLines } from "../shell.ts";
import { createBackendLogger } from "./shared.ts";
import type { BackendOps } from "./types.ts";

const execFileAsync = promisify(execFile);

/** WezTerm 后端日志（统一格式，写入 /tmp/pi-mux-wezterm.log） */
const weztermLog = createBackendLogger("wezterm", "/tmp/pi-mux-wezterm.log");

/** WezTerm CLI 基础段 */
const CLI = "cli";
/** 激活 pane 的命令段 */
const ACTIVATE_PANE_CMD = "activate-pane";
const PANE_ID_FLAG = "--pane-id";

/**
 * 生成激活 WezTerm pane 的 CLI 参数数组。
 * 仅当 split 成功取得合法 pane id 后才调用（paneId 校验失败的场景不走到这里）。
 */
export function weztermActivateArgs(paneId: string): string[] {
  return [CLI, ACTIVATE_PANE_CMD, PANE_ID_FLAG, paneId];
}

/**
 * 返回命令提交终止符。Windows 的 ConPTY 中 LF 会让 PowerShell 停在续行提示，
 * 必须用 CR 提交；其他平台继续使用 LF（不用 CRLF，避免多余换行）。
 * platform 参数可注入以便单元测试，缺省按当前进程平台决策。
 */
export function commandTerminator(platform: string = process.platform): string {
  return platform === "win32" ? "\r" : "\n";
}

export const ops: BackendOps = {
  create(name: string): string {
    // WezTerm 的 createSurface 退化为 createSurfaceSplit "right"
    const fromSurface = process.env.WEZTERM_PANE;
    return ops.createSplit(name, "right", fromSurface);
  },

  // BackendOps 接口定义含 4 参（含可选 fromSurface / options），此为实现契约。
  // 该签名由统一 surface API 的向后兼容要求强制（fromSurface 保持第 3 位置参数，
  // activate 只能作为第 4 个尾部 options 追加），故按外部 API 签名豁免参数数量约束。
  createSplit(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    options?: { activate?: boolean },
  ): string {
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
    if (options?.activate) {
      execFileSync("wezterm", weztermActivateArgs(paneId), { encoding: "utf8" });
    }
    weztermLog(
      `[split] dir=${direction} from=${fromSurface ?? "<unset>"} new=${paneId} name=${JSON.stringify(name)}`,
    );
    return paneId;
  },

  send(surface: string, command: string): void {
    execFileSync(
      "wezterm",
      ["cli", "send-text", "--pane-id", surface, "--no-paste", command + commandTerminator()],
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
    weztermLog(`[close] surface=${surface}`);
  },

  rename(surface: string, name: string): void {
    execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", surface, name], {
      encoding: "utf8",
    });
  },
};
