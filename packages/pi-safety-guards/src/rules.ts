import { i18n } from "./i18n.ts";
import type { RuleAction, RuleMatch, RuleMessage } from "./types.ts";

const ACTIONS = new Set<unknown>(["warn", "confirm", "block"]);
/** 文案对象支持的语言键；新增语言时只改这里。 */
const MESSAGE_LOCALES = ["zh-CN", "en-US"] as const;
/** 错误里展示字段位置的统一分隔符。 */
const FIELD_SEPARATOR = ".";

/**
 * 把字段路径拼成 `rules.<id>.match` 形式，避免各处散落点号拼接。
 * 配置覆盖也用 `fieldPath(id, "action")`；重复 id 检测用 `fieldPath(field, id)` 指向冲突的那条规则。
 */
export function fieldPath(field: string, ...parts: readonly string[]): string {
  return [field, ...parts].join(FIELD_SEPARATOR);
}

/** 将配置错误转换成双语诊断，不悄悄忽略未知配置。 */
export function invalid(field: string): never {
  throw new Error(i18n.t("configInvalidField", { field }));
}

/** 收窄普通 JSON 对象。 */
export function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
}

/** 拒绝字段拼写错误和旧技术专属配置，避免误启用默认策略。 */
export function checkKeys(raw: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) invalid(fieldPath(field, key));
  }
}

/** 验证非空文本数组，目录允许空列表以表达不信任任何根。 */
export function strings(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return invalid(field);
  if (value.some((item) => typeof item !== "string" || !item.trim())) return invalid(field);
  return value.map((item: string) => item.trim());
}

/** 正则里必须是非空字符串，且在写配置时就编译得开。 */
function parsePattern(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) return invalid(field);
  const pattern = value.trim();
  try {
    new RegExp(pattern);
  } catch {
    return invalid(field);
  }
  return pattern;
}

/**
 * 匹配器只能选一种，每种都直接写明匹配内容：
 * commands 命令名、commandPrefixes 命令名前缀、commandPattern 原始命令文本正则。
 */
export function parseMatch(value: unknown, field: string): RuleMatch {
  const raw = object(value, field);
  // detector 曾把匹配逻辑藏在代码里，现在统一改成显式匹配；报错时直接告诉用户怎么改。
  if (Object.hasOwn(raw, "detector")) throw new Error(i18n.t("detectorRemoved"));
  if (Object.keys(raw).length !== 1) return invalid(field);
  if (Object.hasOwn(raw, "commands")) return { commands: strings(raw.commands, field) };
  if (Object.hasOwn(raw, "commandPrefixes")) return { commandPrefixes: strings(raw.commandPrefixes, field) };
  if (Object.hasOwn(raw, "commandPattern")) return { commandPattern: parsePattern(raw.commandPattern, field) };
  if (Object.hasOwn(raw, "outsideRoots")) return { outsideRoots: strings(raw.outsideRoots, field, true) };
  if (typeof raw.module === "string" && raw.module.trim()) return { module: raw.module.trim() };
  return invalid(field);
}

/** 用户本地文案可用单一语言，公共示例提供中英文。 */
export function parseMessage(value: unknown, field: string): RuleMessage {
  if (typeof value === "string" && value.trim()) return value;
  const raw = object(value, field);
  checkKeys(raw, MESSAGE_LOCALES, field);
  const zhCN = raw["zh-CN"];
  const enUS = raw["en-US"];
  if (typeof zhCN !== "string" || !zhCN.trim()) return invalid(fieldPath(field, "zh-CN"));
  if (typeof enUS !== "string" || !enUS.trim()) return invalid(fieldPath(field, "en-US"));
  return { "zh-CN": zhCN, "en-US": enUS };
}

/** 动作只接受三种固定值。 */
export function parseAction(value: unknown, field: string): RuleAction {
  if (!ACTIONS.has(value)) return invalid(field);
  return value as RuleAction;
}
