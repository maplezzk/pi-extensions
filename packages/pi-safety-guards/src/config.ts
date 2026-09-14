import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRESETS, loadPresets, type PresetCatalog } from "./presets.ts";
import { checkKeys, fieldPath, invalid, object, parseAction, parseMatch, parseMessage, strings } from "./rules.ts";
import type { SafetyConfig, SafetyRule } from "./types.ts";

const EXTENSIONS_DIR = "extensions";
const PACKAGE_NAME = "pi-safety-guards";
const CONFIG_FILENAME = "config.json";
const FILE_NOT_FOUND_CODE = "ENOENT";
/** 顶层允许的字段；写错字段直接报错，不猜测意图。 */
const CONFIG_KEYS = ["presets", "rules"] as const;
/** 覆盖条目的允许字段。 */
const OVERRIDE_KEYS = ["id", "enabled", "action", "match", "message"] as const;

/** 返回 agent 目录下的显式用户配置位置。 */
export function configPath(): string {
  return join(getAgentDir(), EXTENSIONS_DIR, PACKAGE_NAME, CONFIG_FILENAME);
}

export interface SafetyConfigDocument {
  presets: string[];
  rules: unknown[];
}

/** 把已校验的配置原文还原成文档；缺失字段回落到默认预设和空规则。 */
function documentFrom(raw: Record<string, unknown>): SafetyConfigDocument {
  return {
    presets: raw.presets === undefined ? [...DEFAULT_PRESETS] : strings(raw.presets, "presets", true),
    rules: raw.rules === undefined ? [] : entries(raw.rules, "rules"),
  };
}

/** 复制覆盖条目原文（浅拷贝数组，条目对象保持原引用），写回文件时不丢字段。 */
function entries(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) return invalid(field);
  return [...value];
}

/** 读取配置文件的用户文档，保留预设选择和自定义规则原文。 */
export function loadConfigDocument(
  path = configPath(),
  presets: PresetCatalog = loadPresets(),
): SafetyConfigDocument {
  try {
    const raw = object(JSON.parse(readFileSync(path, "utf8")), "config");
    parseConfig(raw, presets);
    return documentFrom(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) {
      return { presets: [...DEFAULT_PRESETS], rules: [] };
    }
    throw error;
  }
}

/** 将完整的用户配置文档校验后写入文件。 */
export function saveConfigDocument(
  document: SafetyConfigDocument,
  path = configPath(),
  presets: PresetCatalog = loadPresets(),
): string {
  parseConfig(document, presets);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return path;
}

/** 将经过校验的安全规则配置写入配置文件。 */
export function saveConfig(config: SafetyConfig, path = configPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

/** 选择预设后按稳定 ID 覆盖，不继承任何维护者的技术栈策略。 */
export function parseConfig(value: unknown, presets: PresetCatalog = loadPresets()): SafetyConfig {
  const raw = object(value, "config");
  checkKeys(raw, CONFIG_KEYS, "config");
  const selected = raw.presets === undefined ? [...DEFAULT_PRESETS] : strings(raw.presets, "presets", true);
  const rules = new Map<string, SafetyRule>();
  for (const preset of selected) {
    if (!Object.hasOwn(presets, preset)) invalid(fieldPath("presets", preset));
    for (const rule of presets[preset]) {
      // 不共享可变预设对象，用户模块也不会收到规则配置引用。
      rules.set(rule.id, structuredClone(rule));
    }
  }
  const overrides = raw.rules === undefined ? [] : raw.rules;
  if (!Array.isArray(overrides)) return invalid("rules");
  const seen = new Set<string>();
  for (const value of overrides) {
    const override = object(value, "rules");
    checkKeys(override, OVERRIDE_KEYS, "rules");
    const rawId = override.id;
    if (typeof rawId !== "string" || !rawId.trim()) invalid(fieldPath("rules", "id"));
    const id = rawId.trim();
    if (seen.has(id)) invalid(fieldPath("rules", id));
    seen.add(id);
    if (override.enabled !== undefined && typeof override.enabled !== "boolean") invalid(fieldPath(id, "enabled"));
    const previous = rules.get(id);
    const action = override.action === undefined ? previous?.action : parseAction(override.action, fieldPath(id, "action"));
    const match = override.match === undefined ? previous?.match : parseMatch(override.match, fieldPath(id, "match"));
    const message = override.message === undefined ? previous?.message : parseMessage(override.message, fieldPath(id, "message"));
    if (override.enabled === false) {
      if (!previous && !match) invalid(fieldPath(id, "match"));
      rules.delete(id);
      continue;
    }
    if (action === undefined || !match) invalid(id);
    rules.set(id, { id, action, match, ...(message === undefined ? {} : { message }) });
  }
  return { rules: [...rules.values()] };
}

/** 仅文件不存在时使用默认预设；配置损坏会阻止受保护工具执行。 */
export function loadConfig(path = configPath(), presets: PresetCatalog = loadPresets()): SafetyConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")), presets);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return parseConfig({}, presets);
    throw error;
  }
}
