import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { i18n } from "./i18n.ts";
import { parsePresetRules } from "./rules.ts";
import type { SafetyRule } from "./types.ts";

/** 默认启用的预设名；必须与 presets/ 目录里的文件名一致。 */
export const DEFAULT_PRESETS = ["destructive-operations"] as const;
/** 内置预设目录随包发布，文件名就是预设名。 */
export const PRESETS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "presets");
/** 预设文件扩展名。 */
const PRESET_EXTENSION = ".json";
/** 预设名只允许小写字母、数字和单个连字符，避免文件名变成原型键或路径。 */
const PRESET_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 空目录和名称不合法都按加载失败处理，不静默退回“没有预设”。 */
const EMPTY_DIRECTORY_KEY = "presetDirectoryEmpty";

/** 预设名到规则列表的只读映射。 */
export type PresetCatalog = Readonly<Record<string, readonly SafetyRule[]>>;

const cache = new Map<string, PresetCatalog>();

/** 读取内置预设目录；同一目录只解析一次，失败不缓存也不降级。 */
export function loadPresets(directory: string = PRESETS_DIRECTORY): PresetCatalog {
  const cached = cache.get(directory);
  if (cached) return cached;
  const catalog = readPresetDirectory(directory);
  cache.set(directory, catalog);
  return catalog;
}

/** 目录里每个 JSON 文件的文件名就是预设名，排序后保证预设顺序稳定。 */
function readPresetDirectory(directory: string): PresetCatalog {
  let files: string[];
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(PRESET_EXTENSION))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new Error(i18n.t("presetDirectoryFailed", { directory, error: describe(error) }), { cause: error });
  }
  if (files.length === 0) {
    throw new Error(i18n.t("presetDirectoryFailed", { directory, error: i18n.t(EMPTY_DIRECTORY_KEY) }));
  }
  const catalog: Record<string, readonly SafetyRule[]> = {};
  for (const file of files) {
    const path = join(directory, file);
    const name = file.slice(0, -PRESET_EXTENSION.length);
    if (!PRESET_NAME_PATTERN.test(name)) {
      throw new Error(i18n.t("presetFileInvalid", { file: path, error: i18n.t("presetNameInvalid", { name }) }));
    }
    catalog[name] = readPresetFile(path, name);
  }
  return Object.freeze(catalog);
}

/** 解析单个预设文件；语法错误和字段错误都带文件路径抛出。 */
function readPresetFile(path: string, name: string): readonly SafetyRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(i18n.t("presetFileInvalid", { file: path, error: describe(error) }), { cause: error });
  }
  try {
    const rules = parsePresetRules(parsed, name);
    deepFreeze(rules);
    return rules;
  } catch (error) {
    throw new Error(i18n.t("presetFileInvalid", { file: path, error: describe(error) }), { cause: error });
  }
}

/** 判定可以继续递归冻结的数组；用类型谓词避免断言。 */
function isArrayValue(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** 判定可以继续递归冻结的普通记录。 */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isArrayValue(value);
}

/** 预设来自随包文件，冻结后缓存不会被调用方就地改写。 */
function deepFreeze(value: unknown): void {
  if (isArrayValue(value)) {
    for (const item of value) deepFreeze(item);
    Object.freeze(value);
    return;
  }
  if (!isRecordValue(value)) return;
  for (const item of Object.values(value)) deepFreeze(item);
  Object.freeze(value);
}

/** 把未知错误变成可读文本，保留原始错误作为 cause。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
