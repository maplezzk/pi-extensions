/**
 * 规格文档的 frontmatter 派生显示层（纯函数）
 *
 * 边界（与 state.json 的分工）：
 * - state.json 是唯一真相。本模块写进文档的 frontmatter 由插件从 state 派生并覆盖写入，
 *   读取状态时一律忽略；因此文档里出现 `approval: human` 不构成批准，也不能用来推进阶段。
 * - 文档指纹只覆盖 frontmatter 之后的正文，所以同步阶段、审批与进度不会让已有批准失效。
 * - 没有 frontmatter 的文档正文即全文，指纹与 v1 记录完全一致，旧规格天然兼容。
 */

import { createHash } from "node:crypto";
import type { Artifact, StateFile } from "./state.ts";

const FENCE = "---";
/** 结束分隔行：容忍行尾空白与 CRLF。 */
const CLOSING_FENCE = /^---[ \t]*\r?$/m;

/** 派生显示字段；全部来自 state.json，不包含任何独立信息。 */
export interface FrontmatterFields {
  slug: string;
  artifact: Artifact;
  title: string;
  profile: string;
  phase: string;
  status: string;
  approval: "human" | "accepted-by-profile" | "pending" | "draft";
  approvedAt: string | null;
  taskProgress: { done: number; total: number } | null;
  notice: string;
}

/**
 * 正文起点：完整 frontmatter 区块（含结束行与其换行）之后的字符偏移。
 * 没有区块、或开头分隔行未闭合时返回 0——未闭合时按全文处理，
 * 避免把作者正文当成 frontmatter 删掉。
 */
export function bodyOffset(text: string): number {
  if (!text.startsWith(FENCE)) return 0;
  const headerEnd = text.indexOf("\n");
  if (headerEnd < 0 || text.slice(0, headerEnd).trim() !== FENCE) return 0;
  const rest = text.slice(headerEnd + 1);
  const closing = CLOSING_FENCE.exec(rest);
  if (!closing) return 0;
  let offset = headerEnd + 1 + closing.index + closing[0].length;
  if (text[offset] === "\r") offset += 1;
  if (text[offset] === "\n") offset += 1;
  return offset;
}

/** 文档正文：去掉 frontmatter 区块后的原文。 */
export function stripFrontmatter(text: string): string {
  return text.slice(bodyOffset(text));
}

/**
 * 正文指纹。按字节切分而不是重新编码整段文本：
 * 文件含无效 UTF-8 字节时重新编码会改变指纹，字节切片不会。
 */
export function documentDigest(raw: Buffer | string): string {
  const buffer = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const text = buffer.toString("utf8");
  const offset = bodyOffset(text);
  const bytes =
    offset === 0
      ? buffer
      : buffer.subarray(Buffer.byteLength(text.slice(0, offset), "utf8"));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** YAML 双引号标量；用 JSON 转义，YAML 与 JSON 的转义规则在此集合上一致。 */
function quote(value: string): string {
  return JSON.stringify(value);
}

/** 单行注释：换行会破坏注释行，统一折叠成空格。 */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/** 渲染完整的 frontmatter 区块（含结束行与换行），键顺序固定，便于逐字节比较。 */
export function renderFrontmatter(fields: FrontmatterFields): string {
  const lines = [
    FENCE,
    `# ${singleLine(fields.notice)}`,
    `spec: ${fields.slug}`,
    `artifact: ${fields.artifact}`,
    `title: ${quote(fields.title)}`,
    `profile: ${fields.profile}`,
    `phase: ${fields.phase}`,
    `status: ${fields.status}`,
    `approval: ${fields.approval}`,
  ];
  if (fields.approvedAt) lines.push(`approved_at: ${fields.approvedAt}`);
  if (fields.taskProgress) {
    lines.push(`tasks_done: ${fields.taskProgress.done}/${fields.taskProgress.total}`);
  }
  lines.push(FENCE);
  return `${lines.join("\n")}\n`;
}

/** 用派生 frontmatter 替换文档顶部区块；正文保持逐字节不变。 */
export function withFrontmatter(text: string, fields: FrontmatterFields): string {
  return renderFrontmatter(fields) + text.slice(bodyOffset(text));
}

/** 当前文档是否已经与派生结果一致：一致就不重写，避免无谓的 mtime 抖动。 */
export function frontmatterUpToDate(
  text: string,
  fields: FrontmatterFields,
): boolean {
  return text.startsWith(renderFrontmatter(fields));
}

export interface FrontmatterSource {
  state: StateFile;
  artifact: Artifact;
  /** 仅 tasks.md 有进度：已完成/任务总数。 */
  taskProgress: { done: number; total: number } | null;
  /** 已本地化的「本区块为派生内容」提示行。 */
  notice: string;
}

/**
 * 从 state.json 派生某份文档的 frontmatter。
 * approval 只是把 state 里的审批记录翻译成人能读的一行，永不反向写回。
 */
export function frontmatterFor({
  state,
  artifact,
  taskProgress,
  notice,
}: FrontmatterSource): FrontmatterFields {
  const record = state.artifacts[artifact];
  const approval = record.approvedSha256
    ? record.approvalKind === "accepted-by-profile"
      ? "accepted-by-profile"
      : "human"
    : record.sha256
      ? "pending"
      : "draft";
  return {
    slug: state.id,
    artifact,
    title: state.title,
    profile: state.profile,
    phase: state.phase,
    status: state.status,
    approval,
    approvedAt: record.approvedAt ?? null,
    taskProgress,
    notice,
  };
}
