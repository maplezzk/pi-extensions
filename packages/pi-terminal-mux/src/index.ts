/**
 * pi-terminal-mux — 终端多路复用器统一抽象层
 *
 * 支持后端：muxy / cmux / tmux / zellij / wezterm / herdr / otty，
 * 探测不到任何后端时自动降级为 headless（后台子进程 + 日志文件）。
 *
 * 统一 surface API（跨后端一致语义）：
 *   - createSurface(name)              智能放置（分屏/堆叠/新 tab，按后端策略）
 *   - createSurfaceSplit(name, dir, from?)  指定方向分屏
 *   - sendCommand / sendLongCommand / sendEscape
 *   - readScreen / readScreenAsync
 *   - closeSurface
 *   - renameCurrentTab / renameAgent / renameWorkspace
 *   - pollForExit                      等待 surface 内进程退出（.exit sidecar / sentinel）
 *
 * 后端探测：
 *   - getMuxBackend()                  当前命中的后端（含 PI_TERMINAL_MUX / PI_SUBAGENT_MUX 偏好）
 *   - isMuxAvailable() / isHeadlessMode()
 *   - muxSetupHint()                   面向用户的安装提示（中英文，走 pi-extensions-i18n）
 *
 * 各后端原生函数（createHerdrSurface、sendOttyCommand 等）也可按需直接引用。
 */

// ── 统一抽象层（含类型与 headless 降级） ──
export * from "./mux.ts";

// ── herdr 后端原生 API（renameHerdrTab / renameHerdrWorkspace 已由 mux.ts 透出，避免冲突） ──
export {
  AGENT_HERDR_PANE_ID,
  AGENT_HERDR_WORKSPACE_ID,
  AGENT_HERDR_TAB_ID,
  isHerdrRuntimeAvailable,
  createHerdrSurface,
  splitHerdrPane,
  renameHerdrPane,
  renameHerdrAgent,
  sendHerdrCommand,
  sendHerdrEscape,
  readHerdrScreen,
  closeHerdrSurface,
  herdrSetupHint,
} from "./herdr.ts";

// ── otty 后端原生 API ──
export {
  AGENT_OTTY_PANE_ID,
  getOttyAgentPaneId,
  isOttyRuntimeAvailable,
  isOttySendKeysEnabled,
  parseOttyJson,
  readOttyPanes,
  readOttyTabs,
  getTabIdForPane,
  createOttySurface,
  sendOttyCommand,
  sendOttyEscape,
  readOttyScreen,
  closeOttySurface,
  renameOttyTab,
  ottySetupHint,
} from "./otty.ts";
export type { OttyPaneSnapshot } from "./otty.ts";

// ── 便捷函数 ──
import {
  AGENT_MUXY_PANE_ID,
  getMuxBackend,
  type MuxBackend,
} from "./mux.ts";
import { AGENT_HERDR_PANE_ID } from "./herdr.ts";
import { AGENT_OTTY_PANE_ID } from "./otty.ts";

/**
 * 返回各后端注入 agent pane 标识的环境变量名（用于错误提示）。
 * otty 不通过 env 注入（走 IPC 探测），返回 null。
 */
export function backendAgentPaneEnvVar(backend: MuxBackend): string | null {
  switch (backend) {
    case "muxy":
      return "MUXY_PANE_ID";
    case "cmux":
      return "CMUX_SURFACE_ID";
    case "tmux":
      return "TMUX_PANE";
    case "zellij":
      return "ZELLIJ_PANE_ID";
    case "wezterm":
      return "WEZTERM_PANE";
    case "herdr":
      return "HERDR_PANE_ID";
    case "otty":
      return null;
  }
}

/**
 * 返回 agent 自身所在 pane 的标识（按当前或指定后端）。
 * muxy/herdr/otty 使用模块加载时捕获的 ID（不受焦点切换影响），
 * 其余后端动态读取对应环境变量。
 */
export function getAgentPaneId(backend?: MuxBackend | null): string | null {
  const resolved = backend ?? getMuxBackend();
  if (resolved === "muxy") return AGENT_MUXY_PANE_ID ?? null;
  if (resolved === "herdr") return AGENT_HERDR_PANE_ID ?? null;
  if (resolved === "otty") return AGENT_OTTY_PANE_ID ?? null;
  if (resolved === "tmux") return process.env.TMUX_PANE ?? null;
  if (resolved === "wezterm") return process.env.WEZTERM_PANE ?? null;
  if (resolved === "zellij") return process.env.ZELLIJ_PANE_ID ?? null;
  if (resolved === "cmux") return process.env.CMUX_SURFACE_ID ?? null;
  return null;
}
