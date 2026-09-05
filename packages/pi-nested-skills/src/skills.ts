import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const SKILL_FILE_NAME = "SKILL.md";
const PATH_SEPARATOR = ".";

export interface NestedSkill {
  /** 根目录下的技能包名称。 */
  packName: string;
  /** 技能包内的目录标识，嵌套层级用点号连接。 */
  skillDir: string;
  /** SKILL.md frontmatter 中的技能名称。 */
  skillName: string;
  /** SKILL.md frontmatter 中的技能说明。 */
  description: string;
  /** SKILL.md 的绝对路径。 */
  skillPath: string;
  /** 从技能包目录开始计算的层级，顶层为 1。 */
  depth: number;
}

export interface SkillScanWarning {
  path: string;
  reason: string;
}

export interface SkillScanResult {
  /** 交给 Pi 原生 loader 的全部 SKILL.md 文件路径。 */
  skillPaths: string[];
  /** 具有有效 description、可用于别名和补全的技能。 */
  skills: NestedSkill[];
  warnings: SkillScanWarning[];
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/** 跳过隐藏目录、依赖目录和特殊目录，行为与 Pi 技能发现保持一致。 */
export function isVisibleSkillDirectory(name: string): boolean {
  return !name.startsWith(".") && name !== "node_modules" && name !== ".DS_Store";
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 读取技能所需的两个 frontmatter 字段。
 * 完整的技能解析和正文展开仍由 Pi 原生 loader 负责；这里仅建立别名索引。
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const result: SkillFrontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(name|description):\s*(.*)$/);
    if (!field) continue;
    const value = unquote(field[2]);
    if (field[1] === "name") result.name = value;
    else result.description = value;
  }
  return result;
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readSkillFile(
  skillPath: string,
  packName: string,
  packDir: string,
  segments: string[],
  warnings: SkillScanWarning[],
): NestedSkill | undefined {
  let content: string;
  try {
    content = readFileSync(skillPath, "utf8");
  } catch (error) {
    warnings.push({
      path: skillPath,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const frontmatter = parseSkillFrontmatter(content);
  const description = frontmatter.description?.trim() ?? "";
  if (!description) {
    // 仍把文件交给 Pi 原生 loader，让 Pi 的标准诊断负责报告格式问题。
    return undefined;
  }

  const relativeDir = relative(packDir, dirname(skillPath));
  const relativeSegments = relativeDir
    ? relativeDir.split(/[\\/]/).filter(Boolean)
    : segments;
  const skillDir = relativeSegments.join(PATH_SEPARATOR);

  return {
    packName,
    skillDir,
    skillName: frontmatter.name?.trim() || basename(skillPath.replace(/[\\/]SKILL\.md$/, "")),
    description,
    skillPath,
    depth: Math.max(relativeSegments.length, 1),
  };
}

function scanPack(
  packDir: string,
  packName: string,
  packRoot: string,
  segments: string[],
  result: SkillScanResult,
  visitedDirectories: Set<string>,
  visitedFiles: Set<string>,
): void {
  const realDirectory = resolveRealPath(packDir);
  if (visitedDirectories.has(realDirectory)) return;
  visitedDirectories.add(realDirectory);

  let entries;
  try {
    entries = readdirSync(packDir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch (error) {
    result.warnings.push({
      path: packDir,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const skillPath = join(packDir, SKILL_FILE_NAME);
  if (existsSync(skillPath)) {
    const realSkillPath = resolveRealPath(skillPath);
    if (!visitedFiles.has(realSkillPath)) {
      visitedFiles.add(realSkillPath);
      result.skillPaths.push(skillPath);
      const skill = readSkillFile(skillPath, packName, packRoot, segments, result.warnings);
      if (skill) result.skills.push(skill);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!isVisibleSkillDirectory(entry.name)) continue;

    const childPath = join(packDir, entry.name);
    try {
      if (!statSync(childPath).isDirectory()) continue;
    } catch (error) {
      result.warnings.push({
        path: childPath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    scanPack(
      childPath,
      packName,
      packRoot,
      [...segments, entry.name],
      result,
      visitedDirectories,
      visitedFiles,
    );
  }
}

function scanRoot(
  root: string,
  result: SkillScanResult,
  visitedDirectories: Set<string>,
  visitedFiles: Set<string>,
): void {
  if (!existsSync(root)) {
    result.warnings.push({ path: root, reason: "directory does not exist" });
    return;
  }

  let rootIsDirectory = false;
  try {
    rootIsDirectory = lstatSync(root).isDirectory();
  } catch (error) {
    result.warnings.push({
      path: root,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!rootIsDirectory) {
    result.warnings.push({ path: root, reason: "skill root is not a directory" });
    return;
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch (error) {
    result.warnings.push({
      path: root,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // 支持把单个技能目录直接作为 root，同时保留“root 下是多个技能包”的约定。
  if (entries.some((entry) => entry.name === SKILL_FILE_NAME)) {
    scanPack(root, basename(root), root, [], result, visitedDirectories, visitedFiles);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!isVisibleSkillDirectory(entry.name)) continue;
    const packPath = join(root, entry.name);
    try {
      if (!statSync(packPath).isDirectory()) continue;
    } catch (error) {
      result.warnings.push({
        path: packPath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    scanPack(packPath, entry.name, packPath, [], result, visitedDirectories, visitedFiles);
  }
}

/** 递归发现多个技能根目录下的全部嵌套技能。 */
export function scanSkillRoots(roots: readonly string[]): SkillScanResult {
  const result: SkillScanResult = {
    skillPaths: [],
    skills: [],
    warnings: [],
  };
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();

  for (const root of roots) {
    scanRoot(root, result, visitedDirectories, visitedFiles);
  }
  return result;
}
