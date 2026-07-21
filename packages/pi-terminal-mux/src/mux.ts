/**
 * mux.ts — 统一抽象层 barrel（向后兼容 ./mux subpath 导入）
 *
 * 所有实现已拆分到 detection / headless / shell / surface / backends 模块，
 * 此文件仅做 re-export，保持对外导出符号集合不变。
 */

// ── 共享基础设施模块 ──
export {
  type MuxBackend,
  getMuxBackend,
  isMuxAvailable,
  muxSetupHint,
  muxLog,
  AGENT_MUXY_PANE_ID,
  isCmuxAvailable,
  isTmuxAvailable,
  isZellijAvailable,
  isWezTermAvailable,
  isHerdrAvailable,
  isOttyAvailable,
} from "./detection.ts";

export {
  createHeadlessSurface,
  spawnHeadlessProcess,
  closeHeadlessSurface,
  sendHeadlessEscape,
  readHeadlessScreen,
  readHeadlessScreenAsync,
  isHeadlessSurface,
  isHeadlessMode,
  cleanupHeadlessProcesses,
  getHeadlessProcessExit,
  drainHeadlessProcess,
} from "./headless.ts";

export { isFishShell, shellEscape, exitStatusVar } from "./shell.ts";

// ── 统一 surface API ──
export {
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendEscape,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  renameSurface,
  renameAgent,
  renameCurrentTab,
  renameWorkspace,
  pollForExit,
  getLastSplitSource,
  clearLastSplitSource,
} from "./surface.ts";
export type { PollResult } from "./surface.ts";

// ── Cmux 公开解析函数 ──
export {
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
} from "./backends/cmux.ts";

// ── Zellij 公开类型与放置规划 ──
export {
  type ZellijPaneSnapshot,
  type ZellijSplitDirection,
  type ZellijPlacementPlan,
  predictZellijSplitDirection,
  canSplitZellijPane,
  selectZellijPlacement,
  selectZellijStackPlacement,
} from "./backends/zellij.ts";

// ── Herdr / Otty 后端原生符号（经 backends 透出，维持原路径） ──
export {
  renameHerdrTab,
  renameHerdrWorkspace,
} from "./backends/herdr.ts";
