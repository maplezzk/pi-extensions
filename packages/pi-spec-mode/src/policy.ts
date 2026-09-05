/**
 * 路径与工具策略（纯函数，仅依赖 node:path / node:fs 的 realpath）
 */

import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { computeWriteArtifact, type Artifact, type StateFile } from "./state.ts";

export const SPEC_DIR_NAME = ".pi/specs";
export const STATE_FILE_NAME = "state.json";
export const BASH_TOOL = "bash";

export const PLANNING_DENIED_TOOLS = new Set([
  BASH_TOOL,
  "edit",
  "write",
  "spec_submit",
]);
export const TAIL_TOOLS = ["write", "edit", "spec_submit"];

export function specDirFor(cwd: string, slug: string): string {
  return resolve(cwd, SPEC_DIR_NAME, slug);
}

export function stateFileFor(cwd: string, slug: string): string {
  return resolve(specDirFor(cwd, slug), STATE_FILE_NAME);
}

export function artifactFileFor(
  cwd: string,
  slug: string,
  artifact: Artifact,
): string {
  return resolve(specDirFor(cwd, slug), `${artifact}.md`);
}

function realOrFallback(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // 文件可能尚未创建：找到最近存在的祖先，realpath 后拼接剩余层级，
    // 仍能防目录级 symlink 逃逸
    let cur = p;
    const parts: string[] = [];
    for (;;) {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      parts.unshift(basename(cur));
      cur = parent;
      try {
        return resolve(realpathSync(cur), ...parts);
      } catch {
        continue;
      }
    }
  }
}

/**
 * inputPath（相对 cwd 或绝对）解析后必须位于 base 内。
 * 使用 realpath 语义：防 ../ 穿越、绝对路径逃逸和符号链接逃逸。
 */
export function resolveInside(base: string, inputPath: string): boolean {
  if (!inputPath) return false;
  const baseReal = realOrFallback(base);
  const targetReal = realOrFallback(resolve(base, inputPath));
  const rel = relative(baseReal, targetReal);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return true;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseSpecSlug(input: string): string | null {
  const trimmed = input.trim();
  if (!SLUG_RE.test(trimmed)) return null;
  return trimmed;
}

/** 两个路径经 realpath/最近存在祖先解析后是否指向同一路径。 */
export function sameResolvedPath(left: string, right: string): boolean {
  return realOrFallback(left) === realOrFallback(right);
}

/** 路径是否位于项目的 .pi/specs 根目录内。 */
export function isUnderSpecsRoot(cwd: string, absPath: string): boolean {
  const rootReal = realOrFallback(resolve(cwd, SPEC_DIR_NAME));
  const targetReal = realOrFallback(absPath);
  const rel = relative(rootReal, targetReal);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 路径是否位于 .pi/specs/<slug>/ 内（执行阶段用于保护规格目录）。 */
export function isUnderSpecDir(
  cwd: string,
  slug: string,
  absPath: string,
): boolean {
  const dir = specDirFor(cwd, slug);
  const dirReal = realOrFallback(dir);
  const targetReal = realOrFallback(absPath);
  const rel = relative(dirReal, targetReal);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isStateFile(absPath: string): boolean {
  return basename(absPath) === STATE_FILE_NAME;
}

/** 当前阶段普通写入工具允许的文档；null 表示无（必须走 /spec revise 或审核流）。 */
export function allowedArtifactForPhase(
  state: StateFile,
  cwd: string,
): { artifact: Artifact; file: string } | null {
  const artifact = computeWriteArtifact(state);
  if (!artifact) return null;
  return {
    artifact,
    file: artifactFileFor(cwd, state.id, artifact),
  };
}

/** 计划阶段工具集：保留非写/非执行工具 + write/edit/spec_submit。 */
export function phaseTools(baseTools: readonly string[]): string[] {
  const kept = baseTools.filter((t) => !PLANNING_DENIED_TOOLS.has(t));
  return [...new Set([...kept, ...TAIL_TOOLS])];
}

/** 验证阶段继承计划工具，并在原工具包含 bash 时保留 bash 用于执行验证。 */
export function verificationTools(baseTools: readonly string[]): string[] {
  const tools = phaseTools(baseTools);
  if (baseTools.includes(BASH_TOOL)) tools.push(BASH_TOOL);
  return [...new Set(tools)];
}

/** 执行阶段工具集：恢复原工具，仅移除 spec_submit。 */
export function executeTools(baseTools: readonly string[]): string[] {
  return baseTools.filter((t) => t !== "spec_submit");
}
