/**
 * 危险命令检测工具（不依赖 pi 类型，方便测试）
 */

import { analyzeShellCommand, type ShellCommandInvocation } from "./shell-command-utils";

const RM_COMMAND = "rm";
const RMDIR_COMMAND = "rmdir";
const CHOWN_COMMAND = "chown";
const MKFS_COMMAND = "mkfs";
const SED_COMMAND = "sed";
const FIND_COMMAND = "find";
const MKFS_VARIANT_PREFIX = `${MKFS_COMMAND}.`;
const SED_IN_PLACE_LONG_OPTION = "--in-place";
const HOME_ROOT_ARGUMENT = "~";
const FILESYSTEM_ROOT_ARGUMENT = "/";
const FORK_BOMB_FUNCTION_NAME = ":";
const FORK_BOMB_DEFINITION_PATTERN = /:\(\)\s*\{/;

export interface DangerPattern {
  /** 判断一段 Bash 是否命中当前危险规则。 */
  test(command: string): boolean;
}

export interface DangerRule {
  pattern: DangerPattern;
  label: string;
}

/** 将程序名包装成只匹配实际 Shell 命令节点的规则。 */
function commandPattern(commandName: string): DangerPattern {
  return shellCommandPattern(({ name }) =>
    name === commandName ||
      (commandName === MKFS_COMMAND && name.startsWith(MKFS_VARIANT_PREFIX)),
  );
}

/** 支持同时检查真实程序名和参数，避免匹配普通文案、注释或其他命令的参数。 */
function shellCommandPattern(
  predicate: (command: ShellCommandInvocation) => boolean,
): DangerPattern {
  return {
    /** 解析 Bash 后仅对实际命令调用执行当前规则判断。 */
    test(command) {
      return analyzeShellCommand(command).commands.some(predicate);
    },
  };
}

/** 只在源码确实解析出冒号函数定义时匹配 fork bomb，避免普通文案误报。 */
function forkBombPattern(): DangerPattern {
  return {
    /** 同时验证标准 fork bomb 语法片段和对应的 Function AST 节点。 */
    test(command) {
      if (!FORK_BOMB_DEFINITION_PATTERN.test(command)) return false;
      return analyzeShellCommand(command).nodes.some((node) =>
        node.type === "Function" && isRecord(node.name) &&
          node.name.value === FORK_BOMB_FUNCTION_NAME,
      );
    },
  };
}

/** sed 的短选项可组合或携带备份后缀；长选项支持等号形式。 */
function isSedInPlaceOption(arg: string): boolean {
  if (arg === SED_IN_PLACE_LONG_OPTION || arg.startsWith(`${SED_IN_PLACE_LONG_OPTION}=`)) return true;
  return /^-[^-]+$/.test(arg) && arg.slice(1).includes("i");
}

/** 未引用的独立 ~ 会由 Shell 展开为整个 HOME；引号中的字面量 ~ 不属于该规则。 */
function accessesHomeRoot(command: ShellCommandInvocation): boolean {
  return command.args.some((arg) => arg.text === HOME_ROOT_ARGUMENT);
}

export const DANGER_RULES: DangerRule[] = [
  { pattern: commandPattern(RM_COMMAND), label: "rm（删除文件/目录）" },
  { pattern: commandPattern(RMDIR_COMMAND), label: "rmdir（删除空目录）" },
  { pattern: commandPattern(CHOWN_COMMAND), label: "chown（修改所有者）" },
  { pattern: commandPattern(MKFS_COMMAND), label: "mkfs（格式化磁盘）" },
  { pattern: forkBombPattern(), label: "Fork 炸弹" },
  {
    pattern: shellCommandPattern(({ name, args }) =>
      name === SED_COMMAND && args.some((arg) => isSedInPlaceOption(arg.value)),
    ),
    label: "sed -i（原地修改文件）",
  },
  {
    pattern: shellCommandPattern(accessesHomeRoot),
    label: "直接搜索 ~ 目录",
  },
  {
    pattern: shellCommandPattern(({ name, args }) =>
      name === FIND_COMMAND && args.some((arg) => arg.value === FILESYSTEM_ROOT_ARGUMENT),
    ),
    label: "find /（全盘搜索）",
  },
];

/** 将未知 AST 值安全收窄为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 按规则顺序返回首个危险命令；共享分析缓存确保一条命令只解析一次。 */
export function findDangerRule(command: string): DangerRule | undefined {
  return DANGER_RULES.find((rule) => rule.pattern.test(command));
}
