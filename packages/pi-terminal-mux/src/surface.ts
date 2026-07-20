/**
 * surface.ts — 统一 surface API（跨后端一致语义）
 *
 * 持有 Record<MuxBackend, BackendOps> 全键注册表，
 * createSurface / sendCommand / readScreen 等统一 API 通过查表派发到对应后端。
 *
 * 非对称操作（renameCurrentTab / renameWorkspace / sendLongCommand / pollForExit）
 * 按现状直接调用各 backend 公开函数，不进 BackendOps。
 */

import { execSync, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  getMuxBackend,
  isMuxAvailable,
  muxLog,
  muxSetupHint,
  AGENT_MUXY_PANE_ID,
} from "./detection.ts";
import { i18n } from "./i18n.ts";
import {
  isHeadlessSurface,
  isHeadlessMode,
  createHeadlessSurface,
  closeHeadlessSurface,
  sendHeadlessEscape,
  readHeadlessScreen,
  readHeadlessScreenAsync,
  spawnHeadlessProcess,
  getHeadlessProcessExit,
  drainHeadlessProcess,
} from "./headless.ts";
import { shellEscape } from "./shell.ts";
import type { MuxBackend } from "./detection.ts";
import type { BackendOps } from "./backends/types.ts";

import { ops as muxyOps } from "./backends/muxy.ts";
import { ops as cmuxOps } from "./backends/cmux.ts";
import { ops as tmuxOps } from "./backends/tmux.ts";
import { ops as zellijOps } from "./backends/zellij.ts";
import { ops as weztermOps } from "./backends/wezterm.ts";
import { ops as herdrOps, AGENT_HERDR_PANE_ID, renameHerdrTab, renameHerdrWorkspace } from "./backends/herdr.ts";
import { ops as ottyOps, AGENT_OTTY_PANE_ID } from "./backends/otty.ts";

// 各后端直接引用的公开函数（非对称操作不进 BackendOps）
import { renameHerdrPane, renameHerdrAgent, sendHerdrCommand, sendHerdrEscape, readHerdrScreen, closeHerdrSurface } from "./backends/herdr.ts";
import { sendOttyCommand, sendOttyEscape, readOttyScreen, closeOttySurface, renameOttyTab } from "./backends/otty.ts";

const execFileAsync = promisify(execFile);

// ── 全键注册表 ──

/** 全键注册表：TS 编译期强制所有 MuxBackend 值都有对应的 BackendOps */
const backendOps: Record<MuxBackend, BackendOps> = {
  muxy: muxyOps,
  cmux: cmuxOps,
  tmux: tmuxOps,
  zellij: zellijOps,
  wezterm: weztermOps,
  herdr: herdrOps,
  otty: ottyOps,
};

// ── 内部辅助 ──

/** 获取当前后端，无后端时抛错 */
function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`${i18n.t("setupHint.none")} ${muxSetupHint()}`);
  }
  return backend;
}

// ── lastSplitSource 状态 ──

/**
 * 最近一次 createSurface / createSurfaceSplit 的来源 pane。
 * 用于在 pi TUI 中展示「新分屏来自哪个 pane」。
 * 每次调用 createSurface 时更新，调用方读取后可重置。
 */
let lastSplitSource: string | null = null;

export function getLastSplitSource(): string | null {
  return lastSplitSource;
}

export function clearLastSplitSource(): void {
  lastSplitSource = null;
}

// ── 统一 surface API ──

/**
 * 创建新 terminal surface（智能放置：分屏/堆叠/新 tab，按后端策略）。
 * 无后端时降级为 headless。
 */
export function createSurface(name: string): string {
  if (!isMuxAvailable()) {
    return createHeadlessSurface(name);
  }

  const backend = getMuxBackend()!;

  if (backend === "cmux") {
    // cmux 的 create 内部处理子 agent pane 复用，这里设置 lastSplitSource
    lastSplitSource = process.env.CMUX_SURFACE_ID ?? null;
  } else if (backend === "muxy") {
    // muxy 的 split source 由 BFS 状态决定，先设置为当前 AGENT_MUXY_PANE_ID
    lastSplitSource = AGENT_MUXY_PANE_ID ?? null;
  } else if (backend === "otty") {
    lastSplitSource = AGENT_OTTY_PANE_ID ?? null;
  } else {
    // tmux / wezterm / zellij / herdr
    lastSplitSource = process.env.TMUX_PANE ?? null;
  }

  return backendOps[backend].create(name);
}

/**
 * 指定方向分屏创建新 surface。
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "muxy") {
    const dir = direction === "down" || direction === "up" ? "down" : "right";
    const sourcePane = fromSurface ?? AGENT_MUXY_PANE_ID;
    if (!sourcePane) {
      throw new Error(
        "MUXY_PANE_ID not set and no fromSurface provided; cannot determine source pane for split. " +
        "Start pi inside Muxy so MUXY_PANE_ID is injected at launch.",
      );
    }
    lastSplitSource = sourcePane;
  } else if (backend === "cmux") {
    lastSplitSource = fromSurface ?? process.env.CMUX_SURFACE_ID ?? null;
  } else if (backend === "herdr") {
    const sourcePane = fromSurface ?? AGENT_HERDR_PANE_ID;
    if (!sourcePane) {
      throw new Error(
        "HERDR_PANE_ID not set and no fromSurface provided; cannot determine source pane for split. " +
          "Start pi inside herdr so HERDR_PANE_ID is injected at launch.",
      );
    }
    lastSplitSource = sourcePane;
  } else if (backend === "otty") {
    lastSplitSource = fromSurface ?? AGENT_OTTY_PANE_ID ?? null;
  } else {
    // tmux / wezterm / zellij
    const source = backend === "tmux" ? process.env.TMUX_PANE : fromSurface;
    lastSplitSource = source ?? null;
  }

  return backendOps[backend].createSplit(name, direction, fromSurface);
}

/**
 * 向 surface 发送命令字符串并执行。
 */
export function sendCommand(surface: string, command: string): void {
  if (isHeadlessSurface(surface)) return;

  const backend = requireMuxBackend();
  backendOps[backend].send(surface, command);
}

/**
 * 向 surface 发送 Escape 按键。
 */
export function sendEscape(surface: string): void {
  if (isHeadlessSurface(surface)) {
    sendHeadlessEscape(surface);
    return;
  }

  const backend = requireMuxBackend();
  backendOps[backend].sendEscape(surface);
}

/**
 * 向 surface 发送长命令（通过脚本文件避免终端自动换行问题）。
 * 返回脚本文件路径。
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  // Headless mode: spawn as a background child process
  if (isHeadlessSurface(surface)) {
    const logFile = options?.scriptPath
      ? options.scriptPath.replace(/\.sh$/, ".log")
      : undefined;
    const scriptPath =
      options?.scriptPath ??
      join(
        tmpdir(),
        "pi-subagent-scripts",
        `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
      );
    mkdirSync(dirname(scriptPath), { recursive: true });
    const scriptParts = ["#!/bin/bash"];
    if (options?.scriptPreamble) {
      scriptParts.push(options.scriptPreamble.trimEnd());
    }
    scriptParts.push(command);
    writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });

    spawnHeadlessProcess(surface, "subagent", `bash ${shellEscape(scriptPath)}`, {
      cwd: process.cwd(),
      env: { PI_SUBAGENT_HEADLESS: "1" },
    });
    return scriptPath;
  }

  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * 同步读取 surface 屏幕最后 N 行。
 */
export function readScreen(surface: string, lines = 50): string {
  if (isHeadlessSurface(surface)) {
    return readHeadlessScreen(surface, lines);
  }

  const backend = requireMuxBackend();
  return backendOps[backend].read(surface, lines);
}

/**
 * 异步读取 surface 屏幕最后 N 行。
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  if (isHeadlessSurface(surface)) {
    return readHeadlessScreenAsync(surface, lines);
  }

  const backend = requireMuxBackend();
  return backendOps[backend].readAsync(surface, lines);
}

/**
 * 关闭 surface。
 */
export function closeSurface(surface: string): void {
  if (isHeadlessSurface(surface)) {
    closeHeadlessSurface(surface);
    return;
  }

  const backend = requireMuxBackend();
  backendOps[backend].close(surface);
}

/**
 * 重命名指定 surface。
 */
export function renameSurface(surface: string, name: string): void {
  if (isHeadlessSurface(surface)) return;

  const backend = requireMuxBackend();
  backendOps[backend].rename(surface, name);
}

/**
 * 重命名子 agent 显示名称（左侧栏标题，仅 herdr 支持）。
 */
export function renameAgent(surface: string, name: string): void {
  if (isHeadlessMode()) return;
  const backend = getMuxBackend();
  if (backend === "herdr") {
    renameHerdrAgent(surface, name);
  }
}

/**
 * 重命名当前 tab / window。
 */
export function renameCurrentTab(title: string): void {
  if (isHeadlessMode()) return;

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "muxy") {
    const paneId = AGENT_MUXY_PANE_ID;
    if (!paneId) throw new Error("MUXY_PANE_ID not set");
    execFileSync("muxy", ["rename-pane", "--pane", paneId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-tab-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    execFileSync("wezterm", args, { encoding: "utf8" });
    return;
  }

  if (backend === "herdr") {
    renameHerdrTab(AGENT_HERDR_PANE_ID ?? "", title);
    return;
  }

  if (backend === "otty") {
    renameOttyTab(AGENT_OTTY_PANE_ID ?? "", title);
    return;
  }

  // zellij: rename the agent's own pane
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (paneId) {
    execFileSync("zellij", ["action", "rename-pane", title, "--pane-id", paneId], { encoding: "utf8" });
  } else {
    execFileSync("zellij", ["action", "rename-pane", title], { encoding: "utf8" });
  }
}

/**
 * 重命名当前 workspace / session。
 */
export function renameWorkspace(title: string): void {
  if (isHeadlessMode()) return;

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "muxy") {
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      { encoding: "utf8" },
    ).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-window-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    try {
      execFileSync("wezterm", args, { encoding: "utf8" });
    } catch {
      // Optional.
    }
    return;
  }

  if (backend === "herdr") {
    renameHerdrWorkspace(title);
    return;
  }

  if (backend === "otty") {
    return;
  }

  // zellij: skip session rename
}

export { renameHerdrTab, renameHerdrWorkspace };

// ── pollForExit ──

/**
 * 类型收窄辅助：将 unknown 收窄为 Record<string, unknown>。
 * 仅应在 typeof v === "object" && v !== null 检查后调用。
 * JSON.parse 返回 any，此处为类型边界必须用 as 收窄。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asRecord(v: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return v as Record<string, unknown>;
}

/** pollForExit sentinel 检测每次读取的屏幕行数 */
const SENTINEL_READ_LINES = 200;

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "structured_output" | "sentinel";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Validated structured output if reason is "structured_output" */
  structuredOutput?: unknown;
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  const isHeadless = isHeadlessSurface(surface);

  for (;;) {
    if (signal.aborted) {
      muxLog(`[pollForExit] ABORTED at loop start surface=${surface} elapsed=${Date.now() - start}ms — signal was aborted before/synchronously after watchSubagent entered poll loop (likely stale POLL_ABORT_KEY controller). Throwing "Aborted while waiting..."\n`);
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file
    if (options.sessionFile) {
      const exitFile = `${options.sessionFile}.exit`;
      try {
        if (existsSync(exitFile)) {
          let data: unknown;
          try {
            data = JSON.parse(readFileSync(exitFile, "utf8"));
          } catch (parseErr: unknown) {
            const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            muxLog(
              `[pollForExit] FAST PATH BUG: ${exitFile} exists but JSON.parse failed: ${errMsg}\n` +
                `[pollForExit] contents(raw)=${JSON.stringify((() => { try { return readFileSync(exitFile, "utf8"); } catch { return "<unreadable>"; } })())}\n`,
            );
            throw parseErr;
          }
          // 双重确认：子 pi 进程必须已启动
          const sessionJsonl = options.sessionFile;
          try {
            if (!existsSync(sessionJsonl) || (await (await import("node:fs/promises")).stat(sessionJsonl)).size === 0) {
              rmSync(exitFile, { force: true });
              muxLog(
                `[pollForExit] fast path FALSE POSITIVE: ${exitFile} type=${String((data as Record<string, unknown>).type)} but ${sessionJsonl} is ` +
                  `${existsSync(sessionJsonl) ? `empty (0 bytes)` : `missing`} — subagent never started, ` +
                  `deleting stale .exit and continuing poll\n`,
              );
              throw Object.assign(new Error("subprocess not started"), { code: "SUBPROCESS_NOT_STARTED" });
            }
          } catch (e2: unknown) {
            if (e2 instanceof Error && (e2 as Error & { code?: string }).code === "SUBPROCESS_NOT_STARTED") throw e2;
            muxLog(`[pollForExit] session jsonl check failed (non-fatal): ${e2 instanceof Error ? e2.message : String(e2)}\n`);
          }
          rmSync(exitFile, { force: true });
          if (typeof data !== "object" || data === null) {
            muxLog(`[pollForExit] fast path unexpected data type exitFile=${exitFile}\n`);
            return { reason: "done", exitCode: 0 };
          }
          const typed = asRecord(data);
          muxLog(`[pollForExit] fast path hit exitFile=${exitFile} type=${String(typed.type)}\n`);
          if (typed.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: String(typed.name ?? ""), message: String(typed.message ?? "") } };
          }
          if (typed.type === "structured_output") {
            return { reason: "structured_output", exitCode: 0, structuredOutput: typed.value };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch (e: any) {
        if (e?.code !== "ENOENT" && e?.code !== "SUBPROCESS_NOT_STARTED") {
          muxLog(
            `[pollForExit] fast path error sessionFile=${options.sessionFile} err=${e?.message ?? String(e)}\n`,
          );
        }
      }
    }

    // Check Claude sentinel file
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          muxLog(`[pollForExit] sentinel file hit path=${options.sentinelFile}\n`);
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch (e: any) {
        muxLog(
          `[pollForExit] sentinel file check error path=${options.sentinelFile} err=${e?.message ?? String(e)}\n`,
        );
      }
    }

    // Headless mode: check if the child process has exited
    if (isHeadless) {
      const headlessExit = getHeadlessProcessExit(surface);
      if (headlessExit) {
        const { exitCode } = await Promise.race([
          headlessExit,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 100),
          ),
        ]).catch(() => ({ exitCode: null as number | null }));
        if (exitCode !== null && exitCode !== undefined) {
          drainHeadlessProcess(surface);
          return { reason: "sentinel", exitCode };
        }
      }
    }

    // Slow path: read terminal screen for sentinel
    if (!isHeadless) {
      let screen = "";
      let readErr: unknown = null;
      try {
        screen = await readScreenAsync(surface, SENTINEL_READ_LINES);
      } catch (e) {
        readErr = e;
      }

      if (readErr) {
        muxLog(
          `[pollForExit] slow path read screen FAILED surface=${surface} err=${(readErr as Error)?.message ?? String(readErr)}\n`,
        );
        if (options.sessionFile) {
          const exitFile = `${options.sessionFile}.exit`;
          try {
            if (existsSync(exitFile)) {
              const raw: unknown = JSON.parse(readFileSync(exitFile, "utf8"));
              if (typeof raw !== "object" || raw === null) {
                return { reason: "done", exitCode: 0 };
              }
              const rData: Record<string, unknown> = asRecord(raw);
              rmSync(exitFile, { force: true });
              muxLog(`[pollForExit] recovery via .exit after screen read failure file=${exitFile} type=${String(rData.type)}\n`);
              if (rData.type === "ping") {
                return { reason: "ping", exitCode: 0, ping: { name: String(rData.name ?? ""), message: String(rData.message ?? "") } };
              }
              if (rData.type === "structured_output") {
                return { reason: "structured_output", exitCode: 0, structuredOutput: rData.value };
              }
              return { reason: "done", exitCode: 0 };
            }
          } catch (e2: unknown) {
            muxLog(
              `[pollForExit] recovery .exit check FAILED file=${exitFile} err=${e2 instanceof Error ? e2.message : String(e2)}\n`,
            );
          }
        }
      } else {
        const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
        if (match) {
          muxLog(`[pollForExit] slow path sentinel hit surface=${surface} exitCode=${match[1]}\n`);
          return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
        }
        // 每 10 秒记一次屏幕尾部快照
        if (Date.now() - start > 0 && Math.floor((Date.now() - start) / 1000) % 10 === 0) {
          muxLog(
            `[pollForExit] slow path no sentinel surface=${surface} tail=${JSON.stringify(screen.slice(-200))}\n`,
          );
        }
      }
    } else if (options.sessionFile) {
      const exitFile = `${options.sessionFile}.exit`;
      try {
        if (existsSync(exitFile)) {
          const raw = JSON.parse(readFileSync(exitFile, "utf8"));
          if (typeof raw !== "object" || raw === null) {
            return { reason: "done", exitCode: 0 };
          }
          const hData = asRecord(raw);
          rmSync(exitFile, { force: true });
          muxLog(`[pollForExit] headless .exit hit file=${exitFile} type=${hData.type}\n`);
          if (hData.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: String(hData.name ?? ""), message: String(hData.message ?? "") } };
          }
          if (hData.type === "structured_output") {
            return { reason: "structured_output", exitCode: 0, structuredOutput: hData.value };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch (e: unknown) {
        muxLog(
          `[pollForExit] headless .exit check FAILED file=${exitFile} err=${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
