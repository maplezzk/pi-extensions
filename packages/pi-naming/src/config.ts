import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";

const EXTENSIONS_DIR = "extensions";
const PACKAGE_NAME = "pi-naming";
const CONFIG_FILENAME = "config.json";
const FILE_NOT_FOUND_CODE = "ENOENT";
const MAX_TIMER_MS = 2_147_483_647;
const NAMING_SWITCHES = ["automaticNaming", "manualNaming"] as const;
const TARGET_KEYS = ["session", "workspace", "tab"] as const;

export interface TitleConfig {
  maxLength: number;
  preferredLength: number;
  language: string;
  instructions: string;
  timeoutMs: number;
}

export const DEFAULT_TITLE_CONFIG: Readonly<TitleConfig> = Object.freeze({
  maxLength: 15,
  preferredLength: 10,
  language: "auto",
  instructions: "",
  timeoutMs: 10_000,
});

export interface NamingConfig {
  automaticNaming: boolean;
  manualNaming: boolean;
  targets: { session: boolean; workspace: boolean; tab: boolean };
  title: TitleConfig;
}

/** 配置字段错误直接报告，不忽略拼写错误或非法值。 */
function invalid(field: string): never {
  throw new Error(i18n.t("namingConfigInvalidField", { field }));
}

/** 验证非空普通配置对象，拒绝数组和基础类型。 */
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

/** 只允许正安全整数，避免小数、无穷大和隐式类型转换。 */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(field);
  return value;
}

/** 校验配置字段与取值，为省略的字段补齐默认值。 */
export function parseConfig(value: unknown): NamingConfig {
  const raw = object(value, "config");
  const allowed = new Set<string>([...NAMING_SWITCHES, "targets", "title"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) invalid(key);
  for (const key of NAMING_SWITCHES) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") invalid(key);
  }
  const targetRaw = raw.targets === undefined ? {} : object(raw.targets, "targets");
  for (const key of Object.keys(targetRaw)) {
    if (!TARGET_KEYS.some((target) => target === key) || typeof targetRaw[key] !== "boolean") invalid(`targets.${key}`);
  }
  const titleRaw = raw.title === undefined ? {} : object(raw.title, "title");
  for (const key of Object.keys(titleRaw)) {
    if (!Object.hasOwn(DEFAULT_TITLE_CONFIG, key)) invalid(`title.${key}`);
  }
  const title: TitleConfig = { ...DEFAULT_TITLE_CONFIG };
  for (const key of ["maxLength", "preferredLength", "timeoutMs"] as const) {
    if (titleRaw[key] !== undefined) title[key] = positiveInteger(titleRaw[key], `title.${key}`);
  }
  if (title.preferredLength > title.maxLength) invalid("title.preferredLength");
  if (title.timeoutMs > MAX_TIMER_MS) invalid("title.timeoutMs");
  for (const key of ["language", "instructions"] as const) {
    if (titleRaw[key] === undefined) continue;
    if (typeof titleRaw[key] !== "string") invalid(`title.${key}`);
    title[key] = titleRaw[key].trim();
  }
  if (!title.language) invalid("title.language");
  return {
    automaticNaming: (raw.automaticNaming as boolean | undefined) ?? true,
    manualNaming: (raw.manualNaming as boolean | undefined) ?? true,
    targets: {
      session: (targetRaw.session as boolean | undefined) ?? true,
      workspace: (targetRaw.workspace as boolean | undefined) ?? true,
      tab: (targetRaw.tab as boolean | undefined) ?? true,
    },
    title,
  };
}

/** 仅缺少配置文件时采用默认值，读取和解析错误交给入口报告。 */
export function loadConfig(
  path = join(getAgentDir(), EXTENSIONS_DIR, PACKAGE_NAME, CONFIG_FILENAME),
): NamingConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return parseConfig({});
    throw error;
  }
}
