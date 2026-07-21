/**
 * types.ts — 内部 BackendOps 接口（不对外导出）
 *
 * 每个终端后端导出 const ops: BackendOps，由 surface.ts 注册到
 * Record<MuxBackend, BackendOps> 实现全键派发。
 */

/**
 * 后端 per-surface 操作接口（内部契约，不进 index.ts）。
 * create / createSplit / send / sendEscape / read / readAsync / close / rename
 * 八个方法，覆盖统一 surface API 的常见操作。
 */
export interface BackendOps {
  /** 创建新 surface（智能放置，如分屏/堆叠/新 tab） */
  create(name: string): string;
  /** 指定方向分屏创建新 surface */
  createSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string;
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
