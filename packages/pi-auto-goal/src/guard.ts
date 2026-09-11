/**
 * 自动干预预算：同一条用户请求允许自动催停的次数上限。
 *
 * 纯函数模块，便于对「到达上限」的分支做确定性测试。
 */

/** 上限配置值 0 表示不限制次数。 */
export const UNLIMITED_CONTINUES = 0;

/**
 * 是否还剩自动干预额度。
 * limit 为 0 时表示不限制；used 达到 limit 后不再干预，交由用户决定下一步。
 */
export function hasContinueBudget(limit: number, used: number): boolean {
  if (limit <= UNLIMITED_CONTINUES) return true;
  return used < limit;
}

/** 预算文案：用完时报告已用次数与上限，供 UI 提示复用。 */
export function formatBudget(limit: number, used: number): string {
  return limit <= UNLIMITED_CONTINUES ? `${used}/∞` : `${used}/${limit}`;
}
