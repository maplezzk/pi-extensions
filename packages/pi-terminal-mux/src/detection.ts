/**
 * detection.ts — 终端后端探测与偏好解析（共享基础设施）
 *
 * 包含：
 *   - muxLog / AGENT_MUXY_PANE_ID：调试日志与 agent pane 标识
 *   - MuxBackend 类型与 hasCommand / muxPreference 内部辅助
 *   - is*RuntimeAvailable / is*Available：各后端可用性检测
 *   - getMuxBackend / isMuxAvailable / muxSetupHint：对外探测入口
 *
 * muxLog 被多模块使用，归此文件。
 */

import { execSync, execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { i18n } from "./i18n.ts";
import { isHerdrRuntimeAvailable } from "./herdr.ts";
import { isOttyRuntimeAvailable, ottySetupHint } from "./otty.ts";

// ── 分屏调试日志 ──

/**
 * 分屏调试日志写入文件，避免污染 TUI 终端。
 * 日志路径: /tmp/pi-muxy-split.log
 *
 * 注意：必须用 /tmp/，不能用 os.tmpdir()。herdr 的日志已经写到
 * /tmp/pi-herdr-split.log，用户排查问题时只看 /tmp/ 即可。
 * 之前用 tmpdir() 导致 macOS 上日志落到 /var/folders/.../T/，与
 * /tmp/ 分裂，用户 grep /tmp 找不到，调试时被坑过。
 */
const MUXY_SPLIT_LOG = "/tmp/pi-muxy-split.log";

export function muxLog(msg: string): void {
  try {
    appendFileSync(MUXY_SPLIT_LOG, `[${new Date().toISOString()}] ${msg}`);
  } catch {
    // 写日志失败不影响主流程
  }
}

// ── Agent pane 标识 ──

/**
 * Agent's own pane ID in Muxy, captured at module load time.
 * Unlike reading process.env.MUXY_PANE_ID dynamically (which may reflect
 * the user's currently focused pane after switching projects in Muxy),
 * this constant always points to the pane where the agent/pi was launched.
 */
export const AGENT_MUXY_PANE_ID = process.env.MUXY_PANE_ID;

// ── 后端类型 ──

export type MuxBackend = "cmux" | "muxy" | "tmux" | "zellij" | "wezterm" | "herdr" | "otty";

// ── 命令可用性检测 ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
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

// ── 偏好解析 ──

function muxPreference(): MuxBackend | null {
  // PI_TERMINAL_MUX 为通用包的首选变量；PI_SUBAGENT_MUX 保留向后兼容。
  const pref = (process.env.PI_TERMINAL_MUX ?? process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (
    pref === "cmux" ||
    pref === "muxy" ||
    pref === "tmux" ||
    pref === "zellij" ||
    pref === "wezterm" ||
    pref === "herdr" ||
    pref === "otty"
  )
    return pref;
  return null;
}

// ── 各后端运行时可用性（内部） ──

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isMuxyRuntimeAvailable(): boolean {
  return !!process.env.MUXY_SOCKET_PATH && hasCommand("muxy");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

function isWezTermRuntimeAvailable(): boolean {
  return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
}

// ── 各后端可用性（公开） ──

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
  return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
}

export function isWezTermAvailable(): boolean {
  return isWezTermRuntimeAvailable();
}

export function isHerdrAvailable(): boolean {
  return isHerdrRuntimeAvailable();
}

export function isOttyAvailable(): boolean {
  return isOttyRuntimeAvailable();
}

// ── 后端探测入口 ──

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "muxy") return isMuxyRuntimeAvailable() ? "muxy" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
  if (pref === "wezterm") return isWezTermRuntimeAvailable() ? "wezterm" : null;
  if (pref === "herdr") return isHerdrRuntimeAvailable() ? "herdr" : null;
  if (pref === "otty") return isOttyRuntimeAvailable() ? "otty" : null;

  if (isMuxyRuntimeAvailable()) return "muxy";
  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  if (isWezTermRuntimeAvailable()) return "wezterm";
  if (isHerdrRuntimeAvailable()) return "herdr";
  if (isOttyRuntimeAvailable()) return "otty";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

// ── 用户安装提示 ──

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref) {
    const hint = i18n.t(`setupHint.${pref}`);
    // otty 在 send-keys 未启用时补充更具体的提示
    if (pref === "otty") {
      return ottySetupHint() || hint;
    }
    return hint;
  }
  return i18n.t("setupHint.generic");
}
