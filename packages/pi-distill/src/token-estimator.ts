/**
 * 展示用 token 估算。跨模型没有通用的精确 tokenizer（实测误差 24%~65%），
 * Anthropic 官方 JS 包的词表也停留在 Claude 2 时代，所以不引入第三方
 * tokenizer 依赖，统一使用分段启发式：
 *
 * - CJK、假名、谚文和全角字符：现代 BPE 分词器通常每字 1 token；
 * - 其余字符：约 4 字符 1 token（与 Pi 的 chars/4 规则一致）。
 *
 * 相比纯 chars/4，中文内容不再被低估约 4 倍。
 */

/** 现代 BPE 分词器通常按单字编码的 Unicode 区间（CJK/假名/谚文/全角）。 */
const DENSE_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x9fff], // CJK 部首补充、假名、CJK 统一表意文字等
  [0xac00, 0xd7af], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xff00, 0xffef], // 全角字符
  [0x20000, 0x2fa1f], // CJK 扩展 B–F 及兼容补充（代理对区间）
];

/** 判断码点是否属于 dense script 区间（这些文字通常每字 1 token）。 */
function isDenseScript(codePoint: number): boolean {
  return DENSE_SCRIPT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

const ASCII_CHARS_PER_TOKEN = 4;

/**
 * 分段启发式估算 token 数：dense script 字符按 1 token/字，其余按
 * 4 字符 1 token。结果是展示用估算值，不保证与任何具体模型 tokenizer 一致。
 */
export function estimateHeuristicTokens(text: string): number {
  let dense = 0;
  let rest = 0;
  for (const char of text) {
    if (isDenseScript(char.codePointAt(0) ?? 0)) dense += 1;
    else rest += 1;
  }
  return dense + Math.ceil(rest / ASCII_CHARS_PER_TOKEN);
}
