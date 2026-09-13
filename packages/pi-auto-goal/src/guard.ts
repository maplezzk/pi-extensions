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

/**
 * 可以判定的模型结束原因：agent（或输出长度限制）让这一轮正常跑完。
 * stop 是 agent 自己结束本轮，length 是输出被长度上限截断；
 * 其余取值（aborted/error/toolUse/缺失）都表示这一轮没跑完，
 * 此时去判定「是否提前停止」会把用户的主动打断或请求失败当成 agent 的决定。
 */
export const JUDGEABLE_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length"]);

/**
 * 这一轮的结束原因是否值得判定。
 * 只依据结束原因，不猜测其它上下文，便于确定性测试。
 */
export function isJudgeableStopReason(stopReason: string | undefined): boolean {
  return stopReason !== undefined && JUDGEABLE_STOP_REASONS.has(stopReason);
}
