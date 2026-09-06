import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  analyzeShellCommand,
  isShellAssignment,
  splitRecognizedShellOption,
  type ShellCommandInvocation,
  type ShellWord as Word,
  type ShellWrapperInvocation,
} from "./shell-command-utils";

const SINGLE_OPTION_VALUE_COUNT = 1;
const NAME_AND_VALUE_OPTION_COUNT = 2;
const CHANGE_DIRECTORY_COMMAND_NAME = "cd";
const JQ_COMMAND_NAME = "jq";
const DATA_ONLY_COMMANDS = new Set(["echo", "printf"]);
const GREP_COMMANDS = new Set(["egrep", "fgrep", "grep", "rg", "ripgrep"]);
const SED_COMMANDS = new Set(["gsed", "sed"]);
const AWK_COMMANDS = new Set(["awk", "gawk", "mawk", "nawk"]);
const FILE_TEST_OPERATORS = new Set([
  "-a", "-b", "-c", "-d", "-e", "-f", "-g", "-h", "-k", "-L", "-N", "-O",
  "-p", "-r", "-s", "-S", "-t", "-u", "-w", "-x",
]);
const FILE_COMPARISON_OPERATORS = new Set(["-ef", "-nt", "-ot"]);
const INLINE_PATH_OPTIONS = new Set([
  "--cache-dir",
  "--chdir",
  "--config",
  "--cwd",
  "--directory",
  "--file",
  "--git-dir",
  "--ignore-file",
  "--input",
  "--output",
  "--prefix",
  "--project",
  "--root",
  "--source",
  "--target",
  "--temp-dir",
  "--tmpdir",
  "--work-tree",
]);

interface PatternPathOptions {
  args: readonly Word[];
  auxiliaryPathOptions: ReadonlySet<string>;
  explicitPatternOptions: ReadonlySet<string>;
  patternPathOptions: ReadonlySet<string>;
  valueOptionWidths: Readonly<Record<string, number>>;
}

export interface BashPathViolation {
  inputPath: string;
  resolvedPath: string;
}

const EMPTY_OPTIONS = new Set<string>();
const WRAPPER_PATH_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-D", "--chdir", "-R", "--chroot"]),
  env: new Set(["-C", "--chdir"]),
};

const GREP_PATTERN_PATH_OPTIONS = new Set(["-f", "--file"]);
const GREP_AUXILIARY_PATH_OPTIONS = new Set(["--ignore-file"]);
const GREP_EXPLICIT_PATTERN_OPTIONS = new Set(["-e", "--regexp"]);
const GREP_VALUE_OPTION_WIDTHS: Readonly<Record<string, number>> = {
  "-A": SINGLE_OPTION_VALUE_COUNT,
  "--after-context": SINGLE_OPTION_VALUE_COUNT,
  "-B": SINGLE_OPTION_VALUE_COUNT,
  "--before-context": SINGLE_OPTION_VALUE_COUNT,
  "-C": SINGLE_OPTION_VALUE_COUNT,
  "--context": SINGLE_OPTION_VALUE_COUNT,
  "--colors": SINGLE_OPTION_VALUE_COUNT,
  "--context-separator": SINGLE_OPTION_VALUE_COUNT,
  "--encoding": SINGLE_OPTION_VALUE_COUNT,
  "--engine": SINGLE_OPTION_VALUE_COUNT,
  "-e": SINGLE_OPTION_VALUE_COUNT,
  "--exclude": SINGLE_OPTION_VALUE_COUNT,
  "--exclude-dir": SINGLE_OPTION_VALUE_COUNT,
  "--field-context-separator": SINGLE_OPTION_VALUE_COUNT,
  "--field-match-separator": SINGLE_OPTION_VALUE_COUNT,
  "-g": SINGLE_OPTION_VALUE_COUNT,
  "--glob": SINGLE_OPTION_VALUE_COUNT,
  "--hostname-bin": SINGLE_OPTION_VALUE_COUNT,
  "--hyperlink-format": SINGLE_OPTION_VALUE_COUNT,
  "--iglob": SINGLE_OPTION_VALUE_COUNT,
  "--include": SINGLE_OPTION_VALUE_COUNT,
  "--label": SINGLE_OPTION_VALUE_COUNT,
  "-m": SINGLE_OPTION_VALUE_COUNT,
  "--max-count": SINGLE_OPTION_VALUE_COUNT,
  "--path-separator": SINGLE_OPTION_VALUE_COUNT,
  "--pre": SINGLE_OPTION_VALUE_COUNT,
  "--pre-glob": SINGLE_OPTION_VALUE_COUNT,
  "--regexp": SINGLE_OPTION_VALUE_COUNT,
  "--replace": SINGLE_OPTION_VALUE_COUNT,
  "--sort": SINGLE_OPTION_VALUE_COUNT,
  "--sortr": SINGLE_OPTION_VALUE_COUNT,
  "-t": SINGLE_OPTION_VALUE_COUNT,
  "--type": SINGLE_OPTION_VALUE_COUNT,
  "--type-add": SINGLE_OPTION_VALUE_COUNT,
  "--type-clear": SINGLE_OPTION_VALUE_COUNT,
};
const SED_PATTERN_PATH_OPTIONS = new Set(["-f", "--file"]);
const SED_EXPLICIT_PATTERN_OPTIONS = new Set(["-e", "--expression"]);
const SED_VALUE_OPTION_WIDTHS: Readonly<Record<string, number>> = {
  "-e": SINGLE_OPTION_VALUE_COUNT,
  "--expression": SINGLE_OPTION_VALUE_COUNT,
};
const AWK_PATTERN_PATH_OPTIONS = new Set(["-f", "--file"]);
const AWK_VALUE_OPTION_WIDTHS: Readonly<Record<string, number>> = {
  "-F": SINGLE_OPTION_VALUE_COUNT,
  "--field-separator": SINGLE_OPTION_VALUE_COUNT,
  "-v": SINGLE_OPTION_VALUE_COUNT,
  "--assign": SINGLE_OPTION_VALUE_COUNT,
};
const JQ_FILTER_FILE_OPTIONS = new Set(["-f", "--from-file"]);
const JQ_LIBRARY_PATH_OPTIONS = new Set(["-L"]);
const JQ_FILE_BINDING_OPTIONS = new Set(["--rawfile", "--slurpfile"]);
const JQ_VALUE_OPTION_WIDTHS: Readonly<Record<string, number>> = {
  "--arg": NAME_AND_VALUE_OPTION_COUNT,
  "--argjson": NAME_AND_VALUE_OPTION_COUNT,
};

/** 找出 Bash 命令中显式引用、但不在允许目录内的本地路径。 */
export function findOutOfScopeBashPaths(
  command: string,
  cwd: string,
  roots: readonly string[],
): BashPathViolation[] {
  const allowedRoots = canonicalRoots(roots.map((root) => {
    const expanded = expandKnownPathPrefix(root, cwd);
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  }));
  const referencedPaths = collectReferencedPaths(command);
  const violations: BashPathViolation[] = [];
  const seen = new Set<string>();

  for (const inputPath of referencedPaths) {
    const resolvedPath = resolveReferencedPath(inputPath, cwd);
    if (!resolvedPath) continue;
    if (allowedRoots.some((root) => isWithinRoot(resolvedPath, root))) continue;

    const key = `${inputPath}\0${resolvedPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({ inputPath, resolvedPath });
  }

  return violations;
}

/** 从共享 Shell 分析结果收集命令参数、wrapper、重定向和文件测试中的路径。 */
function collectReferencedPaths(command: string): string[] {
  const analysis = analyzeShellCommand(command);
  const references = [
    ...analysis.wrappers.flatMap((wrapper) => wrapperPaths(wrapper)),
    ...analysis.commands.flatMap((invocation) => commandPaths(invocation)),
  ];

  for (const node of analysis.nodes) {
    if ((node.type === "For" || node.type === "Select") && Array.isArray(node.wordlist)) {
      references.push(...node.wordlist.flatMap((word) => wordValueCandidates(word)));
    }
    if (node.type === "TestUnary" && FILE_TEST_OPERATORS.has(String(node.operator))) {
      references.push(...wordValueCandidates(node.operand));
    }
    if (node.type === "TestBinary" && FILE_COMPARISON_OPERATORS.has(String(node.operator))) {
      references.push(...wordValueCandidates(node.left), ...wordValueCandidates(node.right));
    }
    if (isFileRedirect(node)) references.push(...wordValueCandidates(node.target, true));
  }

  return references;
}

/** 按实际命令语义提取可执行文件和参数中的路径。 */
function commandPaths(invocation: ShellCommandInvocation): string[] {
  const paths = executablePathCandidates(invocation.executable.value);
  if (invocation.nestedSource !== undefined) return paths;
  if (invocation.name === CHANGE_DIRECTORY_COMMAND_NAME) return [...paths, ...cdPaths(invocation.args)];
  if (DATA_ONLY_COMMANDS.has(invocation.name)) return paths;
  if (GREP_COMMANDS.has(invocation.name)) {
    return [...paths, ...patternCommandPaths({
      args: invocation.args,
      auxiliaryPathOptions: GREP_AUXILIARY_PATH_OPTIONS,
      explicitPatternOptions: GREP_EXPLICIT_PATTERN_OPTIONS,
      patternPathOptions: GREP_PATTERN_PATH_OPTIONS,
      valueOptionWidths: GREP_VALUE_OPTION_WIDTHS,
    })];
  }
  if (SED_COMMANDS.has(invocation.name)) {
    return [...paths, ...patternCommandPaths({
      args: invocation.args,
      auxiliaryPathOptions: EMPTY_OPTIONS,
      explicitPatternOptions: SED_EXPLICIT_PATTERN_OPTIONS,
      patternPathOptions: SED_PATTERN_PATH_OPTIONS,
      valueOptionWidths: SED_VALUE_OPTION_WIDTHS,
    })];
  }
  if (AWK_COMMANDS.has(invocation.name)) {
    return [...paths, ...patternCommandPaths({
      args: invocation.args,
      auxiliaryPathOptions: EMPTY_OPTIONS,
      explicitPatternOptions: EMPTY_OPTIONS,
      patternPathOptions: AWK_PATTERN_PATH_OPTIONS,
      valueOptionWidths: AWK_VALUE_OPTION_WIDTHS,
    })];
  }
  if (invocation.name === JQ_COMMAND_NAME) return [...paths, ...jqPaths(invocation.args)];

  return [...paths, ...invocation.args.flatMap((word) => pathCandidates(word.value))];
}

/** wrapper 的目录型选项和路径形式可执行文件同样受目录范围约束。 */
function wrapperPaths(wrapper: ShellWrapperInvocation): string[] {
  const paths = executablePathCandidates(wrapper.executable.value);
  const pathOptions = WRAPPER_PATH_OPTIONS[wrapper.name];
  if (!pathOptions) return paths;

  for (const option of wrapper.options) {
    if (option.value !== undefined && pathOptions.has(option.name)) {
      paths.push(...pathCandidates(option.value));
    }
  }
  return paths;
}

/** 路径形式的可执行文件也接受同一目录策略，不隐式信任 PATH 或 skills。 */
function executablePathCandidates(value: string): string[] {
  return value.includes("/") || value.includes("\\") ? [value] : [];
}

/** 解析 cd 的默认 HOME、cd - 和普通目录参数。 */
function cdPaths(args: readonly Word[]): string[] {
  let optionsEnded = false;

  for (const arg of args) {
    const value = arg.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") continue;
    if (value === "-") return process.env.OLDPWD ? [process.env.OLDPWD] : [];
    return pathCandidates(value);
  }

  return [homedir()];
}

/** 对 grep/sed/awk 一类“首个位置参数是模式”的命令，仅保留真实文件参数。 */
function patternCommandPaths(options: PatternPathOptions): string[] {
  const paths: string[] = [];
  const recognizedOptions = new Set([
    ...options.auxiliaryPathOptions,
    ...options.explicitPatternOptions,
    ...options.patternPathOptions,
    ...Object.keys(options.valueOptionWidths),
  ]);
  let firstPositionalConsumed = false;
  let optionsEnded = false;

  for (let index = 0; index < options.args.length; index++) {
    const value = options.args[index].value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      const [optionName, inlineValue] = splitRecognizedShellOption(value, recognizedOptions);
      const isPatternPath = options.patternPathOptions.has(optionName);
      const isAuxiliaryPath = options.auxiliaryPathOptions.has(optionName);
      if (isPatternPath || isAuxiliaryPath) {
        const pathValue = inlineValue ?? options.args[++index]?.value;
        if (pathValue) paths.push(...pathCandidates(pathValue));
        if (isPatternPath) firstPositionalConsumed = true;
        continue;
      }

      const valueWidth = options.valueOptionWidths[optionName] ?? 0;
      if (!inlineValue) index += valueWidth;
      if (options.explicitPatternOptions.has(optionName)) firstPositionalConsumed = true;
      continue;
    }

    if (!firstPositionalConsumed) {
      firstPositionalConsumed = true;
      continue;
    }
    paths.push(...pathCandidates(value));
  }

  return paths;
}

/** 按 jq 参数语义区分 filter、模块目录、绑定文件和输入文件。 */
function jqPaths(args: readonly Word[]): string[] {
  const paths: string[] = [];
  const recognizedOptions = new Set([
    ...JQ_FILTER_FILE_OPTIONS,
    ...JQ_LIBRARY_PATH_OPTIONS,
    ...JQ_FILE_BINDING_OPTIONS,
    ...Object.keys(JQ_VALUE_OPTION_WIDTHS),
  ]);
  let filterProvided = false;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index++) {
    const value = args[index].value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      const [optionName, inlineValue] = splitRecognizedShellOption(value, recognizedOptions);
      if (JQ_FILTER_FILE_OPTIONS.has(optionName)) {
        const pathValue = inlineValue ?? args[++index]?.value;
        if (pathValue) paths.push(...pathCandidates(pathValue));
        filterProvided = true;
        continue;
      }
      if (JQ_LIBRARY_PATH_OPTIONS.has(optionName)) {
        const pathValue = inlineValue ?? args[++index]?.value;
        if (pathValue) paths.push(...pathCandidates(pathValue));
        continue;
      }
      if (JQ_FILE_BINDING_OPTIONS.has(optionName)) {
        const pathValue = inlineValue ?? args[index + NAME_AND_VALUE_OPTION_COUNT]?.value;
        if (pathValue) paths.push(...pathCandidates(pathValue));
        if (!inlineValue) index += NAME_AND_VALUE_OPTION_COUNT;
        continue;
      }

      const valueWidth = JQ_VALUE_OPTION_WIDTHS[optionName] ?? 0;
      if (!inlineValue) index += valueWidth;
      continue;
    }

    if (!filterProvided) {
      filterProvided = true;
      continue;
    }
    paths.push(...pathCandidates(value));
  }

  return paths;
}

/** 将参数词转换为路径候选；普通非选项词也保留，以识别无斜杠的符号链接。 */
function pathCandidates(value: string): string[] {
  if (!value || isShellAssignment(value)) return [];
  if (looksLikeUrl(value) && !value.startsWith("file://")) return [];

  if (!value.startsWith("-") || value === "-") return [value];

  const [optionName, inlineValue] = splitOption(value);
  if (inlineValue && INLINE_PATH_OPTIONS.has(optionName)) return [inlineValue];

  const shortMatch = value.match(/^-[CIL](.+)$/);
  return shortMatch ? [shortMatch[1]] : [];
}

/** 从未知 AST 值中读取 Word.value，并按需强制把重定向目标视为路径。 */
function wordValueCandidates(value: unknown, force = false): string[] {
  if (!isRecord(value) || typeof value.value !== "string") return [];
  return force ? [value.value] : pathCandidates(value.value);
}

/** 展开已知目录前缀并通过最近存在祖先解析符号链接。 */
function resolveReferencedPath(input: string, cwd: string): string | null {
  let value = input;
  if (value.startsWith("file://")) {
    value = decodeURIComponent(new URL(value).pathname);
  }

  value = expandKnownPathPrefix(value, cwd);
  if (!value || startsWithUnknownExpansion(value)) return null;

  const absolutePath = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  return canonicalizePotentialPath(absolutePath);
}

/** 规范化允许根目录并去重，避免符号链接别名绕过范围判断。 */
function canonicalRoots(paths: readonly string[]): string[] {
  const roots = paths
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => canonicalizePotentialPath(resolve(value)));
  return [...new Set(roots)];
}

/** 对不存在的目标向上寻找最近存在祖先，再 realpath 以阻断 symlink 越界。 */
function canonicalizePotentialPath(input: string): string {
  let current = resolve(input);
  const missingSegments: string[] = [];

  while (!lstatExists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missingSegments.unshift(basename(current));
    current = parent;
  }

  const realBase = realpathSync(current);
  return missingSegments.length > 0 ? join(realBase, ...missingSegments) : realBase;
}

/** 判断候选路径是否等于允许根目录或位于其后代中。 */
function isWithinRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** 将 --option=value 拆为选项名和值。 */
function splitOption(value: string): [string, string | undefined] {
  const equalsIndex = value.indexOf("=");
  if (equalsIndex === -1) return [value, undefined];
  return [value.slice(0, equalsIndex), value.slice(equalsIndex + 1)];
}

/** 只展开可确定的 HOME/PWD/OLDPWD/TMPDIR 与波浪号前缀。 */
function expandKnownPathPrefix(value: string, cwd: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice("~/".length));

  const replacements: Array<[RegExp, string | undefined]> = [
    [/^\$\{?HOME\}?/, homedir()],
    [/^\$\{?PWD\}?/, cwd],
    [/^\$\{?OLDPWD\}?/, process.env.OLDPWD],
    [/^\$\{?TMPDIR\}?/, process.env.TMPDIR],
  ];

  for (const [pattern, replacement] of replacements) {
    if (replacement && pattern.test(value)) return value.replace(pattern, replacement);
  }
  return value;
}

/** 未知变量或命令替换位于路径开头时无法静态确定，交由 shell 自身处理。 */
function startsWithUnknownExpansion(value: string): boolean {
  return value.startsWith("$") || value.startsWith("`");
}

/** 排除 http/ssh 等远程 URL，file:// 由本地路径逻辑单独处理。 */
function looksLikeUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
}

/** lstat 同时识别普通路径和指向不存在目标的符号链接。 */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 将 unknown 安全收窄为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 识别会打开文件的重定向节点，排除 heredoc、herestring 和 fd 复制。 */
function isFileRedirect(value: Record<string, unknown>): boolean {
  const operator = value.operator;
  const isFileOperator = operator === ">" || operator === ">>" || operator === "<" ||
    operator === "<>" || operator === ">|" || operator === "&>" || operator === "&>>";
  return isFileOperator && "target" in value && "fileDescriptor" in value;
}
