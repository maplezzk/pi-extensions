/**
 * orca.ts — orca 后端 barrel（向后兼容 subpath 导入）
 *
 * 所有实现已迁至 backends/orca.ts，此文件仅做 re-export。
 * 显式列出符号（不用 export *），避免内部 BackendOps 适配器 ops 泄漏到公开 API。
 */

export {
  AGENT_ORCA_TERMINAL_HANDLE,
  closeOrcaSurface,
  createOrcaSurface,
  extractOrcaCreateHandle,
  extractOrcaReadTail,
  extractOrcaSplitHandle,
  isOrcaRuntimeAvailable,
  orcaSplitDirection,
  parseOrcaJson,
  readOrcaScreen,
  renameOrcaTerminal,
  sendOrcaCommand,
  sendOrcaEscape,
  splitOrcaTerminal,
} from "./backends/orca.ts";
export type { OrcaEnvelope } from "./backends/orca.ts";
