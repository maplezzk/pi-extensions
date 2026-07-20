/**
 * shell.ts — Shell 辅助工具（共享基础设施）
 *
 * 包含：
 *   - isFishShell / exitStatusVar / shellEscape：shell 类型检测与转义（公开 API）
 *   - tailLines / sleepSync / envPositiveInteger：通用工具（非公开，供内部使用）
 *
 * 后三者虽是通用工具，按 plan 归此模块。
 */

import { basename } from "node:path";

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

/**
 * Single-quote shell escape: wraps the string in single quotes,
 * escaping any embedded single quotes with '\''.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Return the last N lines of text.
 * 非公开 API，供 readScreen 等内部使用。
 */
export function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

/**
 * Read a positive integer from the environment, falling back to a default value.
 * 非公开 API，供 zellij 放置规划内部使用。
 */
export function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Synchronous sleep using Atomics.wait on a shared buffer.
 * 非公开 API，供 zellij 锁和重试逻辑内部使用。
 */
export function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
