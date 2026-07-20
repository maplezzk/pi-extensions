/**
 * herdr.ts — herdr 后端 barrel（向后兼容 subpath 导入）
 *
 * 所有实现已迁至 backends/herdr.ts，此文件仅做 re-export。
 * 显式列出符号（不用 export *），避免内部 BackendOps 适配器 ops 泄漏到公开 API。
 */

export {
  AGENT_HERDR_PANE_ID,
  AGENT_HERDR_TAB_ID,
  AGENT_HERDR_WORKSPACE_ID,
  closeHerdrSurface,
  createHerdrSurface,
  herdrSetupHint,
  isHerdrRuntimeAvailable,
  readHerdrScreen,
  renameHerdrAgent,
  renameHerdrPane,
  renameHerdrTab,
  renameHerdrWorkspace,
  sendHerdrCommand,
  sendHerdrEscape,
  splitHerdrPane,
} from "./backends/herdr.ts";
