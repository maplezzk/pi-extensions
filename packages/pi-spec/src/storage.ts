import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SPEC_DIR_NAME, parseSpecSlug, stateFileFor } from "./policy.ts";
import { i18n } from "./i18n.ts";
import {
  ARTIFACTS,
  LEGACY_STATE_SCHEMA,
  STAGE_ORDER,
  STATE_SCHEMA,
  type Phase,
  type StateFile,
  type Status,
} from "./state.ts";

const PROFILES = ["strict", "quick"];
const QUICK_PROFILE = "quick";
const PROFILE_ACCEPTED = "accepted-by-profile";
const APPROVAL_KINDS = ["human", PROFILE_ACCEPTED];
const QUICK_ARTIFACTS = ["requirements", "design"];
const AWAITING_APPROVAL = "awaiting_approval";
const DOCUMENT_STATUSES = ["drafting", AWAITING_APPROVAL];
const PHASE_STATUSES: Record<string, string[]> = {
  requirements: DOCUMENT_STATUSES, design: DOCUMENT_STATUSES, tasks: DOCUMENT_STATUSES,
  implementation: ["in_progress"], verification: DOCUMENT_STATUSES, complete: ["done"],
};

/** 持久化文件必须是普通对象，数组不能冒充记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 支持的磁盘协议版本；两版记录形状相同，只差文档指纹口径。 */
function isSupportedSchema(value: unknown): boolean {
  return value === STATE_SCHEMA || value === LEGACY_STATE_SCHEMA;
}

/** 校验 v1/v2 的形状与审批链；只兼容缺失进度，不修补损坏授权。 */
function validState(value: unknown, slug: string): value is StateFile {
  if (!isRecord(value) || !isSupportedSchema(value.schema) || value.id !== slug ||
      typeof value.title !== "string" || typeof value.profile !== "string" || !PROFILES.includes(value.profile) ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      !isRecord(value.artifacts)) return false;
  const phaseIndex = STAGE_ORDER.indexOf(value.phase as StateFile["phase"]);
  if (phaseIndex < 0) return false;
  const statuses = PHASE_STATUSES[String(value.phase)];
  if (typeof value.status !== "string" || !statuses.includes(value.status)) return false;
  if (value.activeTask !== null && (typeof value.activeTask !== "string" || !/^TASK-[A-Za-z0-9_-]+$/.test(value.activeTask))) return false;
  if (value.completedTasks !== undefined && (!Array.isArray(value.completedTasks) ||
      !value.completedTasks.every((id) => typeof id === "string" && /^TASK-[A-Za-z0-9_-]+$/.test(id)) ||
      new Set(value.completedTasks).size !== value.completedTasks.length)) return false;
  for (const artifact of ARTIFACTS) {
    const record = value.artifacts[artifact];
    if (!isRecord(record)) return false;
    for (const key of ["sha256", "approvedSha256"]) {
      if (record[key] !== undefined && (typeof record[key] !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(record[key]))) return false;
    }
    const upstream = STAGE_ORDER.indexOf(artifact) < phaseIndex;
    if (upstream) {
      if (!record.approvedSha256 || record.approvedSha256 !== record.sha256 ||
          typeof record.approvalKind !== "string" || !APPROVAL_KINDS.includes(record.approvalKind) ||
          typeof record.approvedAt !== "string" || !Number.isFinite(Date.parse(record.approvedAt))) return false;
      if (record.approvalKind === PROFILE_ACCEPTED &&
          (value.profile !== QUICK_PROFILE || !QUICK_ARTIFACTS.includes(artifact))) return false;
    } else {
      if (record.approvedSha256 !== undefined || record.approvalKind !== undefined || record.approvedAt !== undefined) return false;
      const awaiting = artifact === value.phase && value.status === AWAITING_APPROVAL;
      if (awaiting ? !record.sha256 : record.sha256 !== undefined) return false;
    }
  }
  return true;
}

/**
 * 读取 v1/v2 状态，统一升级成当前协议：补上早期记录缺失的 completedTasks，
 * 并把 schema 标记改为 STATE_SCHEMA。v1 与 v2 记录形状相同，因此升级不涉及换哈希：
 * 无 frontmatter 的旧文档正文即全文，与 v1 指纹字节一致。
 */
export function loadState(cwd: string, slug: string): StateFile {
  if (parseSpecSlug(slug) !== slug) throw new Error(i18n.t("errors.stateSchema"));
  const path = stateFileFor(cwd, slug);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validState(parsed, slug)) throw new Error(i18n.t("errors.stateSchema"));
  return { ...parsed, schema: STATE_SCHEMA, completedTasks: parsed.completedTasks ?? [] };
}

/** 磁盘上的一个规格；损坏条目用 error 明确表示，并带 null 状态。 */
export type SpecSummary =
  | { slug: string; error: null; title: string; phase: Phase; status: Status }
  | { slug: string; error: string; title: null; phase: null; status: null };

/** 把未知异常归一化成可直接展示给用户的字符串。 */
const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 列出磁盘上的规格供菜单与补全选择。
 * 损坏条目保留在列表中并带明确原因，不静默隐藏，也不阻断其他规格。
 * 目录不存在或不可读时返回空列表：这是「没有可选规格」，不是列表本身失败。
 */
export function listSpecs(cwd: string): SpecSummary[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(resolve(cwd, SPEC_DIR_NAME), { withFileTypes: true });
  } catch {
    // 不做 existsSync 预检：预检与读取之间的竞态会把可预期的缺失变成异常。
    return [];
  }
  const slugs = entries
    .filter((entry) => entry.isDirectory() && parseSpecSlug(entry.name) === entry.name)
    .map((entry) => entry.name)
    .sort();
  return slugs.map((slug) => {
    try {
      const state = loadState(cwd, slug);
      return { slug, title: state.title, phase: state.phase, status: state.status, error: null };
    } catch (error) {
      return { slug, title: null, phase: null, status: null, error: reasonOf(error) };
    }
  });
}

/** revision 检查后使用独立临时文件替换；不提供跨进程事务锁。 */
export function saveState({
  cwd,
  slug,
  state,
  expectedRevision = state.revision - 1,
}: {
  cwd: string;
  slug: string;
  state: StateFile;
  expectedRevision?: number;
}): void {
  const path = stateFileFor(cwd, slug);
  if (existsSync(path)) {
    const current = loadState(cwd, slug);
    if (current.revision !== expectedRevision) {
      throw new Error(
        i18n.t("errors.revisionConflict", { disk: current.revision, expected: expectedRevision }),
      );
    }
  } else if (expectedRevision !== 0) {
    throw new Error(i18n.t("errors.stateMissing"));
  }
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

