import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";
import { checkKeys, fieldPath, invalid, object, parseAction, parseMatch, parseMessage } from "./rules.ts";
import type { SafetyConfig, SafetyRule } from "./types.ts";

/** Pi 存放扩展配置的目录名。 */
const EXTENSIONS_DIR = "extensions";
/** 本扩展在 extensions/ 下的目录名。 */
const PACKAGE_NAME = "pi-safety-guards";
/** 用户配置文件名。 */
const CONFIG_FILENAME = "config.json";
/** 文件不存在时的错误码；只有它表示“还没配置过”。 */
const FILE_NOT_FOUND_CODE = "ENOENT";
/** 顶层只允许 rules；写错字段直接报错，不猜测意图。 */
const CONFIG_KEYS = ["rules"] as const;
/** 单条规则允许的字段；enabled 只决定是否执行，规则本身仍必须合法。 */
const RULE_KEYS = ["id", "action", "match", "message", "enabled"] as const;
/** 已删除的字段，单独报错并告诉用户改成什么。 */
const REMOVED_KEYS = ["presets"] as const;

/** 首次运行时写入配置文件的默认规则：与原 destructive-operations 预设完全等价。 */
export const DEFAULT_RULES: readonly SafetyRule[] = [
  { id: "filesystem.delete", action: "confirm", match: { commands: ["rm", "rmdir"] } },
  { id: "filesystem.format", action: "confirm", match: { commandPrefixes: ["mkfs"] } },
  { id: "filesystem.ownership", action: "confirm", match: { commands: ["chown"] } },
  { id: "shell.fork-bomb", action: "confirm", match: { commandPattern: ":\\(\\)\\s*\\{" } },
];

/** 返回 agent 目录下的显式用户配置位置。 */
export function configPath(): string {
  return join(getAgentDir(), EXTENSIONS_DIR, PACKAGE_NAME, CONFIG_FILENAME);
}

/** 用户配置原文；rules 保留条目原文，展示时能区分停用的规则。 */
export interface SafetyConfigDocument {
  rules: unknown[];
}

/** 首次运行且配置文件不存在时写入默认规则；返回是否真的创建了文件。 */
export function ensureConfigFile(path = configPath()): boolean {
  if (existsSync(path)) return false;
  saveConfig({ rules: DEFAULT_RULES }, path);
  return true;
}

/** 将经过校验的安全规则配置写入文件，返回写入路径。 */
export function saveConfig(config: SafetyConfig, path = configPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

/** 校验配置原文并返回用户文档；文件不存在时按“没有规则”处理，不写文件。 */
export function loadConfigDocument(path = configPath()): SafetyConfigDocument {
  try {
    const raw = object(JSON.parse(readFileSync(path, "utf8")), "config");
    parseConfig(raw);
    return { rules: raw.rules === undefined ? [] : entries(raw.rules, "rules") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return { rules: [] };
    throw error;
  }
}

/** 复制规则条目原文（浅拷贝数组，条目对象保持原引用），展示时按文件顺序读。 */
function entries(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) return invalid(field);
  return [...value];
}

/** 预设功能已删除：报错并告诉用户规则要直接写进 rules，不静默忽略。 */
function rejectRemovedKeys(raw: Record<string, unknown>): void {
  for (const key of REMOVED_KEYS) {
    if (Object.hasOwn(raw, key)) throw new Error(i18n.t("presetsRemoved"));
  }
}

/** 校验单条规则，返回规则本身和是否启用；停用的规则照样要合法。 */
function parseRule(value: unknown): { readonly enabled: boolean; readonly rule: SafetyRule } {
  const raw = object(value, "rules");
  checkKeys(raw, RULE_KEYS, "rules");
  const rawId = raw.id;
  if (typeof rawId !== "string" || !rawId.trim()) invalid(fieldPath("rules", "id"));
  const id = rawId.trim();
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") invalid(fieldPath(id, "enabled"));
  const action = parseAction(raw.action, fieldPath(id, "action"));
  const match = parseMatch(raw.match, fieldPath(id, "match"));
  const message = raw.message === undefined ? undefined : parseMessage(raw.message, fieldPath(id, "message"));
  return { enabled: raw.enabled !== false, rule: { id, action, match, ...(message === undefined ? {} : { message }) } };
}

/** 校验 rules 并返回可执行配置；重复 ID 直接报错，不做静默覆盖。 */
export function parseConfig(value: unknown): SafetyConfig {
  const raw = object(value, "config");
  rejectRemovedKeys(raw);
  checkKeys(raw, CONFIG_KEYS, "config");
  const rules = raw.rules === undefined ? [] : entries(raw.rules, "rules");
  const seen = new Set<string>();
  const compiled = new Map<string, SafetyRule>();
  for (const entry of rules) {
    const parsed = parseRule(entry);
    if (seen.has(parsed.rule.id)) invalid(fieldPath("rules", parsed.rule.id));
    seen.add(parsed.rule.id);
    if (parsed.enabled) compiled.set(parsed.rule.id, parsed.rule);
  }
  return { rules: [...compiled.values()] };
}

/** 仅文件不存在时按没有规则处理；配置损坏会阻止受保护工具执行。 */
export function loadConfig(path = configPath()): SafetyConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return parseConfig({});
    throw error;
  }
}
