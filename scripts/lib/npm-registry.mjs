/**
 * npm-registry.mjs — 供各 npm 相关 CI 门禁脚本共享的 registry 查询辅助。
 *
 * 纯函数：只返回查询结果，不产生副作用（告警由调用方自行记录），便于复用与测试。
 */

export const REGISTRY = "https://registry.npmjs.org";

/** registry 查询超时（毫秒） */
const FETCH_TIMEOUT_MS = 10_000;

/** 本仓库已知的 npm 维护者用户名 */
export const KNOWN_MAINTAINERS = ["maplezzk"];

/**
 * 查询某个包名的 npm registry 元数据。
 * @param {string} name 包名（支持 scope）
 * @returns {Promise<{ status: 'available' | 'timeout' | 'published', data?: object }>}
 *   - available: 404，名字尚未被发布（可首发）
 *   - timeout:   网络超时，调用方应跳过本次检查
 *   - published: 已发布，data 为完整 registry 元数据（含 maintainers / versions / dist-tags）
 */
export async function fetchNpmInfo(name) {
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return { status: "available" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: "published", data: await res.json() };
  } catch (err) {
    if (err.name === "TimeoutError") return { status: "timeout" };
    throw err;
  }
}

/**
 * 比较两个语义化版本 a 是否大于 b（仅比较核心数字段，忽略预发布标签）。
 * 适用于本仓库常见的 "1.1.0" / "0.2.2" / "3.8.0" 形式；预发布版本按核心段比较。
 * @param {string} a
 * @param {string} b
 * @returns {boolean} a > b
 */
export function semverGreater(a, b) {
  const parse = (v) =>
    String(v)
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}
