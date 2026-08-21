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
import { shellEscape, powershellEscape } from "./shell.ts";
import type { MuxBackend } from "./detection.ts";
import type { BackendOps } from "./backends/types.ts";

import { ops as muxyOps } from "./backends/muxy.ts";
import { ops as cmuxOps } from "./backends/cmux.ts";
import { ops as tmuxOps } from "./backends/tmux.ts";
import { ops as zellijOps } from "./backends/zellij.ts";
import { ops as weztermOps } from "./backends/wezterm.ts";
import { ops as herdrOps, AGENT_HERDR_PANE_ID, renameHerdrTab, renameHerdrWorkspace } from "./backends/herdr.ts";
import { ops as ottyOps, AGENT_OTTY_PANE_ID } from "./backends/otty.ts";
import { ops as orcaOps, AGENT_ORCA_TERMINAL_HANDLE } from "./backends/orca.ts";

// 各后端直接引用的公开函数（非对称操作不进 BackendOps）
import { renameHerdrPane, renameHerdrAgent, sendHerdrCommand, sendHerdrEscape, readHerdrScreen, closeHerdrSurface } from "./backends/herdr.ts";
import { sendOttyCommand, sendOttyEscape, readOttyScreen, closeOttySurface, renameOttyTab } from "./backends/otty.ts";
import { renameOrcaTerminal } from "./backends/orca.ts";

const execFileAsync = promisify(execFile);
const ORCA_BACKEND: MuxBackend = "orca";
const HERDR_BACKEND: MuxBackend = "herdr";
const TMUX_WINDOW_RENAME_SETTING = "PI_SUBAGENT_RENAME_TMUX_WINDOW";
const TMUX_SESSION_RENAME_SETTING = "PI_SUBAGENT_RENAME_TMUX_SESSION";
const HERDR_WORKSPACE_RENAME_SETTING = "PI_SUBAGENT_RENAME_HERDR_WORKSPACE";
const ENABLED_SETTING_VALUE = "1";

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
  orca: orcaOps,
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

/** 返回最近一次分屏来源，不修改当前记录。 */
export function getLastSplitSource(): string | null {
  return lastSplitSource;
}

/** 清空最近一次分屏来源记录。 */
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
  } else if (backend === ORCA_BACKEND) {
    lastSplitSource = AGENT_ORCA_TERMINAL_HANDLE ?? null;
  } else {
    // tmux / wezterm / zellij / herdr
    lastSplitSource = process.env.TMUX_PANE ?? null;
  }

  return backendOps[backend].create(name);
}

/**
 * 分屏来源/激活 options 的公开类型。
 * activate 仅 wezterm 支持；其他后端忽略该提示并保持既有焦点行为。
 */
export interface CreateSurfaceSplitOptions {
  /** 是否在分屏后激活新创建的 pane（仅 wezterm；默认 false，保持当前焦点） */
  activate?: boolean;
}

/**
 * 指定方向分屏创建新 surface。
 *
 * 签名沿用法（外部 API 兼容豁免参数数量约束）：前三个位置参数 name/direction/fromSurface 是现有
 * 公开契约，仓库内调用方（pi-interactive-subagents/test/integration/harness.ts）仍以
 * createSurfaceSplit(name, direction, fromSurface) 三位置参调用，合并为参数对象会破坏这些调用点的
 * 源码兼容；因此新增能力只能作为第 4 个可选尾部参数 options 追加，旧 3 参调用类型与行为保持不变。
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  options?: CreateSurfaceSplitOptions,
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
  } else if (backend === "orca") {
    // orca split 默认从 agent 自己的 terminal 拆，与 splitOrcaTerminal 的回退逻辑一致
    lastSplitSource = fromSurface ?? AGENT_ORCA_TERMINAL_HANDLE ?? null;
  } else {
    // tmux / wezterm / zellij
    const source = backend === "tmux" ? process.env.TMUX_PANE : fromSurface;
    lastSplitSource = source ?? null;
  }

  return backendOps[backend].createSplit(name, direction, fromSurface, options);
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
 * sendLongCommand 选项。interpreter 缺省为 "bash"，与既有全部调用方保持兼容；
 * Windows PowerShell 调用方显式传 "powershell" 才切换到 PowerShell 脚本运行时。
 */
export interface SendLongCommandOptions {
  /** 显式脚本文件路径（原样保留，不自动改扩展名） */
  scriptPath?: string;
  /** 脚本前置片段（Shebang 除外；默认 Bash 时用于注入 env export 等） */
  scriptPreamble?: string;
  /** 脚本解释器，默认 "bash"；显式 "powershell" 时按 PowerShell 语法生成 .ps1 并执行 */
  interpreter?: "bash" | "powershell";
}

// ── 长命令脚本运行时常量 ──

/** 默认解释器：所有平台都保持 Bash，避免改变现有调用方语义 */
const DEFAULT_SEND_INTERPRETER = "bash";
const INTERPRETER_POWERSHELL = "powershell";

/** 解析 sendLongCommand 的解释器；省略时始终保持 Bash 兼容默认值。 */
export function resolveSendInterpreter(
  interpreter?: "bash" | "powershell",
): "bash" | "powershell" {
  return interpreter ?? DEFAULT_SEND_INTERPRETER;
}

/** 脚本文件写入权限：PowerShell 无需可执行位，Bash 脚本需可执行位 */
const POWERSHELL_SCRIPT_MODE = 0o644;
const BASH_SCRIPT_MODE = 0o755;

/** PowerShell -File / -Command 启动器可执行文件名与前导参数 */
const POWERSHELL_EXECUTABLE = "powershell.exe";
const POWERSHELL_LAUNCH_PREFIX = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"] as const;

/**
 * 返回按解释器选择的脚本扩展名（.sh / .ps1），用于自动脚本路径的文件后缀。
 */
export function sendScriptExtension(interpreter: "bash" | "powershell"): string {
  return interpreter === INTERPRETER_POWERSHELL ? ".ps1" : ".sh";
}

/**
 * 生成脚本内容：Bash 以 shebang + \n 分隔，PowerShell 无 shebang 且以 CRLF 分隔。
 */
export function buildSendScriptContent(
  interpreter: "bash" | "powershell",
  preamble: string | undefined,
  command: string,
): string {
  if (interpreter === INTERPRETER_POWERSHELL) {
    const parts: string[] = [];
    if (preamble) parts.push(preamble.trimEnd());
    parts.push(command);
    return parts.join("\r\n") + "\r\n";
  }
  const parts = ["#!/bin/bash"];
  if (preamble) parts.push(preamble.trimEnd());
  parts.push(command);
  return parts.join("\n") + "\n";
}

/**
 * 构建 mux pane 中执行脚本的 shell 调用：Bash 用 `bash <path>`，PowerShell 用
 * `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <path>`。
 */
export function buildMuxInvocation(interpreter: "bash" | "powershell", scriptPath: string): string {
  if (interpreter === INTERPRETER_POWERSHELL) {
    return `${POWERSHELL_EXECUTABLE} ${POWERSHELL_LAUNCH_PREFIX.join(" ")} -File ${powershellEscape(scriptPath)}`;
  }
  return `bash ${shellEscape(scriptPath)}`;
}

/**
 * 向 surface 发送长命令（通过脚本文件避免终端自动换行问题）。
 * 返回脚本文件路径。默认解释器为 Bash（所有平台）；显式 interpreter:"powershell"
 * 时按 PowerShell 语法写 .ps1 并执行。
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: SendLongCommandOptions,
): string {
  const interpreter = resolveSendInterpreter(options?.interpreter);
  const extension = sendScriptExtension(interpreter);

  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${extension}`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const content = buildSendScriptContent(interpreter, options?.scriptPreamble, command);
  const mode = interpreter === INTERPRETER_POWERSHELL ? POWERSHELL_SCRIPT_MODE : BASH_SCRIPT_MODE;
  writeFileSync(scriptPath, content, { mode });

  // Headless mode: spawn as a background child process
  if (isHeadlessSurface(surface)) {
    const headlessCommand =
      interpreter === INTERPRETER_POWERSHELL
        ? `& ${powershellEscape(scriptPath)}`
        : `bash ${shellEscape(scriptPath)}`;
    spawnHeadlessProcess(surface, "subagent", headlessCommand, {
      cwd: process.cwd(),
      env: { PI_SUBAGENT_HEADLESS: "1" },
      interpreter,
    });
    return scriptPath;
  }

  sendCommand(surface, buildMuxInvocation(interpreter, scriptPath));
  return scriptPath;
}

/**
 * 统一读屏 options。source 仅 herdr 后端消费（转发给 herdr pane read --source），
 * 非 herdr 后端忽略该提示并保持各自既有读屏语义；未提供时 herdr 维持默认 recent。
 */
export interface ReadScreenOptions {
  source?: "recent" | "visible" | "recent_unwrapped";
}

/**
 * 同步读取 surface 屏幕最后 N 行。
 * options.source 仅对 herdr 后端生效（如 "recent_unwrapped"），其他后端忽略。
 */
export function readScreen(surface: string, lines = 50, options?: ReadScreenOptions): string {
  if (isHeadlessSurface(surface)) {
    return readHeadlessScreen(surface, lines);
  }

  const backend = requireMuxBackend();
  if (options?.source && backend === HERDR_BACKEND) {
    return readHerdrScreen(surface, lines, options.source);
  }
  return backendOps[backend].read(surface, lines);
}

/**
 * 异步读取 surface 屏幕最后 N 行。
 * options.source 仅对 herdr 后端生效（如 "recent_unwrapped"），其他后端忽略。
 */
export async function readScreenAsync(
  surface: string,
  lines = 50,
  options?: ReadScreenOptions,
): Promise<string> {
  if (isHeadlessSurface(surface)) {
    return readHeadlessScreenAsync(surface, lines);
  }

  const backend = requireMuxBackend();
  if (options?.source && backend === HERDR_BACKEND) {
    return readHerdrScreen(surface, lines, options.source);
  }
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

export type RenameOperation = "tab" | "workspace";
export type RenameTarget = "tab" | "window" | "pane" | "workspace" | "session" | "terminal";
export type RenameBackend = MuxBackend | "headless";

export type RenameCapability =
  | { status: "supported"; backend: MuxBackend; operation: RenameOperation; target: RenameTarget }
  | { status: "unsupported"; backend: RenameBackend; operation: RenameOperation }
  | { status: "disabled"; backend: MuxBackend; operation: RenameOperation; setting: string };

export type RenameResult =
  | { status: "renamed"; backend: MuxBackend; operation: RenameOperation; target: RenameTarget }
  | { status: "unsupported"; backend: RenameBackend; operation: RenameOperation }
  | { status: "disabled"; backend: MuxBackend; operation: RenameOperation; setting: string }
  | { status: "failed"; backend: MuxBackend; operation: RenameOperation; target: RenameTarget; error: string };

/** 返回指定后端的真实重命名语义，不执行终端命令。 */
export function getRenameCapability(
  operation: RenameOperation,
  backend: MuxBackend | null = getMuxBackend(),
  env: NodeJS.ProcessEnv = process.env,
): RenameCapability {
  if (!backend) return { status: "unsupported", backend: "headless", operation };

  if (operation === "tab") {
    if (backend === "tmux" && env[TMUX_WINDOW_RENAME_SETTING] !== ENABLED_SETTING_VALUE) {
      return { status: "disabled", backend, operation, setting: TMUX_WINDOW_RENAME_SETTING };
    }
    const target: Record<MuxBackend, RenameTarget> = {
      muxy: "pane",
      cmux: "tab",
      tmux: "window",
      zellij: "pane",
      wezterm: "tab",
      herdr: "tab",
      otty: "tab",
      orca: "terminal",
    };
    return { status: "supported", backend, operation, target: target[backend] };
  }

  if (backend === "tmux" && env[TMUX_SESSION_RENAME_SETTING] !== ENABLED_SETTING_VALUE) {
    return { status: "disabled", backend, operation, setting: TMUX_SESSION_RENAME_SETTING };
  }
  if (backend === "herdr" && env[HERDR_WORKSPACE_RENAME_SETTING] !== ENABLED_SETTING_VALUE) {
    return { status: "disabled", backend, operation, setting: HERDR_WORKSPACE_RENAME_SETTING };
  }
  if (backend === "cmux") return { status: "supported", backend, operation, target: "workspace" };
  if (backend === "tmux") return { status: "supported", backend, operation, target: "session" };
  if (backend === "wezterm") return { status: "supported", backend, operation, target: "window" };
  if (backend === "herdr") return { status: "supported", backend, operation, target: "workspace" };
  return { status: "unsupported", backend, operation };
}

/** 将终端命令异常封装为可判别的失败结果。 */
function failedRenameResult(capability: Extract<RenameCapability, { status: "supported" }>, error: unknown): RenameResult {
  return {
    status: "failed",
    backend: capability.backend,
    operation: capability.operation,
    target: capability.target,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** 重命名当前 tab/window/pane，并返回实际目标与执行结果。 */
export function renameCurrentTab(title: string): RenameResult {
  const capability = getRenameCapability("tab");
  if (capability.status !== "supported") return capability;

  try {
    const backend = capability.backend;
    if (backend === "cmux") {
      const surfaceId = process.env.CMUX_SURFACE_ID;
      if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
      execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
        encoding: "utf8",
      });
    } else if (backend === "muxy") {
      const paneId = AGENT_MUXY_PANE_ID;
      if (!paneId) throw new Error("MUXY_PANE_ID not set");
      execFileSync("muxy", ["rename-pane", "--pane", paneId, title], { encoding: "utf8" });
    } else if (backend === "tmux") {
      const paneId = process.env.TMUX_PANE;
      if (!paneId) throw new Error("TMUX_PANE not set");
      const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
        encoding: "utf8",
      }).trim();
      execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    } else if (backend === "wezterm") {
      const paneId = process.env.WEZTERM_PANE;
      const args = ["cli", "set-tab-title"];
      if (paneId) args.push("--pane-id", paneId);
      args.push(title);
      execFileSync("wezterm", args, { encoding: "utf8" });
    } else if (backend === "herdr") {
      if (!renameHerdrTab(AGENT_HERDR_PANE_ID ?? "", title)) {
        throw new Error("Herdr tab rename did not complete");
      }
    } else if (backend === "otty") {
      if (!renameOttyTab(AGENT_OTTY_PANE_ID ?? "", title)) {
        throw new Error("Otty tab rename did not complete");
      }
    } else if (backend === "orca") {
      if (!AGENT_ORCA_TERMINAL_HANDLE) throw new Error("ORCA_TERMINAL_HANDLE not set");
      renameOrcaTerminal(AGENT_ORCA_TERMINAL_HANDLE, title);
    } else {
      const paneId = process.env.ZELLIJ_PANE_ID;
      const args = ["action", "rename-pane", title];
      if (paneId) args.push("--pane-id", paneId);
      execFileSync("zellij", args, { encoding: "utf8" });
    }
    return { status: "renamed", backend, operation: capability.operation, target: capability.target };
  } catch (error) {
    return failedRenameResult(capability, error);
  }
}

/** 重命名当前 workspace/session/window，并明确报告不支持或未启用。 */
export function renameWorkspace(title: string): RenameResult {
  const capability = getRenameCapability("workspace");
  if (capability.status !== "supported") return capability;

  try {
    const backend = capability.backend;
    if (backend === "cmux") {
      execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
        encoding: "utf8",
      });
    } else if (backend === "tmux") {
      const paneId = process.env.TMUX_PANE;
      if (!paneId) throw new Error("TMUX_PANE not set");
      const sessionId = execFileSync(
        "tmux",
        ["display-message", "-p", "-t", paneId, "#{session_id}"],
        { encoding: "utf8" },
      ).trim();
      execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    } else if (backend === "wezterm") {
      const paneId = process.env.WEZTERM_PANE;
      const args = ["cli", "set-window-title"];
      if (paneId) args.push("--pane-id", paneId);
      args.push(title);
      execFileSync("wezterm", args, { encoding: "utf8" });
    } else if (backend === "herdr") {
      if (!renameHerdrWorkspace(title)) {
        throw new Error("Herdr workspace rename did not complete");
      }
    }
    return { status: "renamed", backend, operation: capability.operation, target: capability.target };
  } catch (error) {
    return failedRenameResult(capability, error);
  }
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
