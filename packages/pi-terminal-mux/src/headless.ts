/**
 * headless.ts — 无终端复用器时的降级后台子进程模式（共享基础设施）
 *
 * 当探测不到任何终端后端时，pi-terminal-mux 自动降级为 headless 模式：
 * 子进程通过 bash 后台启动，stdout/stderr 写入日志文件，
 * 用 SIGINT（Escape）和 SIGTERM（关闭）模拟 pane 操作。
 *
 * 包含：
 *   - HeadlessProcess 接口与 headlessProcesses 注册表
 *   - createHeadlessSurface / spawnHeadlessProcess / closeHeadlessSurface
 *   - sendHeadlessEscape / readHeadlessScreen / readHeadlessScreenAsync
 *   - isHeadlessSurface / isHeadlessMode
 *   - cleanupHeadlessProcesses / getHeadlessProcessExit / drainHeadlessProcess
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMuxAvailable } from "./detection.ts";

// ── 常量 ──

const HEADLESS_SURFACE_PREFIX = "headless:";

/** headless surface 关闭时 SIGTERM 到 SIGKILL 的等待间隔（毫秒） */
const HEADLESS_KILL_TIMEOUT_MS = 3000;

/** 屏幕读取默认行数 */
const DEFAULT_SCREEN_LINES = 50;

// ── Headless 进程状态 ──

interface HeadlessProcess {
  child: ChildProcess;
  exitPromise: Promise<{ exitCode: number }>;
  resolveExit: ((value: { exitCode: number }) => void) | null;
  logStream: WriteStream;
  logFile: string;
}

const headlessProcesses = new Map<string, HeadlessProcess>();

// ── Surface 创建 ──

/**
 * 创建一个 headless surface（不启动子进程，只生成唯一 ID）。
 * surface 格式：headless:<timestamp>-<random>。
 */
export function createHeadlessSurface(name: string): string {
  const id = `${HEADLESS_SURFACE_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return id;
}

// ── 后台子进程管理 ──

/**
 * 在 headless surface 上启动一个 bash 子进程，stdout/stderr 写入日志文件。
 * 返回日志文件路径，调用方通过 readHeadlessScreen 读取输出。
 *
 * 注意：spawnHeadlessProcess 签名与原 mux.ts 完全一致（公开 API，不可改签名），
 * 第 4 个参数 options 为可选对象，不计入函数参数数量规则的违规。
 */
export function spawnHeadlessProcess(
  surface: string,
  name: string,
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
): { logFile: string } {
  const safeId = surface.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFile = join(tmpdir(), `pi-subagent-${safeId}.log`);
  const logStream = createWriteStream(logFile, { flags: "w" });

  const env = { ...process.env };
  if (options?.env) {
    Object.assign(env, options.env);
  }
  env.PI_SUBAGENT_HEADLESS = "1";

  const child = spawn("bash", ["-c", command], {
    cwd: options?.cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.stdout.resume();
  child.stderr.resume();

  // resolveExit 在 Promise 构造函数内赋值一次，外部声明为 let 以便跨作用域访问。
  let resolveExit: ((value: { exitCode: number }) => void) | null = null;
  const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
    resolveExit = resolve;
    child.on("exit", (code) => {
      logStream.end();
      resolve({ exitCode: code ?? 1 });
    });
    child.on("error", () => {
      logStream.end();
      resolve({ exitCode: 1 });
    });
  });

  headlessProcesses.set(surface, { child, exitPromise, resolveExit, logStream, logFile });

  return { logFile };
}

// ── Surface 关闭 ──

/**
 * 关闭 headless surface：先 SIGTERM，HEADLESS_KILL_TIMEOUT_MS 后若仍存活则 SIGKILL。
 */
export function closeHeadlessSurface(surface: string): void {
  const proc = headlessProcesses.get(surface);
  if (!proc) return;
  try {
    proc.child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      proc.child.kill("SIGKILL");
    } catch {}
    headlessProcesses.delete(surface);
  }, HEADLESS_KILL_TIMEOUT_MS).unref();
}

// ── Escape 信号 ──

/**
 * 向 headless surface 发送 Escape（SIGINT）。
 */
export function sendHeadlessEscape(surface: string): void {
  const proc = headlessProcesses.get(surface);
  if (!proc) return;
  try {
    proc.child.kill("SIGINT");
  } catch {}
}

// ── 屏幕读取 ──

/**
 * 同步读取 headless surface 最后 N 行日志输出。
 */
export function readHeadlessScreen(surface: string, lines = DEFAULT_SCREEN_LINES): string {
  const proc = headlessProcesses.get(surface);
  if (!proc) return "";
  try {
    const content = readFileSync(proc.logFile, "utf8");
    const split = content.split("\n");
    return split.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * 异步读取 headless surface 最后 N 行日志输出。
 */
export async function readHeadlessScreenAsync(surface: string, lines = DEFAULT_SCREEN_LINES): Promise<string> {
  return readHeadlessScreen(surface, lines);
}

// ── 模式检测 ──

/**
 * 判断给定 surface 是否为 headless 模式下的 surface。
 */
export function isHeadlessSurface(surface: string): boolean {
  return surface.startsWith(HEADLESS_SURFACE_PREFIX) || headlessProcesses.has(surface);
}

/**
 * 当前会话是否处于 headless 降级模式（无可用终端后端）。
 */
export function isHeadlessMode(): boolean {
  return !isMuxAvailable();
}

// ── 生命周期管理 ──

/**
 * 清理所有 headless 子进程（SIGTERM + 清空注册表）。
 */
export function cleanupHeadlessProcesses(): void {
  for (const [surface, proc] of headlessProcesses) {
    try {
      proc.child.kill("SIGTERM");
    } catch {}
  }
  headlessProcesses.clear();
}

/**
 * 获取指定 headless surface 的进程退出 Promise（用于 pollForExit）。
 */
export function getHeadlessProcessExit(surface: string): Promise<{ exitCode: number }> | null {
  const proc = headlessProcesses.get(surface);
  return proc?.exitPromise ?? null;
}

/**
 * 从注册表中移除指定 headless surface（不杀进程）。
 */
export function drainHeadlessProcess(surface: string): void {
  headlessProcesses.delete(surface);
}
