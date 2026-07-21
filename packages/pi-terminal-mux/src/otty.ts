/**
 * otty.ts — otty 后端 barrel（向后兼容 subpath 导入）
 *
 * 所有实现已迁至 backends/otty.ts，此文件仅做 re-export。
 * 显式列出符号（不用 export *），避免内部 BackendOps 适配器 ops 泄漏到公开 API。
 */

export {
  AGENT_OTTY_PANE_ID,
  closeOttySurface,
  createOttySurface,
  getOttyAgentPaneId,
  getTabIdForPane,
  isOttyRuntimeAvailable,
  isOttySendKeysEnabled,
  type OttyPaneSnapshot,
  ottySetupHint,
  parseOttyJson,
  readOttyPanes,
  readOttyScreen,
  readOttyTabs,
  renameOttyTab,
  sendOttyCommand,
  sendOttyEscape,
} from "./backends/otty.ts";
