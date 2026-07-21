/**
 * 耗时格式化纯函数
 *
 * 抽离为独立模块便于单元测试（仓库门禁要求测试确定性、不依赖 Pi 运行时）。
 */

/** working 期间：紧凑格式（秒级 / 分秒） */
export function formatTick(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** turn_end / agent_settled：精确格式（1 位小数） */
export function formatDone(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}m ${s.toFixed(1)}s`;
}
