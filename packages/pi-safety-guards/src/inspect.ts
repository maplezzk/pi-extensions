import { i18n } from "./i18n.ts";
import type { SafetyConfigDocument } from "./config.ts";
import type { PresetCatalog } from "./presets.ts";
import type { RuleMatch, SafetyConfig, SafetyRule } from "./types.ts";

/** 匹配器标签保持配置文件里的字段名，方便对着 JSON 文件读。 */
const MATCH_LABEL = {
  commands: "commands",
  detector: "detector",
  outsideRoots: "outsideRoots",
  module: "module",
} as const;

/** 把匹配器压成一行；只做展示，不翻译字段名。 */
export function describeMatch(match: RuleMatch): string {
  if ("commands" in match) return `${MATCH_LABEL.commands}: ${match.commands.join(", ")}`;
  if ("detector" in match) return `${MATCH_LABEL.detector}: ${match.detector}`;
  if ("outsideRoots" in match) return `${MATCH_LABEL.outsideRoots}: [${match.outsideRoots.join(", ")}]`;
  return `${MATCH_LABEL.module}: ${match.module}`;
}

/** 按 ID 索引最终生效的规则，展示时用合并后的动作和匹配器。 */
function effectiveById(config: SafetyConfig): Map<string, SafetyRule> {
  return new Map(config.rules.map((rule) => [rule.id, rule]));
}

/** 读取覆盖条目的 ID；条目已在配置解析阶段校验，这里只做安全收窄。 */
function entryId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  if (!("id" in entry) || typeof entry.id !== "string") return undefined;
  return entry.id.trim();
}

/** 判断覆盖条目是否显式关闭了规则。 */
function isDisabled(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return "enabled" in entry && entry.enabled === false;
}

/** 一行规则：id → 动作 · 匹配器；被 rules 覆盖、已停用都会标注。 */
function ruleLine(id: string, rule: SafetyRule | undefined, overridden: boolean): string {
  if (rule === undefined) return i18n.t("configShowDisabled", { id });
  const params = { id, action: rule.action, match: describeMatch(rule.match) };
  return i18n.t(overridden ? "configShowOverride" : "configShowRule", params);
}

/**
 * 生成“当前生效规则”的多行说明：先按预设分组，再列出只来自 rules 的条目。
 * 展示以最终合并结果为准，同时标出哪些预设规则被用户覆盖或停用。
 */
export function describeEffectiveRules(
  document: SafetyConfigDocument,
  presets: PresetCatalog,
  config: SafetyConfig,
): string[] {
  const effective = effectiveById(config);
  const overrideIds = new Set(document.rules.map(entryId).filter((id): id is string => id !== undefined));
  const lines: string[] = [];
  const fromPresets = new Set<string>();
  for (const name of document.presets) {
    const rules = presets[name];
    if (!rules) continue;
    lines.push(i18n.t("configShowPreset", { name, count: rules.length }));
    for (const rule of rules) {
      fromPresets.add(rule.id);
      lines.push(ruleLine(rule.id, effective.get(rule.id), overrideIds.has(rule.id)));
    }
  }
  const custom = document.rules.filter((entry) => {
    const id = entryId(entry);
    return id === undefined || !fromPresets.has(id);
  });
  if (custom.length === 0) return lines;
  lines.push(i18n.t("configShowCustom", { count: custom.length }));
  for (const entry of custom) {
    const id = entryId(entry);
    if (id === undefined) continue;
    lines.push(isDisabled(entry) ? ruleLine(id, undefined, false) : ruleLine(id, effective.get(id), false));
  }
  return lines;
}
