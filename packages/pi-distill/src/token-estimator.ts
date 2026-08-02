import { createRequire } from "node:module";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/token-estimator.json", import.meta.url)));

export const TOKEN_ESTIMATOR_KINDS = ["heuristic", "claude", "cl100k"] as const;
export type TokenEstimatorKind = (typeof TOKEN_ESTIMATOR_KINDS)[number];

export const DEFAULT_TOKEN_ESTIMATOR: TokenEstimatorKind = "heuristic";

export type TokenEstimator = {
  kind: TokenEstimatorKind;
  /** 精确估算器不可用时的降级说明；heuristic 或加载成功时为 undefined。 */
  fallbackWarning?: string;
  countTokens(text: string): number;
};

/**
 * 现代 BPE 分词器（cl100k/o200k/Claude/Qwen 等）对 CJK、假名、谚文和全角
 * 字符通常每字 1 token，而 chars/4 会把中文低估约 4 倍。
 */
function isDenseScript(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
  );
}

const ASCII_CHARS_PER_TOKEN = 4;

export function estimateHeuristicTokens(text: string): number {
  let dense = 0;
  let rest = 0;
  for (const char of text) {
    if (isDenseScript(char.codePointAt(0) ?? 0)) dense += 1;
    else rest += 1;
  }
  return dense + Math.ceil(rest / ASCII_CHARS_PER_TOKEN);
}

type TokenCounter = (text: string) => number;

const OPTIONAL_ESTIMATOR_PACKAGES: Record<
  Exclude<TokenEstimatorKind, "heuristic">,
  { packageName: string; load(): TokenCounter }
> = {
  claude: {
    packageName: "@anthropic-ai/tokenizer",
    load() {
      const require = createRequire(import.meta.url);
      const module = require("@anthropic-ai/tokenizer") as { countTokens: TokenCounter };
      return (text) => module.countTokens(text);
    },
  },
  cl100k: {
    packageName: "js-tiktoken",
    load() {
      const require = createRequire(import.meta.url);
      const module = require("js-tiktoken") as {
        getEncoding(name: string): { encode(text: string): number[] };
      };
      const encoding = module.getEncoding("cl100k_base");
      return (text) => encoding.encode(text).length;
    },
  },
};

const estimatorCache = new Map<TokenEstimatorKind, TokenEstimator>();

/**
 * 创建 token 估算器。heuristic 零依赖；claude/cl100k 需要对应的可选依赖，
 * 缺失时降级为 heuristic 并通过 fallbackWarning 明确告知，不静默吞掉。
 */
export function createTokenEstimator(
  kind: TokenEstimatorKind = DEFAULT_TOKEN_ESTIMATOR,
): TokenEstimator {
  const cached = estimatorCache.get(kind);
  if (cached) return cached;

  let estimator: TokenEstimator;
  if (kind === "heuristic") {
    estimator = { kind, countTokens: estimateHeuristicTokens };
  } else {
    const optional = OPTIONAL_ESTIMATOR_PACKAGES[kind];
    try {
      estimator = { kind, countTokens: optional.load() };
    } catch {
      estimator = {
        kind,
        fallbackWarning: i18n.t("estimatorFallback", { kind, packageName: optional.packageName }),
        countTokens: estimateHeuristicTokens,
      };
    }
  }
  estimatorCache.set(kind, estimator);
  return estimator;
}

/** 仅供测试：清空估算器缓存。 */
export function resetTokenEstimatorCache(): void {
  estimatorCache.clear();
}
