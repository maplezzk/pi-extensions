/**
 * types.ts — 内部 BackendOps 接口（不对外导出）
 *
 * 每个终端后端导出 const ops: BackendOps，由 surface.ts 注册到
 * Record<MuxBackend, BackendOps> 实现全键派发。
 */

/**
 * 分屏 options（后端特有能力提示，非后端忽略）。
 * activate 仅供 wezterm 使用：split 成功后调用 activate-pane 聚焦新 pane；默认 false 保持当前焦点。
 */
export interface CreateSplitOptions {
  /** 是否激活新创建的 pane（仅 wezterm 支持，默认 false） */
  activate?: boolean;
}

/**
 * 后端 per-surface 操作接口（内部契约，不进 index.ts）。
 * create / createSplit / send / sendEscape / read / readAsync / close / rename
 * 八个方法，覆盖统一 surface API 的常见操作。
 */
export interface BackendOps {
  /** 创建新 surface（智能放置，如分屏/堆叠/新 tab） */
  create(name: string): string;
  /**
   * 指定方向分屏创建新 surface。fromSurface 第 3 参、options 第 4 参均为可选尾部参数；
   * 该签名由统一 surface API 的向后兼容要求强制（旧 3 参调用保持类型与行为不变）：
   * 仓库现有调用点 pi-interactive-subagents/test/integration/harness.ts 仍以
   * createSurfaceSplit(name, direction, fromSurface) 三位置参调用，options 只能作为第 4 个尾部参数追加。
   * 故按外部 API 兼容签名豁免参数数量约束。
   */
  createSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string, options?: CreateSplitOptions): string;
  /** 向 surface 发送命令字符串并执行 */
  send(surface: string, command: string): void;
  /** 向 surface 发送 Escape 按键 */
  sendEscape(surface: string): void;
  /** 同步读取 surface 屏幕最后 N 行 */
  read(surface: string, lines?: number): string;
  /** 异步读取 surface 屏幕最后 N 行 */
  readAsync(surface: string, lines?: number): Promise<string>;
  /** 关闭 surface */
  close(surface: string): void;
  /** 重命名 surface */
  rename(surface: string, name: string): void;
}
