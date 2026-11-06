import { parse, type Command, type Word } from "unbash";

export type ShellWord = Word;

const MAX_NESTED_SHELL_DEPTH = 8;
const OPTION_AND_VALUE_WIDTH = 2;
const COMMAND_WRAPPER_NAME = "command";
const ENV_WRAPPER_NAME = "env";
const EVAL_COMMAND_NAME = "eval";
const OPTION_TERMINATOR = "--";
const STANDARD_INPUT_SCRIPT = "-";
const SHORT_OPTION_PREFIX = "-";
const ENABLE_OPTION_PREFIX = "+";
const SHELL_COMMAND_OPTION = "-c";
const SHELL_COMMAND_FLAG = "c";
const SHELL_LAUNCHERS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const COMMAND_QUERY_OPTIONS = new Set(["-v", "-V", "--help"]);
const COMMAND_QUERY_SHORT_OPTIONS = /^-[pvV]*[vV][pvV]*$/;
const ENV_SPLIT_OPTIONS = new Set(["-S", "--split-string"]);
const SHELL_OPTIONS_WITH_VALUE = new Set([
  "-O", "+O", "-o", "+o", "--init-file", "--rcfile",
]);
const EMPTY_OPTIONS = new Set<string>();

interface WrapperConfig {
  optionsWithValue: ReadonlySet<string>;
  skipAssignments: boolean;
}

const WRAPPER_CONFIGS: Readonly<Record<string, WrapperConfig>> = {
  sudo: {
    optionsWithValue: new Set([
      "-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host",
      "-p", "--prompt", "-R", "--chroot", "-T", "--command-timeout", "-u", "--user",
    ]),
    skipAssignments: false,
  },
  env: {
    optionsWithValue: new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]),
    skipAssignments: true,
  },
  command: { optionsWithValue: EMPTY_OPTIONS, skipAssignments: false },
  builtin: { optionsWithValue: EMPTY_OPTIONS, skipAssignments: false },
  nohup: { optionsWithValue: EMPTY_OPTIONS, skipAssignments: false },
  exec: { optionsWithValue: new Set(["-a"]), skipAssignments: false },
};

export interface ShellWrapperOption {
  name: string;
  value?: string;
}

export interface ShellWrapperInvocation {
  executable: Word;
  name: string;
  args: readonly Word[];
  options: readonly ShellWrapperOption[];
}

export interface ShellCommandInvocation {
  executable: Word;
  name: string;
  args: readonly Word[];
  wrappers: readonly ShellWrapperInvocation[];
  /** shell -c 与 eval 会把参数继续解释为 Shell 源码，而不是普通文件参数。 */
  nestedSource?: string;
}

export interface ShellParseIssue {
  message: string;
  pos: number;
  source: string;
}

export interface ShellCommandAnalysis {
  commands: readonly ShellCommandInvocation[];
  wrappers: readonly ShellWrapperInvocation[];
  /** 保留 AST 节点供路径、重定向和文件测试等策略检查，各业务策略不重复解析。 */
  nodes: readonly Record<string, unknown>[];
  errors: readonly ShellParseIssue[];
}

interface MutableAnalysis {
  commands: ShellCommandInvocation[];
  wrappers: ShellWrapperInvocation[];
  nodes: Record<string, unknown>[];
  errors: ShellParseIssue[];
  visited: WeakSet<object>;
}

interface CommandResolution {
  invocation?: ShellCommandInvocation;
  wrappers: ShellWrapperInvocation[];
  nestedSource?: string;
}

interface ConsumedWrapper {
  wrapper: ShellWrapperInvocation;
  nextIndex: number;
}

interface VisitShellValueOptions {
  value: unknown;
  source: string;
  state: MutableAnalysis;
  depth: number;
}

interface ConsumeWrapperOptions {
  words: Word[];
  wrapperIndex: number;
  name: string;
  config: WrapperConfig;
}

let cachedSource: string | undefined;
let cachedAnalysis: ShellCommandAnalysis | undefined;

/**
 * 将 Bash 源码解析为真实命令调用、wrapper 和完整 AST 节点。
 * 单条 tool_call 会被多个安全策略检查，单项缓存避免对同一命令重复解析。
 */
export function analyzeShellCommand(source: string): ShellCommandAnalysis {
  if (source === cachedSource && cachedAnalysis) return cachedAnalysis;

  const state: MutableAnalysis = {
    commands: [],
    wrappers: [],
    nodes: [],
    errors: [],
    visited: new WeakSet<object>(),
  };
  analyzeSource(source, state, 0);

  const analysis: ShellCommandAnalysis = {
    commands: state.commands,
    wrappers: state.wrappers,
    nodes: state.nodes,
    errors: state.errors,
  };
  cachedSource = source;
  cachedAnalysis = analysis;
  return analysis;
}

/** 递归解析 shell -c、eval 与 env -S 中的字面量子命令。 */
function analyzeSource(source: string, state: MutableAnalysis, depth: number): void {
  if (depth >= MAX_NESTED_SHELL_DEPTH) {
    state.errors.push({
      message: `Shell nesting exceeds ${MAX_NESTED_SHELL_DEPTH} levels`,
      pos: 0,
      source,
    });
    return;
  }

  let script: unknown;
  try {
    script = parse(source);
  } catch (error) {
    state.errors.push({
      message: error instanceof Error ? error.message : String(error),
      pos: 0,
      source,
    });
    return;
  }

  visitShellValue({ value: script, source, state, depth });
}

/** 遍历惰性 word parts、命令替换、进程替换及所有普通 AST 字段。 */
function visitShellValue(options: VisitShellValueOptions): void {
  const { value, source, state, depth } = options;
  if (Array.isArray(value)) {
    for (const item of value) visitShellValue({ value: item, source, state, depth });
    return;
  }
  if (!value || typeof value !== "object" || state.visited.has(value)) return;
  state.visited.add(value);

  const node = value as Record<string, unknown>;
  const nodeSource = node.type === "Script" && typeof node.source === "string"
    ? node.source
    : source;
  state.nodes.push(node);

  if (node.type === "Script" && Array.isArray(node.errors)) {
    for (const error of node.errors) {
      if (!isRecord(error) || typeof error.message !== "string") continue;
      state.errors.push({
        message: error.message,
        pos: typeof error.pos === "number" ? error.pos : 0,
        source: nodeSource,
      });
    }
  }

  if (node.type === "Command") {
    const resolution = resolveCommand(node as unknown as Command);
    state.wrappers.push(...resolution.wrappers);
    if (resolution.invocation) state.commands.push(resolution.invocation);
    if (resolution.nestedSource) analyzeSource(resolution.nestedSource, state, depth + 1);
  }

  // Word.parts 与 indexParts 是惰性属性，不会出现在 Object.values 中。
  if ("parts" in node) {
    visitShellValue({ value: node.parts, source: nodeSource, state, depth });
  }
  if ("indexParts" in node) {
    visitShellValue({ value: node.indexParts, source: nodeSource, state, depth });
  }
  for (const child of Object.values(node)) {
    visitShellValue({ value: child, source: nodeSource, state, depth });
  }
}

/** 跳过 sudo/env/command 等 wrapper，返回真正执行的程序和需递归解析的源码。 */
function resolveCommand(command: Command): CommandResolution {
  if (!command.name) return { wrappers: [] };

  const words = [command.name, ...command.suffix];
  const wrappers: ShellWrapperInvocation[] = [];
  let index = 0;

  while (index < words.length) {
    const executable = words[index];
    const name = commandBasename(executable.value);
    const config = WRAPPER_CONFIGS[name];
    if (!config) {
      const args = words.slice(index + 1);
      const nestedSource = nestedCommandSource(name, args);
      return {
        wrappers,
        invocation: { executable, name, args, wrappers: [...wrappers], nestedSource },
        nestedSource,
      };
    }

    const consumed = consumeWrapper({ words, wrapperIndex: index, name, config });
    wrappers.push(consumed.wrapper);
    if (name === COMMAND_WRAPPER_NAME && isCommandQuery(consumed.wrapper.options)) {
      return { wrappers };
    }
    if (name === ENV_WRAPPER_NAME) {
      const splitSource = envSplitSource(consumed.wrapper.options);
      if (splitSource !== undefined) return { wrappers, nestedSource: splitSource };
    }
    index = consumed.nextIndex;
  }

  return { wrappers };
}

/** 消费单个 wrapper 的选项、选项值和 env 赋值，保留规范化后的选项。 */
function consumeWrapper(input: ConsumeWrapperOptions): ConsumedWrapper {
  const { words, wrapperIndex, name, config } = input;
  const args: Word[] = [];
  const wrapperOptions: ShellWrapperOption[] = [];
  let index = wrapperIndex + 1;

  while (index < words.length) {
    const word = words[index];
    const value = word.value;
    if (config.skipAssignments && isShellAssignment(value)) {
      args.push(word);
      index++;
      continue;
    }
    if (value === "--") {
      args.push(word);
      index++;
      break;
    }
    if (!value.startsWith("-") || value === "-") break;

    const [optionName, inlineValue] = splitRecognizedShellOption(value, config.optionsWithValue);
    args.push(word);
    if (config.optionsWithValue.has(optionName) && inlineValue === undefined) {
      const optionValue = words[index + 1];
      if (optionValue) args.push(optionValue);
      wrapperOptions.push({ name: optionName, value: optionValue?.value });
      index += OPTION_AND_VALUE_WIDTH;
      continue;
    }

    wrapperOptions.push({ name: optionName, value: inlineValue });
    index++;
  }

  return {
    wrapper: {
      executable: words[wrapperIndex],
      name,
      args,
      options: wrapperOptions,
    },
    nextIndex: index,
  };
}

/** command -v/-V/--help 仅查询命令信息，不会执行后续参数。 */
function isCommandQuery(options: readonly ShellWrapperOption[]): boolean {
  return options.some(({ name }) =>
    COMMAND_QUERY_OPTIONS.has(name) || COMMAND_QUERY_SHORT_OPTIONS.test(name),
  );
}

/** env -S/--split-string 的值会被 env 拆成新的命令及参数。 */
function envSplitSource(options: readonly ShellWrapperOption[]): string | undefined {
  return options.find(({ name }) => ENV_SPLIT_OPTIONS.has(name))?.value;
}

/** 提取 shell -c 或 eval 需要继续解释的字面量源码。 */
function nestedCommandSource(name: string, args: readonly Word[]): string | undefined {
  if (SHELL_LAUNCHERS.has(name)) return shellOptionCommandSource(args);
  return name === EVAL_COMMAND_NAME ? args.map((word) => word.value).join(" ") : undefined;
}

/** 只在脚本文件参数之前解析 shell 选项，避免把 `bash script.sh -c arg` 当作嵌套命令。 */
function shellOptionCommandSource(args: readonly Word[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const option = args[index].value;
    if (option === OPTION_TERMINATOR || option === STANDARD_INPUT_SCRIPT ||
        (!option.startsWith(SHORT_OPTION_PREFIX) && !option.startsWith(ENABLE_OPTION_PREFIX))) {
      return undefined;
    }
    if (option === SHELL_COMMAND_OPTION ||
        (/^-[^-]+$/.test(option) && option.slice(SHORT_OPTION_PREFIX.length).includes(SHELL_COMMAND_FLAG))) {
      return args[index + 1]?.value;
    }

    const [optionName, inlineValue] = splitRecognizedShellOption(option, SHELL_OPTIONS_WITH_VALUE);
    if (SHELL_OPTIONS_WITH_VALUE.has(optionName) && inlineValue === undefined) index++;
  }
  return undefined;
}

/** 识别 --option=value 与 -fVALUE 形式的已知短选项。 */
export function splitRecognizedShellOption(
  value: string,
  recognizedOptions: ReadonlySet<string>,
): [string, string | undefined] {
  const equalsIndex = value.indexOf("=");
  if (equalsIndex !== -1) return [value.slice(0, equalsIndex), value.slice(equalsIndex + 1)];
  if (recognizedOptions.has(value)) return [value, undefined];

  for (const option of recognizedOptions) {
    if (/^-[^-]$/.test(option) && value.startsWith(option) && value.length > option.length) {
      return [option, value.slice(option.length)];
    }
  }
  return [value, undefined];
}

/** Shell 的 NAME=value 赋值不是命令或位置参数。 */
export function isShellAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

/** 统一绝对路径、相对路径和普通命令名。 */
function commandBasename(value: string): string {
  return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
}

/** 将未知 AST 值安全收窄为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
