import { createTranslator, loadCatalog } from "pi-extensions-i18n";

export const i18n = createTranslator(loadCatalog(new URL("../locales/i18n.json", import.meta.url)));
export const SHELL_PARSE_BLOCKED_MESSAGE_KEY = "shellParseBlocked";

const dangerLabelKeys = {
  "rm（删除文件/目录）": "rm",
  "rmdir（删除空目录）": "rmdir",
  "chown（修改所有者）": "chown",
  "mkfs（格式化磁盘）": "mkfs",
  "Fork 炸弹": "forkBomb",
  "sed -i（原地修改文件）": "sed",
  "直接搜索 ~ 目录": "home",
  "find /（全盘搜索）": "findRoot",
} as const;

export function localizeDangerLabel(label: string): string {
  const key = dangerLabelKeys[label as keyof typeof dangerLabelKeys];
  return key ? i18n.t(key) : label;
}
