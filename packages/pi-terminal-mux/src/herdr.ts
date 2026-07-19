/**
 * herdr.ts — herdr multiplexer backend for pi-interactive-subagents
 *
 * herdr 是一个终端原生 agent multiplexer（参见 https://herdr.dev）。
 * 当 pi 在 herdr 管理的 pane 内运行时，herdr 会注入：
 *   HERDR_ENV=1
 *   HERDR_WORKSPACE_ID（公开 id，如 "1"）
 *   HERDR_TAB_ID（公开 id，如 "1:1"）
 *   HERDR_PANE_ID（公开 id，如 "1-1"）
 *
 * 所有 pane 操作通过 `herdr` CLI 完成，详见 SKILL.md。
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { i18n } from "./i18n.ts";

// ── 日志（herdr 独立文件，便于区分后端） ──
const HERDR_SPLIT_LOG = "/tmp/pi-herdr-split.log";
function herdrLog(msg: string): void {
  try {
    appendFileSync(HERDR_SPLIT_LOG, `[${new Date().toISOString()}] ${msg}`);
  } catch {
    /* 写日志失败不影响主流程 */
  }
}

/**
 * 捕获于模块加载时的 agent pane id。
 * herdr 在启动 pane 的子进程时注入 HERDR_PANE_ID（公开 id 格式，如 "1-1"）。
 * 模块加载后再读取 env 可能反映用户切换焦点后的值，所以冻结到常量。
 */
export const AGENT_HERDR_PANE_ID = process.env.HERDR_PANE_ID;
export const AGENT_HERDR_WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;
export const AGENT_HERDR_TAB_ID = process.env.HERDR_TAB_ID;

// ── 命令可用性缓存 ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * 检测 herdr backend 是否可用：
 *   1. `herdr` 命令在 PATH 中
 *   2. 当前进程在 herdr pane 内运行（HERDR_ENV=1）
 *   3. HERDR_PANE_ID 已注入
 *
 * 注意：即使 socket 暂时不通，只要命令存在且 env 注入，就认为"runtime available"。
 * 子 agent 创建时会用 `herdr pane split` 触发 socket 调用，那时报错即可。
 */
export function isHerdrRuntimeAvailable(): boolean {
  return (
    !!process.env.HERDR_ENV &&
    process.env.HERDR_ENV === "1" &&
    !!process.env.HERDR_PANE_ID &&
    hasCommand("herdr")
  );
}

// ── herdr CLI 调用的薄封装 ──

/**
 * 调用 `herdr` 命令并返回 stdout。
 * 失败时 stderr 写入 log，原样抛错（调用方决定如何处理）。
 */
function herdrExec(args: string[]): string {
  herdrLog(`[herdr exec] herdr ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}\n`);
  const out = execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  herdrLog(`[herdr exec] -> ${JSON.stringify(out.trim().slice(0, 200))}\n`);
  return out;
}

/**
 * 调用 `herdr` 命令，丢弃 stdout。用于 sendCommand / sendKeys / closePane 这类
 * 无输出的命令，遵循 SKILL.md 中"pane send-text/send-keys/run print nothing on success"。
 */
function herdrExecSilent(args: string[]): void {
  herdrLog(`[herdr exec silent] herdr ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}\n`);
  execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 解析 herdr JSON 输出，失败返回 null。
 * SKILL.md 说明：`workspace list`、`tab create`、`pane split` 等成功命令打印 JSON。
 */
function parseHerdrJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * 从 herdr JSON 响应中提取 pane 的公开 id。
 * pane split 响应格式：`{ "id": "...", "result": { "type": "pane_info", "pane": { "pane_id": "1-2", ... } } }`
 */
function extractPaneId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const result = obj.result;
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // 多种结果类型都包含 pane：pane_info、pane_created 等
  const pane = (r.pane ?? r.root_pane) as Record<string, unknown> | undefined;
  if (pane && typeof pane.pane_id === "string") return pane.pane_id;
  return null;
}

// ── mux state 缓存 ──
//
// herdr 没有 tmux `last_split_source` 之类的明确"上一个 split 的父 pane"语义。
// 我们记录每个 surface 的"父 pane id"，用于 close 时清理（herdr 不需要这个，但保留
// 以便将来扩展 — closePane 实际上只看 surface id）。
const herdrPaneSources = new Map<string, string>();

// ── 对外 API：createSurface 系列 ──

/**
 * 创建一个新的 subagent pane。
 *
 * 实现：split 当前 agent pane 右侧（--no-focus 保持 agent 焦点不变）。
 * 后续 subagent 按 breadth-first 模式轮转 right/down/right/down…（与 cmux/muxy 行为一致）。
 */
export function createHerdrSurface(name: string): string {
  if (!AGENT_HERDR_PANE_ID) {
    throw new Error(
      "HERDR_PANE_ID not set; cannot determine parent pane for subagent split. " +
        "Start pi inside herdr so HERDR_PANE_ID is injected at launch.",
    );
  }

  // 与 muxy 同样的广度优先分屏策略：
  //   第一轮：从 agent pane 向右分，pos=0, base=1
  //   第二轮：从第一个 pane 向下分，pos=0, base=1
  //   第三轮：从第一个 pane 向右、第二个 pane 向右，pos=0, base=2
  //   ……
  // 状态文件：/tmp/herdr-subagent-pane-<agent_pane_id>.json
  const markerFile = `/tmp/herdr-subagent-pane-${AGENT_HERDR_PANE_ID.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
  const lockFile = `${markerFile}.lock`;

  // 全局锁：所有分屏操作串行化
  const acquired = (() => {
    for (let i = 0; i < 60; i++) {
      if (!existsSync(lockFile)) {
        try {
          writeFileSync(lockFile, `${process.pid}`, { flag: "wx" });
          return true;
        } catch {
          // 竞争失败，继续等待
        }
      }
      spawnSync("sleep", ["0.05"]);
    }
    return false;
  })();

  if (!acquired) {
    herdrLog(`[herdr split] failed to acquire lock ${lockFile}\n`);
    return "";
  }

  try {
    let state: { panes: string[]; pos: number; base: number; dir: "right" | "down" } = {
      panes: [],
      pos: 0,
      base: 0,
      dir: "right",
    };
    try {
      state = JSON.parse(readFileSync(markerFile, "utf8"));
    } catch {
      /* 文件不存在或损坏，用初始状态 */
    }

    // 首次 split
    if (state.panes.length === 0) {
      const output = herdrExec([
        "pane",
        "split",
        AGENT_HERDR_PANE_ID,
        "--direction",
        "right",
        "--no-focus",
      ]);
      const json = parseHerdrJson(output);
      const newPaneId = extractPaneId(json);
      if (newPaneId) {
        state.panes = [newPaneId];
        state.pos = 0;
        state.base = 1;
        state.dir = "down";
        writeFileSync(markerFile, JSON.stringify(state));
        herdrPaneSources.set(newPaneId, AGENT_HERDR_PANE_ID);
        renameHerdrPane(newPaneId, name);
        herdrLog(
          `[herdr split] mode=first dir=right from=${AGENT_HERDR_PANE_ID} new=${newPaneId} name=${JSON.stringify(name)}\n`,
        );
        return newPaneId;
      }
      herdrLog(`[herdr split] first split returned no pane id, output=${JSON.stringify(output)}\n`);
      return "";
    }

    // 本轮结束？翻转方向
    if (state.pos >= state.base) {
      state.pos = 0;
      state.base = state.panes.length;
      state.dir = state.dir === "right" ? "down" : "right";
    }

    let targetPane = state.panes[state.pos];
    if (!targetPane) {
      herdrLog(`[herdr split] state.panes[${state.pos}] is undefined\n`);
      return "";
    }

    // 若 targetPane 过期（pane 被关闭 / session 重启），自动重置状态从 agent pane 重新分屏
    let output: string;
    let sourcePane = targetPane;
    try {
      output = herdrExec([
        "pane",
        "split",
        targetPane,
        "--direction",
        state.dir,
        "--no-focus",
      ]);
    } catch {
      try { rmSync(markerFile); } catch { /* ignore */ }
      herdrLog(
        `[herdr split] pane ${targetPane} gone, resetting from agent pane ${AGENT_HERDR_PANE_ID}\n`,
      );
      state = { panes: [], pos: 0, base: 0, dir: "right" };
      targetPane = AGENT_HERDR_PANE_ID;
      sourcePane = AGENT_HERDR_PANE_ID;
      output = herdrExec([
        "pane",
        "split",
        AGENT_HERDR_PANE_ID,
        "--direction",
        "right",
        "--no-focus",
      ]);
    }
    const json = parseHerdrJson(output);
    const newPaneId = extractPaneId(json);
    if (newPaneId) {
      state.panes.push(newPaneId);
      state.pos++;
      writeFileSync(markerFile, JSON.stringify(state));
      herdrPaneSources.set(newPaneId, sourcePane);
      renameHerdrPane(newPaneId, name);
      herdrLog(
        `[herdr split] mode=next pos=${state.pos - 1} base=${state.base} dir=${state.dir} from=${targetPane} new=${newPaneId} name=${JSON.stringify(name)}\n`,
      );
      return newPaneId;
    }
    herdrLog(`[herdr split] next split returned no pane id, output=${JSON.stringify(output)}\n`);
    return "";
  } finally {
    try {
      rmSync(lockFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 从指定 pane 直接分屏（不走广度优先状态机），供 createSurfaceSplit 使用。
 * herdr 文档仅明确 right/down，left/up 分别归一到 right/down。
 * 返回新 pane 的公开 id；识别失败时抛错。
 */
export function splitHerdrPane(
  fromPane: string,
  direction: "left" | "right" | "up" | "down",
  name?: string,
): string {
  const dir = direction === "down" || direction === "up" ? "down" : "right";
  const output = herdrExec(["pane", "split", fromPane, "--direction", dir, "--no-focus"]);
  const newPaneId = extractPaneId(parseHerdrJson(output));
  if (!newPaneId) {
    throw new Error(`Unexpected herdr pane split output: ${output.trim() || "(empty)"}`);
  }
  herdrPaneSources.set(newPaneId, fromPane);
  if (name) renameHerdrPane(newPaneId, name);
  herdrLog(
    `[herdr split] mode=direct dir=${dir} from=${fromPane} new=${newPaneId} name=${JSON.stringify(name ?? "")}\n`,
  );
  return newPaneId;
}

/**
 * 用 herdr CLI 重命名 pane 的 label（pane 名称）。
 * 格式: workspace_label[name]
 */
export function renameHerdrPane(paneId: string, name: string): void {
  try {
    const wsLabel = getWorkspaceLabel();
    const paneLabel = wsLabel ? `${wsLabel}[${name}]` : name;
    herdrExecSilent(["pane", "rename", paneId, paneLabel]);
  } catch (e) {
    herdrLog(`[herdr rename pane] pane=${paneId} name=${JSON.stringify(name)} failed: ${(e as Error).message}\n`);
  }
}

/**
 * 用 herdr CLI 重命名 agent 标题（左侧侧栏显示的名字）。
 * 需要在 pi 启动并被 herdr 检测到 agent 后才能生效。
 * 若 agent 尚未检测到则静默失败。
 */
export function renameHerdrAgent(paneId: string, name: string): void {
  try {
    herdrExecSilent(["agent", "rename", paneId, name]);
  } catch (e) {
    herdrLog(`[herdr rename agent] pane=${paneId} name=${JSON.stringify(name)} failed: ${(e as Error).message}\n`);
  }
}

/**
 * 获取当前 workspace 的 label。
 */
function getWorkspaceLabel(): string | null {
  if (!AGENT_HERDR_WORKSPACE_ID) return null;
  try {
    const output = herdrExec(["workspace", "get", AGENT_HERDR_WORKSPACE_ID]);
    const parsed = parseHerdrJson(output);
    if (!parsed || typeof parsed !== "object") return null;
    const result = (parsed as Record<string, unknown>).result as Record<string, unknown> | undefined;
    const workspace = result?.workspace as Record<string, unknown> | undefined;
    return (workspace?.label as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * 用 herdr CLI 重命名 pane 对应的 tab。
 * tab label 格式: workspace_label[name]
 */
export function renameHerdrTab(paneId: string, name: string): void {
  const ws = parseWorkspaceIdFromPaneId(paneId);
  if (!ws) return;
  try {
    const wsLabel = getWorkspaceLabel();
    const tabLabel = wsLabel ? `${wsLabel}[${name}]` : name;
    const tabsJson = herdrExec(["tab", "list", "--workspace", ws]);
    const parsed = parseHerdrJson(tabsJson);
    if (!parsed || typeof parsed !== "object") return;
    const result = (parsed as Record<string, unknown>).result as Record<string, unknown> | undefined;
    const tabs = (result?.tabs as Array<Record<string, unknown>>) ?? [];
    if (tabs.length > 0) {
      const firstTab = tabs[0];
      if (firstTab && typeof firstTab.tab_id === "string") {
        herdrExecSilent(["tab", "rename", firstTab.tab_id, tabLabel]);
      }
    }
  } catch (e) {
    herdrLog(`[herdr rename tab] pane=${paneId} name=${JSON.stringify(name)} failed: ${(e as Error).message}\n`);
  }
}

/**
 * 重命名 workspace。herdr 中 workspace rename 命令是 `herdr workspace rename <id> <label>`。
 * 仅当环境变量 PI_SUBAGENT_RENAME_HERDR_WORKSPACE=1 时启用（保守策略，避免影响用户命名）。
 */
export function renameHerdrWorkspace(title: string): void {
  if (process.env.PI_SUBAGENT_RENAME_HERDR_WORKSPACE !== "1") return;
  if (!AGENT_HERDR_WORKSPACE_ID) return;
  try {
    herdrExecSilent(["workspace", "rename", AGENT_HERDR_WORKSPACE_ID, title]);
  } catch (e) {
    herdrLog(`[herdr rename workspace] title=${JSON.stringify(title)} failed: ${(e as Error).message}\n`);
  }
}

// ── 对外 API：pane 操作 ──

/**
 * 给 pane 发送命令 + Enter。
 * 使用 `herdr pane run <id> <cmd>` 一条命令搞定（SKILL.md 保证会发真实 Enter）。
 */
export function sendHerdrCommand(paneId: string, command: string): void {
  herdrExecSilent(["pane", "run", paneId, command]);
}

/**
 * 给 pane 发送 Escape。
 * `herdr pane send-keys <id> Escape`（SKILL.md 中 send-keys 接受 "Escape" 这种 key name）。
 */
export function sendHerdrEscape(paneId: string): void {
  herdrExecSilent(["pane", "send-keys", paneId, "Escape"]);
}

/**
 * 读取 pane 屏幕内容。
 * SKILL.md：`herdr pane read <id> --source <src> --lines N` 直接打印文本（非 JSON）。
 *
 * 默认 source 用 `visible`，与其他 backend (cmux / wezterm) 的 readScreen 语义一致：
 * 读当前 viewport，新 pane 没 scrollback 时不会返回空。
 *
 * wait output 机制如果需要 recent_unwrapped 语义，请另行包装 — 这里只服务 subagent
 * 状态检测和实时读屏，不需要 soft-wrap 合并。
 */
export function readHerdrScreen(paneId: string, lines = 50, source: "visible" | "recent" | "recent_unwrapped" = "visible"): string {
  // SKILL.md 列出的 source 选项
  const sourceFlag = source === "recent_unwrapped" ? "recent-unwrapped" : source;
  return herdrExec(["pane", "read", paneId, "--source", sourceFlag, "--lines", String(lines)]);
}

/**
 * 关闭 pane。
 * `herdr pane close <id>` 是 herdr CLI 子命令。
 */
export function closeHerdrSurface(paneId: string): void {
  herdrExecSilent(["pane", "close", paneId]);

  // 清理 mux state marker（与 muxy 的 close 逻辑一致）
  const markerFile = `/tmp/herdr-subagent-pane-${(AGENT_HERDR_PANE_ID ?? "default").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
  try {
    const parsed = JSON.parse(readFileSync(markerFile, "utf8"));
    if (parsed && Array.isArray(parsed.panes)) {
      const idx = parsed.panes.indexOf(paneId);
      if (idx >= 0) {
        const beforePanes = [...parsed.panes];
        const beforePos = parsed.pos;
        parsed.panes.splice(idx, 1);
        if (typeof parsed.pos === "number" && idx < parsed.pos) {
          parsed.pos = Math.max(0, parsed.pos - 1);
        }
        if (parsed.panes.length === 0) {
          rmSync(markerFile);
          herdrLog(
            `[herdr close] pane=${paneId} panes=${JSON.stringify(beforePanes)} -> [] pos=${beforePos} -> <marker-removed>\n`,
          );
        } else {
          writeFileSync(markerFile, JSON.stringify(parsed));
          herdrLog(
            `[herdr close] pane=${paneId} panes=${JSON.stringify(beforePanes)} -> ${JSON.stringify(parsed.panes)} pos=${beforePos} -> ${parsed.pos}\n`,
          );
        }
      } else {
        herdrLog(`[herdr close] pane=${paneId} (not in marker state.panes)\n`);
      }
    }
  } catch {
    herdrLog(`[herdr close] pane=${paneId} (no marker, nothing to clean)\n`);
  }
  herdrPaneSources.delete(paneId);
}

// ── 辅助：从 pane id 解析 workspace id ──
//
// herdr 公开 id 格式：
//   workspace: "1", "2" 或 "wA"
//   tab:      "1:1", "wA:t1"
//   pane:     "1-1", "wA-3", "wA:p3"
//
// pane id 的 workspace 段总是位于 "-" 或 ":p" 之前。
function parseWorkspaceIdFromPaneId(paneId: string): string | null {
  // "1-1" -> "1", "wA-3" -> "wA", "wA:p3" -> "wA"
  const dashMatch = paneId.match(/^([^-:]+)-/);
  if (dashMatch) return dashMatch[1] ?? null;
  const colonMatch = paneId.match(/^([^:]+):p/);
  if (colonMatch) return colonMatch[1] ?? null;
  return null;
}

// ── 与 mux 检测 / setup hint 的集成辅助 ──

/**
 * herdr setup hint —— 用户没在 herdr pane 内时提示。
 */
export function herdrSetupHint(preferred: boolean): string {
  if (preferred) {
    return i18n.t("setupHint.herdrPreferred");
  }
  return "";
}