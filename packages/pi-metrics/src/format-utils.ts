/**
 * 指标格式化纯函数
 *
 * 抽离为独立模块便于单元测试（仓库门禁要求测试确定性、不依赖 Pi 运行时），
 * 同时供 turn-elapsed、tps 和 run-summary 共用，避免循环依赖。
 */

const MS_PER_SECOND = 1_000;
const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

const TOKEN_DECIMAL_PLACES = 1;
/** 整数值的 1 位小数形式；命中时改回整数显示（2K 而不是 2.0K）。 */
const ZERO_DECIMAL_SUFFIX = ".0";
const DURATION_DECIMAL_PLACES = 1;
const RATE_DECIMAL_PLACES = 2;

/**
 * 耗时单位表：label、该单位秒数、以及只显示一个单位时要补的次一级单位。
 * 年和月跳过「周」，直接补「天」，因为「1y 0w」没有信息量。
 */
const DURATION_UNITS: ReadonlyArray<readonly [string, number, string | null]> = [
  ["y", YEAR, "d"],
  ["mo", MONTH, "d"],
  ["w", WEEK, "d"],
  ["d", DAY, "h"],
  ["h", HOUR, "m"],
  ["m", MINUTE, "s"],
  ["s", SECOND, null],
];

/** working 期间：紧凑格式（秒级 / 分秒） */
export function formatTick(ms: number): string {
  const totalSec = Math.floor(ms / MS_PER_SECOND);
  if (totalSec < MINUTE) return `${totalSec}s`;
  const m = Math.floor(totalSec / MINUTE);
  const s = totalSec % MINUTE;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** turn_end / agent_settled：精确格式（1 位小数） */
export function formatDone(ms: number): string {
  const sec = ms / MS_PER_SECOND;
  if (sec < MINUTE) return `${sec.toFixed(DURATION_DECIMAL_PLACES)}s`;
  const m = Math.floor(sec / MINUTE);
  const s = sec - m * MINUTE;
  return `${m}m ${s.toFixed(DURATION_DECIMAL_PLACES)}s`;
}

/** token 数的紧凑显示：1.2K / 2M / 1.5B。 */
export function formatNumber(num: number): string {
  if (num < THOUSAND) return String(num);

  const [value, suffix] = num >= BILLION
    ? [num / BILLION, "B"]
    : num >= MILLION
      ? [num / MILLION, "M"]
      : [num / THOUSAND, "K"];
  const formatted = value.toFixed(TOKEN_DECIMAL_PLACES);
  return formatted.endsWith(ZERO_DECIMAL_SUFFIX) ? `${value.toFixed(0)}${suffix}` : `${formatted}${suffix}`;
}

/** 耗时的宽松显示：最多两个单位（如 1m 0s、1mo 0d）。 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < MINUTE) return `${totalSeconds.toFixed(DURATION_DECIMAL_PLACES)}s`;

  const parts: Array<{ value: number; label: string }> = [];
  let remaining = Math.round(totalSeconds);

  for (const [label, seconds] of DURATION_UNITS) {
    if (remaining >= seconds) {
      parts.push({ value: Math.floor(remaining / seconds), label });
      remaining %= seconds;
    }
  }

  if (parts.length === 1) {
    const companion = DURATION_UNITS.find(([label]) => label === parts[0].label)?.[2];
    if (companion) parts.push({ value: 0, label: companion });
  }

  return parts.slice(0, 2).map(({ value, label }) => `${value}${label}`).join(" ");
}

/** 由成本（美元）和 token 数折算每百万 token 的费率；数据不可用时返回 null。 */
export function computeRateUsdPerM(costUsd: number | null, totalTokens: number): number | null {
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) return null;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  const rate = costUsd / (totalTokens / MILLION);
  if (!Number.isFinite(rate) || rate < 0) return null;
  const scale = 10 ** RATE_DECIMAL_PLACES;
  return Math.round(rate * scale) / scale;
}
