import { i18n } from "./i18n.ts";
import type { SafetyConfigDocument } from "./config.ts";
import type { RuleMatch, SafetyConfig, SafetyRule } from "./types.ts";

/** 匹配器标签保持配置文件里的字段名，方便对着 JSON 文件读。 */
const MATCH_LABEL = {
  commands: "commands",
  commandPrefixes: "commandPrefixes",
  commandPattern: "commandPattern",
  outsideRoots: "outsideRoots",
  module: "module",
} as const;

/** 把匹配器压成一行；值按 JSON 里的原样展示，不翻译字段名。 */
export function describeMatch(match: RuleMatch): string {
  if ("commands" in match) return `${MATCH_LABEL.commands}: ${match.commands.join(", ")}`;
  if ("commandPrefixes" in match) return `${MATCH_LABEL.commandPrefixes}: ${match.commandPrefixes.join(", ")}`;
  if ("commandPattern" in match) return `${MATCH_LABEL.commandPattern}: ${match.commandPattern}`;
  if ("outsideRoots" in match) return `${MATCH_LABEL.outsideRoots}: [${match.outsideRoots.join(", ")}]`;
  return `${MATCH_LABEL.module}: ${match.module}`;
}

/** 按 ID 索引最终生效的规则，展示时用编译后的动作和匹配器。 */
function effectiveById(config: SafetyConfig): Map<string, SafetyRule> {
  return new Map(config.rules.map((rule) => [rule.id, rule]));
}

/** 读取规则条目的 ID；条目已在配置解析阶段校验，这里只做安全收窄。 */
function entryId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  if (!("id" in entry) || typeof entry.id !== "string") return undefined;
  return entry.id.trim();
}

/** 判断规则条目是否被 enabled: false 关掉。 */
function isDisabled(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return "enabled" in entry && entry.enabled === false;
}

/** 一行规则：id → 动作 · 匹配器；停用的规则只显示状态。 */
function ruleLine(id: string, rule: SafetyRule | undefined): string {
  if (rule === undefined) return i18n.t("configShowDisabled", { id });
  return i18n.t("configShowRule", { id, action: rule.action, match: describeMatch(rule.match) });
}

/** 生成“当前生效规则”的多行说明：按配置文件里的顺序列出，停用的单独标注。 */
export function describeEffectiveRules(document: SafetyConfigDocument, config: SafetyConfig): string[] {
  const effective = effectiveById(config);
  const lines: string[] = [];
  for (const entry of document.rules) {
    const id = entryId(entry);
    if (id === undefined) continue;
    lines.push(ruleLine(id, isDisabled(entry) ? undefined : effective.get(id)));
  }
  return lines;
}
