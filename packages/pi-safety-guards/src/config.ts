import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRESETS, PRESETS } from "./presets.ts";
import { i18n } from "./i18n.ts";
import type { Detector, RuleAction, RuleMatch, RuleMessage, SafetyConfig, SafetyRule } from "./types.ts";

const EXTENSIONS_DIR = "extensions";
const PACKAGE_NAME = "pi-safety-guards";
const CONFIG_FILENAME = "config.json";
const FILE_NOT_FOUND_CODE = "ENOENT";
const ACTIONS = new Set<unknown>(["warn", "confirm", "block"]);
const DETECTORS = new Set<unknown>(["disk-format", "fork-bomb", "in-place-edit", "home-root", "root-search"]);

/** 返回 agent 目录下的显式用户配置位置。 */
export function configPath(): string {
  return join(getAgentDir(), EXTENSIONS_DIR, PACKAGE_NAME, CONFIG_FILENAME);
}

/** 将配置错误转换成双语诊断，不悄悄忽略未知配置。 */
function invalid(field: string): never {
  throw new Error(i18n.t("configInvalidField", { field }));
}

/** 收窄普通 JSON 对象。 */
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
}

/** 拒绝字段拼写错误和旧技术专属配置，避免误启用默认策略。 */
function checkKeys(raw: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) invalid(`${field}.${key}`);
  }
}

/** 验证非空文本数组，目录允许空列表以表达不信任任何根。 */
function strings(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return invalid(field);
  if (value.some((item) => typeof item !== "string" || !item.trim())) return invalid(field);
  return value.map((item: string) => item.trim());
}

/** 匹配器只允许一种类型，不组合成规则表达式语言。 */
function parseMatch(value: unknown, field: string): RuleMatch {
  const raw = object(value, field);
  if (Object.keys(raw).length !== 1) return invalid(field);
  if (Object.hasOwn(raw, "commands")) return { commands: strings(raw.commands, field) };
  if (Object.hasOwn(raw, "outsideRoots")) return { outsideRoots: strings(raw.outsideRoots, field, true) };
  if (Object.hasOwn(raw, "detector") && DETECTORS.has(raw.detector)) return { detector: raw.detector as Detector };
  if (typeof raw.module === "string" && raw.module.trim()) return { module: raw.module.trim() };
  return invalid(field);
}

/** 用户本地文案可用单一语言，公共示例提供中英文。 */
function parseMessage(value: unknown, field: string): RuleMessage {
  if (typeof value === "string" && value.trim()) return value;
  const raw = object(value, field);
  checkKeys(raw, ["zh-CN", "en-US"], field);
  if (typeof raw["zh-CN"] !== "string" || !raw["zh-CN"].trim() ||
      typeof raw["en-US"] !== "string" || !raw["en-US"].trim()) return invalid(field);
  return { "zh-CN": raw["zh-CN"], "en-US": raw["en-US"] };
}

/** 选择预设后按稳定 ID 覆盖，不继承任何维护者的技术栈策略。 */
export function parseConfig(value: unknown): SafetyConfig {
  const raw = object(value, "config");
  checkKeys(raw, ["presets", "rules"], "config");
  const presets = raw.presets === undefined ? DEFAULT_PRESETS : strings(raw.presets, "presets", true);
  const rules = new Map<string, SafetyRule>();
  for (const preset of presets) {
    if (!Object.hasOwn(PRESETS, preset)) invalid(`presets.${preset}`);
    for (const rule of PRESETS[preset]) {
      // 不共享可变预设对象，用户模块也不会收到规则配置引用。
      rules.set(rule.id, structuredClone(rule));
    }
  }
  const overrides = raw.rules === undefined ? [] : raw.rules;
  if (!Array.isArray(overrides)) return invalid("rules");
  const seen = new Set<string>();
  for (const value of overrides) {
    const override = object(value, "rules");
    checkKeys(override, ["id", "enabled", "action", "match", "message"], "rules");
    if (typeof override.id !== "string" || !override.id.trim()) invalid("rules.id");
    const id = (override.id as string).trim();
    if (seen.has(id)) invalid(`rules.${id}`);
    seen.add(id);
    if (override.enabled !== undefined && typeof override.enabled !== "boolean") invalid(`${id}.enabled`);
    const previous = rules.get(id);
    const action = override.action ?? previous?.action;
    if (override.action !== undefined && !ACTIONS.has(override.action)) invalid(`${id}.action`);
    const match = override.match === undefined ? previous?.match : parseMatch(override.match, `${id}.match`);
    const message = override.message === undefined ? previous?.message : parseMessage(override.message, `${id}.message`);
    if (override.enabled === false) {
      if (!previous && !match) invalid(`${id}.match`);
      rules.delete(id);
      continue;
    }
    if (!ACTIONS.has(action) || !match) invalid(id);
    rules.set(id, { id, action: action as RuleAction, match: match!, ...(message === undefined ? {} : { message }) });
  }
  return { rules: [...rules.values()] };
}

/** 仅文件不存在时使用默认预设；配置损坏会阻止受保护工具执行。 */
export function loadConfig(path = configPath()): SafetyConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return parseConfig({});
    throw error;
  }
}
