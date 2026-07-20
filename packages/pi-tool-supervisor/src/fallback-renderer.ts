import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/fallback-renderer.json", import.meta.url)));
const SUPERVISOR_TITLE = "⛨ Supervisor";

export const SUPERVISOR_AUDIT_ENTRY_TYPE = "pi-tool-supervisor-audit";

type ReviewerFinding = {
  ruleGroup?: string;
  message?: string;
  line?: number;
};

type ReviewerAudit = {
  name?: string;
  status?: string;
  summary?: string;
  error?: string;
  durationMs?: number;
  rulesFile?: string;
  rulesFiles?: string[];
  findings?: ReviewerFinding[];
};

type SupervisorAudit = {
  status?: string;
  filePath?: string;
  durationMs?: number;
  warnings?: string[];
  reviewers?: ReviewerAudit[];
};

type SupervisorAuditEntry = {
  toolName: string;
  audit: SupervisorAudit;
};

type AuditTone = "accent" | "success" | "muted" | "dim" | "warning" | "error";

type SupervisorAuditView = {
  lines: string[];
  statusLabel: string;
  statusTone: AuditTone;
};

type RenderTheme = {
  fg(color: "accent" | "toolTitle" | "success" | "muted" | "dim" | "warning" | "error" | "text", text: string): string;
  bold(text: string): string;
};

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function appendSection(
  lines: string[],
  branch: "├─" | "└─",
  label: string,
  text: string,
  details: string[] = [],
): void {
  const visible = text.replace(/\r/g, "").trim();
  if (!visible) return;
  const [first = "", ...rest] = visible.split("\n");
  lines.push(`${branch} ${label}  ${first}`);
  const continuation = branch === "├─" ? "│       " : "        ";
  lines.push(...rest.map((line) => `${continuation}${line}`));
  for (const detail of details) {
    const detailLines = detail.replace(/\r/g, "").trim().split("\n");
    lines.push(...detailLines.map((line) => `${continuation}${line}`));
  }
}

function statusView(status: string): { label: string; tone: AuditTone } {
  const statuses: Record<string, { label: string; tone: AuditTone }> = {
    passed: { label: i18n.t("passed"), tone: "success" },
    rejected: { label: i18n.t("rejected"), tone: "error" },
    failed: { label: i18n.t("failed"), tone: "warning" },
    skipped: { label: i18n.t("skipped"), tone: "dim" },
    disabled: { label: i18n.t("disabled"), tone: "dim" },
  };
  return statuses[status] ?? { label: status, tone: "muted" };
}

function reviewerStatus(status: string | undefined): { label: string; tone: AuditTone } {
  if (status === "passed") return { label: i18n.t("reviewerPassed"), tone: "success" };
  if (status === "rejected") return { label: i18n.t("reviewerRejected"), tone: "error" };
  if (status === "failed") return { label: i18n.t("reviewerFailed"), tone: "warning" };
  return { label: i18n.t("reviewerSkipped"), tone: "dim" };
}

function reviewerFindingText(finding: ReviewerFinding): string | undefined {
  const message = getString(finding.message);
  if (!message) return undefined;
  const ruleGroup = getString(finding.ruleGroup);
  const line = getFiniteNumber(finding.line);
  const location = line === undefined ? "" : `${i18n.t("line", { line: Math.round(line) })}: `;
  return `${ruleGroup ? `[${ruleGroup}] ` : ""}${location}${message}`;
}

function reviewerDetails(reviewer: ReviewerAudit): string[] {
  const details: string[] = [];
  const summary = getString(reviewer.summary) ?? getString(reviewer.error);
  if (summary) details.push(`${i18n.t("summary")}  ${summary}`);

  const rules = Array.isArray(reviewer.rulesFiles)
    ? reviewer.rulesFiles.filter((file): file is string => Boolean(getString(file)))
    : reviewer.rulesFile ? [reviewer.rulesFile] : [];
  if (rules.length > 0) details.push(`${i18n.t("rules")}  ${rules.join(", ")}`);

  const findings = Array.isArray(reviewer.findings) ? reviewer.findings : [];
  for (const finding of findings) {
    const text = reviewerFindingText(finding);
    if (text) details.push(`${i18n.t("finding")}  ${text}`);
  }
  return details;
}

function sectionLabelTone(label: string): AuditTone {
  if (label === i18n.t("summary")) return "success";
  if (label === i18n.t("finding")) return "error";
  if (label === i18n.t("warning")) return "warning";
  return "accent";
}

function renderSupervisorAuditLine(audit: SupervisorAuditView, line: string, index: number, theme: RenderTheme): string {
  if (index === 0) {
    const title = theme.fg("accent", theme.bold(SUPERVISOR_TITLE));
    const afterTitle = line.slice(SUPERVISOR_TITLE.length);
    const statusIndex = afterTitle.indexOf(audit.statusLabel);
    if (statusIndex < 0) return `${title}${theme.fg("muted", afterTitle)}`;
    const beforeStatus = afterTitle.slice(0, statusIndex);
    const afterStatus = afterTitle.slice(statusIndex + audit.statusLabel.length);
    return `${title}${theme.fg("toolTitle", beforeStatus)}${theme.fg(audit.statusTone, audit.statusLabel)}${theme.fg("muted", afterStatus)}`;
  }

  const section = line.match(/^([├└]─ )([^ ]+)(  )(.*)$/);
  if (section) {
    const [, branch = "", label = "", gap = "  ", content = ""] = section;
    return `${theme.fg("dim", branch)}${theme.fg(sectionLabelTone(label), label)}${gap}${theme.fg("text", content)}`;
  }

  const continuation = line.match(/^(│       |        )(.*)$/);
  if (continuation) {
    const [, prefix = "", content = ""] = continuation;
    const nested = content.match(/^([^ ]+)(  )(.*)$/);
    if (nested && [i18n.t("summary"), i18n.t("finding"), i18n.t("rules")].includes(nested[1] ?? "")) {
      return `${theme.fg("dim", prefix)}${theme.fg(sectionLabelTone(nested[1] ?? ""), nested[1] ?? "")}${nested[2] ?? "  "}${theme.fg("text", nested[3] ?? "")}`;
    }
    return `${theme.fg("dim", prefix)}${theme.fg("text", content)}`;
  }
  return theme.fg("muted", line);
}

export function renderSupervisorAuditText(audit: SupervisorAuditView, theme: RenderTheme): string {
  return audit.lines.map((line, index) => renderSupervisorAuditLine(audit, line, index, theme)).join("\n");
}

function padLine(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function wrapSupervisorAuditLine(
  audit: SupervisorAuditView,
  line: string,
  index: number,
  theme: RenderTheme,
  width: number,
): string[] {
  const section = index > 0 ? line.match(/^([├└]─ )([^ ]+)(  )(.*)$/) : undefined;
  if (section) {
    const [, branch = "", label = "", gap = "  ", content = ""] = section;
    const renderedPrefix = `${theme.fg("dim", branch)}${theme.fg(sectionLabelTone(label), label)}${gap}`;
    const renderedContinuation = theme.fg("dim", branch.startsWith("├") ? "│       " : "        ");
    const contentWidth = Math.max(1, width - visibleWidth(renderedPrefix));
    const wrappedContent = wrapTextWithAnsi(theme.fg("text", content), contentWidth);
    return wrappedContent.map((part, partIndex) => padLine(
      `${partIndex === 0 ? renderedPrefix : renderedContinuation}${part}`,
      width,
    ));
  }

  const continuation = index > 0 ? line.match(/^(│       |        )(.*)$/) : undefined;
  if (continuation) {
    const [, prefix = "", content = ""] = continuation;
    const renderedPrefix = theme.fg("dim", prefix);
    const contentWidth = Math.max(1, width - visibleWidth(renderedPrefix));
    const wrappedContent = wrapTextWithAnsi(theme.fg("text", content), contentWidth);
    return wrappedContent.map((part) => padLine(`${renderedPrefix}${part}`, width));
  }

  return wrapTextWithAnsi(renderSupervisorAuditLine(audit, line, index, theme), Math.max(1, width))
    .map((part) => padLine(part, width));
}

class SupervisorAuditComponent implements Component {
  constructor(
    private readonly audit: SupervisorAuditView,
    private readonly theme: RenderTheme,
  ) {}

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    return [
      "",
      ...this.audit.lines.flatMap((line, index) =>
        wrapSupervisorAuditLine(this.audit, line, index, this.theme, renderWidth),
      ),
    ];
  }

  invalidate(): void {}
}

export function createSupervisorAuditComponent(audit: SupervisorAuditView, theme: RenderTheme): Component {
  return new SupervisorAuditComponent(audit, theme);
}

export function buildSupervisorAuditLines(
  toolName: string,
  audit: SupervisorAudit,
  expanded: boolean,
): SupervisorAuditView | undefined {
  if (!audit.status) return undefined;
  const reviewers = Array.isArray(audit.reviewers) ? audit.reviewers : [];
  const warnings = Array.isArray(audit.warnings)
    ? audit.warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
    : [];
  const overall = statusView(audit.status);
  const metrics = [
    toolName,
    i18n.t("reviewerCount", { count: reviewers.length }),
  ];
  const durationMs = getFiniteNumber(audit.durationMs);
  if (durationMs !== undefined) metrics.push(formatDuration(durationMs));
  const expandHint = expanded ? "" : i18n.t("expand");
  const lines = [
    i18n.t("header", { status: `${overall.label}  ${metrics.join(" · ")}${expandHint}` }),
  ];

  if (expanded) {
    const sections: Array<{ label: string; text: string; details?: string[] }> = [];
    if (getString(audit.filePath)) sections.push({ label: i18n.t("file"), text: getString(audit.filePath)! });
    for (const reviewer of reviewers) {
      const status = reviewerStatus(reviewer.status);
      const name = getString(reviewer.name) ?? i18n.t("reviewer");
      const duration = getFiniteNumber(reviewer.durationMs);
      const reviewerText = [status.label, name, duration === undefined ? undefined : formatDuration(duration)]
        .filter(Boolean)
        .join("  ");
      sections.push({ label: i18n.t("reviewer"), text: reviewerText, details: reviewerDetails(reviewer) });
    }
    if (warnings.length > 0) sections.push({ label: i18n.t("warning"), text: warnings.join("\n") });

    sections.forEach((section, index) => {
      appendSection(
        lines,
        index === sections.length - 1 ? "└─" : "├─",
        section.label,
        section.text,
        section.details,
      );
    });
  }

  return {
    lines,
    statusLabel: overall.label,
    statusTone: overall.tone === "success" && warnings.length > 0 ? "warning" : overall.tone,
  };
}

export function registerSupervisorFallbackRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<SupervisorAuditEntry>(
    SUPERVISOR_AUDIT_ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data) return undefined;
      const audit = buildSupervisorAuditLines(data.toolName, data.audit, expanded);
      if (!audit) return undefined;
      return createSupervisorAuditComponent(audit, theme);
    },
  );
}

export function appendSupervisorFallbackAudit(
  pi: Pick<ExtensionAPI, "appendEntry">,
  toolName: string,
  details: unknown,
): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const audit = (details as Record<string, unknown>).fileEditReview;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return false;
  const record = audit as SupervisorAudit;
  if (!record.status) return false;
  pi.appendEntry<SupervisorAuditEntry>(SUPERVISOR_AUDIT_ENTRY_TYPE, { toolName, audit: record });
  return true;
}
